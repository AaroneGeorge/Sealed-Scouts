import { describe, expect, it } from "vitest";
import { mldsa87 } from "@qorechain/pqc";
import { generateSealKeys } from "@qorechain/qoreseal";
import { QledgerLedger, bytesToHex, encodeQledgerDeposit, executeQledger, qledgerKeypairFromSeed } from "@qorechain/rdk";
import { accountFromMnemonic } from "@sealed-scouts/chain";
import { anchorSignBytes, deriveRound, roundWindows, type RoundResult } from "@sealed-scouts/core";
import { anchorSignature } from "../src/anchor.js";
import { replayLedger } from "../src/ledger.js";
import { buildOpenings, openPayload } from "../src/opener.js";
import { addInBand, joinsFrom, rewardLines } from "../src/rewards.js";
import { CHAIN_ID, Inbox, OPERATOR, ROLLUP, TEST_MNEMONIC, openerKeys, params, report, scouts, timing } from "./helpers.js";

const ctx = { chainId: CHAIN_ID, rollupId: ROLLUP, timing, keys: openerKeys };
const P = (eth: number, btc: number) => [BigInt(eth) * 100_000_000n, BigInt(btc) * 100_000_000n];

describe("opener", () => {
  it("opens every sealed report and the round derives with the OPEN", () => {
    const inbox = new Inbox();
    report(inbox, 0n, scouts[0]!, P(1800, 64000));
    report(inbox, 0n, scouts[1]!, P(1801, 64010));
    report(inbox, 0n, scouts[2]!, P(1799, 63990));
    const { openings, unopened } = buildOpenings(inbox.entries, 0n, ctx);
    expect(openings).toHaveLength(3);
    expect(unopened).toEqual([]);

    inbox.post(roundWindows(0n, timing).commitEnd + 1n, OPERATOR, openPayload(0n, openings));
    const eligible = new Set(scouts.map((s) => s.qor));
    const r = deriveRound(inbox.entries, 0n, params(), (q) => eligible.has(q));
    expect(r.status).toBe("ok");
    expect(r.leaves).toHaveLength(3);
    expect(r.skippedByOpener).toEqual([]);
    expect(r.medians.map((m) => m.price)).toEqual(P(1800, 64000));
  });

  it("leaves out what it cannot stand behind: wrong key, mismatched commit, wrong round, late posts", () => {
    const inbox = new Inbox();
    const w = roundWindows(0n, timing);
    report(inbox, 0n, scouts[0]!, P(1800, 64000), { sealTo: generateSealKeys() });
    report(inbox, 0n, scouts[1]!, P(1800, 64000), { commitPrices: P(1900, 64000) });
    report(inbox, 1n, scouts[2]!, P(1800, 64000), { height: w.start + 5n });
    report(inbox, 0n, scouts[3]!, P(1800, 64000), { height: w.commitEnd });
    const { openings, unopened } = buildOpenings(inbox.entries, 0n, ctx);
    expect(openings).toEqual([]);
    expect(unopened).toEqual([
      { poster: scouts[0]!.qor, reason: "cannot decrypt" },
      { poster: scouts[1]!.qor, reason: "opening-mismatch" },
    ]);
  });

  it("an empty OPEN still encodes", () => {
    expect(openPayload(5n, []).length).toBeGreaterThan(5);
  });
});

describe("anchor signature", () => {
  it("signs the bytes core rebuilds (and PriceFeed rebuilds), with the round hash in the vsh slot", async () => {
    const op = await accountFromMnemonic("CUSTOM", TEST_MNEMONIC);
    const fields = { chainId: CHAIN_ID, layerId: ROLLUP, batchIndex: 7n, stateRoot: new Uint8Array(32).fill(1), txCount: 4n, validatorSetHash: new Uint8Array(32).fill(0xab) };
    const sig = anchorSignature(op, fields);
    const bytes = anchorSignBytes(fields);
    expect(mldsa87.verify(op.keys.pqc.publicKey, bytes, sig)).toBe(true);
    expect(mldsa87.verify(op.keys.pqc.publicKey, anchorSignBytes({ ...fields, validatorSetHash: new Uint8Array(32) }), sig)).toBe(false);
  });
});

