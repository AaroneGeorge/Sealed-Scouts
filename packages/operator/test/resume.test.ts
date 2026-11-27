// Settlement stages resume safely: relays are retried in order and never repeated, rewards never paid twice
// and never lost. The operator runs against fakes; only the stage methods under test are called.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { QledgerLedger, encodeQledgerDeposit, encodeQledgerTx, executeQledger, signQledgerTx } from "@qorechain/rdk";
import { accountFromMnemonic, type Account } from "@sealed-scouts/chain";
import { ledgerKeyOf } from "@sealed-scouts/scout";
import { defaultDemo, defaultParams, type DeploymentFile } from "../src/deployment.js";
import { Operator } from "../src/operator.js";
import { StateStore } from "../src/state.js";
import { openerKeys, scouts, TEST_MNEMONIC } from "./helpers.js";

const FEED = "0x00000000000000000000000000000000000000fe";
let op: Account;
beforeAll(async () => {
  op = await accountFromMnemonic("CUSTOM", TEST_MNEMONIC);
});

function deployment(): DeploymentFile {
  return {
    chainId: "qorechain-diana", evmChainId: 9800, rollupId: "test-rollup", operator: op.address, operatorEvm: op.evm,
    genesisHeight: "1000", createdHeight: "900", params: { ...defaultParams(), rewardPerReportUqor: "100" }, demo: defaultDemo(),
    scouts: scouts.map((s) => s.qor), contracts: { PriceFeed: FEED }, txs: {},
  };
}

/** Fake chain: PriceFeed's `rounds`/`cursor` answers come from `feed`; posts are counted. */
function harness(feed: { posted: Set<bigint>; lastRound?: bigint }) {
  const posts: Uint8Array[][] = [];
  let failPosts = 0;
  const chain = {
    config: { rest: "http://rest.invalid", chainId: "qorechain-diana" },
    fetch: async () => { throw new Error("no network in this test"); },
    native: {
      resync: () => {},
      postToInbox: async (_a: Account, payloads: Uint8Array[]) => {
        if (failPosts-- > 0) throw new Error("broadcast failed");
        posts.push(payloads);
        return { txHash: "TX", sequences: [] };
      },
    },
    evm: {
      publicClient: {
        readContract: async (p: { functionName: string; args?: [bigint] }) =>
          p.functionName === "rounds"
            ? [`0x${"00".repeat(32)}`, feed.posted.has(p.args![0]) ? 1n : 0n, 0n, 0n, 0, false]
            : [feed.lastRound ?? 0n, 0n, feed.lastRound !== undefined],
      },
    },
  };
  const store = new StateStore(mkdtempSync(join(tmpdir(), "ss-op-")));
  const operator = new Operator({ chain: chain as never, deployment: deployment(), operator: op, relayer: op, sealKeys: openerKeys, store, log: () => {} });
  return { operator: operator as any, store, posts, failNextPosts: (n: number) => (failPosts = n) };
}

const record = (round: bigint) => ({
  round, relayed: { status: "pending", attempts: 0 }, feedSignature: "0x01", batch: { stateRoot: `0x${"00".repeat(32)}`, txCount: "1" },
  attestation: { round, batchIndex: round, inboxStart: 0, inboxEnd: 1, closeHeight: 1, closeTime: 1, feedIds: [1], medians: ["1"], counts: [3], reportsRoot: `0x${"00".repeat(32)}`, reportCount: 3 },
});

describe("relay retries", () => {
  it("skips a round PriceFeed already holds or has passed, and stops at a failure to keep rounds in order", async () => {
    const h = harness({ posted: new Set([5n]), lastRound: 6n });
    for (const r of [5n, 6n, 7n, 8n]) h.store.saveRound(r, record(r));
    h.operator.state.pendingRelays = ["5", "6", "7", "8"];
    const tried: bigint[] = [];
    h.operator.relay = { postRound: async (att: { round: bigint }) => { tried.push(att.round); throw new Error("gate refused"); } };

    await h.operator.relayPending();
    expect(h.store.loadRound(5n).relayed.status).toBe("posted"); // already on PriceFeed: not sent again
    expect(h.store.loadRound(6n).relayed).toEqual({ status: "skipped", reason: "a later round is already on PriceFeed" });
    expect(h.store.loadRound(7n).relayed).toMatchObject({ status: "pending", attempts: 1, error: "gate refused" });
    expect(tried).toEqual([7n]); // round 8 waits behind 7
    expect(h.operator.state.pendingRelays).toEqual(["7", "8"]);

    await h.operator.relayPending();
    await h.operator.relayPending();
    expect(h.store.loadRound(7n).relayed).toMatchObject({ status: "failed", attempts: 3 });
    expect(h.operator.state.pendingRelays).toEqual(["8"]);
  });
});