describe("rewards", () => {
  const leaf = (scout: string) => ({ scout }) as RoundResult["inBand"][number];
  const result = (...s: string[]) => ({ inBand: s.map(leaf) }) as RoundResult;

  it("pays per in-band report to the account in the scout's latest JOIN", () => {
    const inbox = new Inbox();
    const a1 = new Uint8Array(32).fill(1), a2 = new Uint8Array(32).fill(2), a3 = new Uint8Array(32).fill(3);
    inbox.post(1n, scouts[0]!.qor, new Uint8Array([0x53, 0x53, 0x43, 0x31, 0x01, ...a1]));
    inbox.post(2n, scouts[0]!.qor, new Uint8Array([0x53, 0x53, 0x43, 0x31, 0x01, ...a2]));
    inbox.post(3n, scouts[1]!.qor, new Uint8Array([0x53, 0x53, 0x43, 0x31, 0x01, ...a3]));
    const joins = joinsFrom(inbox.entries);
    // scout0 in band twice (address case must not matter), scout1 once, scout2 once but never joined.
    let tally = addInBand({}, result(scouts[0]!.address, scouts[1]!.address));
    tally = addInBand(tally, result(scouts[0]!.address.toUpperCase().replace("0X", "0x"), scouts[2]!.address));
    const byScout = Object.fromEntries(rewardLines(tally, joins, 100n).map((l) => [l.scout, [l.reports, l.amount, l.account[0]]]));
    expect(byScout).toEqual({ [scouts[0]!.qor]: [2, 200n, 2], [scouts[1]!.qor]: [1, 100n, 3] });
  });
});

describe("ledger replay", () => {
  const env = { chainId: CHAIN_ID, rollupId: ROLLUP };
  const acct = qledgerKeypairFromSeed(new Uint8Array(32).fill(9));
  const entries = [1n, 2n, 3n, 4n].map((seq) => ({ seq, height: 100n + seq, poster: `deposit:qor1x`, payload: encodeQledgerDeposit(acct.accountId, seq * 1_000_000n) }));
  const rootAfter = (n: number) => {
    const l = new QledgerLedger();
    executeQledger(env, l, entries.slice(0, n));
    return bytesToHex(l.root());
  };
  const inbox = { read: async (_r: string, from: bigint, to: bigint) => entries.filter((e) => e.seq >= from && e.seq <= to) };

  it("re-executes every batch and reproduces the chain's roots", async () => {
    const rest = { listBatches: async () => [
      { batchIndex: 1, status: "submitted", inboxStart: 2, inboxEnd: 4, stateRoot: rootAfter(4) },
      { batchIndex: 0, status: "finalized", inboxStart: 0, inboxEnd: 2, stateRoot: rootAfter(2) },
    ] };
    const r = await replayLedger(env, rest as never, inbox as never);
    expect(bytesToHex(r.ledger.root())).toBe(rootAfter(4));
    expect(r.batches.map((b) => b.batchIndex)).toEqual([0, 1]);
  });

  it("skips a rejected batch and fails loudly on a root it cannot reproduce", async () => {
    const ok = { listBatches: async () => [
      { batchIndex: 0, status: "rejected", inboxStart: 0, inboxEnd: 2, stateRoot: "ff".repeat(32) },
      { batchIndex: 1, status: "submitted", inboxStart: 0, inboxEnd: 3, stateRoot: rootAfter(3) },
    ] };
    expect(bytesToHex((await replayLedger(env, ok as never, inbox as never)).ledger.root())).toBe(rootAfter(3));
    const bad = { listBatches: async () => [{ batchIndex: 0, status: "submitted", inboxStart: 0, inboxEnd: 2, stateRoot: "ab".repeat(32) }] };
    await expect(replayLedger(env, bad as never, inbox as never)).rejects.toThrow(/replay of batch 0/);
  });
});