describe("reward epochs", () => {
  function funded(h: ReturnType<typeof harness>) {
    const key = ledgerKeyOf(op.keys.pqc.secretKey);
    const ledger = new QledgerLedger();
    executeQledger({ chainId: "qorechain-diana", rollupId: "test-rollup" }, ledger, [{ height: 1, poster: `deposit:${op.address}`, payload: encodeQledgerDeposit(key.accountId, 10_000n) }]);
    h.operator.ledger = ledger;
    h.operator.joins.set(scouts[0]!.qor, new Uint8Array(32).fill(1));
    h.operator.state.tally = { [scouts[0]!.address.toLowerCase()]: 2 };
    h.operator.state.rewardDue = "5";
    return key;
  }

  it("keeps the tally when the post fails, pays once on retry, then clears it", async () => {
    const h = harness({ posted: new Set() });
    funded(h);
    h.failNextPosts(1);
    await expect(h.operator.payRewards()).rejects.toThrow(/broadcast failed/);
    expect(h.operator.state.tally).not.toEqual({});
    expect(h.operator.state.rewardPosting).toEqual({ round: "5", nonce: "0" });

    await h.operator.payRewards();
    expect(h.posts).toHaveLength(1);
    expect(h.operator.state).toMatchObject({ tally: {}, rewardDue: undefined, rewardPosting: undefined });
  });

  it("does not pay twice when an earlier post landed but was not recorded", async () => {
    const h = harness({ posted: new Set() });
    const key = funded(h);
    h.operator.state.rewardPosting = { round: "5", nonce: "0" };
    // The earlier transfer (nonce 0) is already in the inbox, after the last batch.
    const tx = signQledgerTx({ chainId: "qorechain-diana", rollupId: "test-rollup", secretKey: key.secretKey, publicKey: key.publicKey, nonce: 0, amount: 200, to: new Uint8Array(32).fill(1) });
    h.operator.entries = [{ seq: 9n, height: 50n, poster: op.address, payload: encodeQledgerTx(tx) }];
    await h.operator.payRewards();
    expect(h.posts).toHaveLength(0);
    expect(h.operator.state.tally).toEqual({});
  });
});

describe("back from a stop", () => {
  // A height in the commit window of round `r`: nothing to open yet, so openRounds posts nothing.
  const inCommit = (o: { params: { genesisHeight: bigint; roundBlocks: bigint } }, r: bigint) => o.params.genesisHeight + r * o.params.roundBlocks + 1n;

  it("skips the rounds that passed while it was stopped instead of settling them one by one", async () => {
    const h = harness({ posted: new Set() });
    h.operator.state.lastOpened = "10";
    h.operator.state.lastSettled = "10";
    await h.operator.openRounds(inCommit(h.operator, 500n));
    expect(h.operator.state.lastOpened).toBe("499");
    expect(h.operator.state.lastSettled).toBe("499");
    expect(h.posts).toHaveLength(0);
    expect(h.store.load().lastSettled).toBe("499");
  });

  it("settles rounds it had already opened before jumping", async () => {
    const h = harness({ posted: new Set() });
    h.operator.state.lastOpened = "10";
    h.operator.state.lastSettled = "8";
    await h.operator.openRounds(inCommit(h.operator, 500n));
    expect(h.operator.state.lastOpened).toBe("10");
    expect(h.operator.state.lastSettled).toBe("8");
  });

  it("walks a short gap round by round as before", async () => {
    const h = harness({ posted: new Set() });
    h.operator.state.lastOpened = "498";
    h.operator.state.lastSettled = "498";
    await h.operator.openRounds(inCommit(h.operator, 500n));
    // Round 499's open window has passed, so it is marked opened (missed), but nothing is skipped: it still settles.
    expect(h.operator.state.lastOpened).toBe("499");
    expect(h.operator.state.lastSettled).toBe("498");
  });
});

describe("after settling stalled", () => {
  // Settling failed for many rounds while OPENs kept going (the live run: settled 3078, opened 4064, now ~5300).
  const inCommit = (o: { params: { genesisHeight: bigint; roundBlocks: bigint } }, r: bigint) => o.params.genesisHeight + r * o.params.roundBlocks + 1n;

  function stalled(lastSettled: string, lastOpened: string) {
    const h = harness({ posted: new Set() });
    h.operator.state.lastSettled = lastSettled;
    h.operator.state.lastOpened = lastOpened;
    const settled: bigint[] = [];
    h.operator.refreshEntries = async () => {};
    h.operator.settle = async (round: bigint) => {
      settled.push(round);
      h.operator.state.lastSettled = String(round);
    };
    return { h, settled };
  }

  it("skips the opened rounds too old to matter, then opening resumes at the current round", async () => {
    const { h, settled } = stalled("3078", "4064");
    await h.operator.settleRounds(inCommit(h.operator, 5300n));
    expect(settled).toEqual([]);
    expect(h.store.load().lastSettled).toBe("4064");
    await h.operator.openRounds(inCommit(h.operator, 5300n));
    expect(h.operator.state).toMatchObject({ lastOpened: "5299", lastSettled: "5299" });
  });

  it("still settles the recent opened rounds one by one", async () => {
    const { h, settled } = stalled("480", "499");
    await h.operator.settleRounds(inCommit(h.operator, 500n));
    expect(settled).toEqual([490n, 491n, 492n, 493n, 494n, 495n, 496n, 497n, 498n, 499n]);
  });

  it("leaves a short lag alone", async () => {
    const { h, settled } = stalled("495", "499");
    await h.operator.settleRounds(inCommit(h.operator, 500n));
    expect(settled).toEqual([496n, 497n, 498n, 499n]);
  });
});
