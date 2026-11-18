import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountFromMnemonic, type Account } from "../src/accounts.js";
import { defaultConfig } from "../src/config.js";
import { NativeLane, SimulationError, expectedSequence, postedSequences, sealKeys } from "../src/native.js";
import { bank } from "@qorechain/sdk";
import { MockRest, TEST_MNEMONIC } from "./mock-rest.js";

let account: Account;
let mock: MockRest;
let lane: NativeLane;

beforeAll(async () => {
  account = await accountFromMnemonic("CUSTOM", TEST_MNEMONIC);
});
beforeEach(() => {
  mock = new MockRest();
  mock.sequences.set(account.address, 4n);
  const config = { ...defaultConfig({}), signBytesVersion: "v2" as const, rollupId: "test-rollup" };
  lane = new NativeLane({ config, fetch: mock.fetch, sleep: async () => {}, pollMs: 1 });
});

const sendMsg = () => bank.send({ fromAddress: account.address, toAddress: account.address, amount: [{ denom: "uqor", amount: "1" }] });

describe("NativeLane.send", () => {
  it("simulates, then signs hybrid with exact gas and a fee at the gas price", async () => {
    const r = await lane.send(account, [sendMsg()]);
    expect(r.code).toBe(0);
    expect(r.height).toBe(1000n);
    expect(mock.simulations).toBe(1);
    const tx = mock.broadcasts[0]!;
    expect(tx.hybrid).toBe(true);
    expect(tx.gas).toBe(104_000n); // ceil(100000 * 1.02) + 2000
    expect(tx.feeUqor).toBe(15_600n); // 104000 * 0.15
  });

  it("keeps a local sequence and serialises concurrent sends per account", async () => {
    const rs = await Promise.all([lane.send(account, [sendMsg()]), lane.send(account, [sendMsg()]), lane.send(account, [sendMsg()])]);
    expect(rs.every((r) => r.code === 0)).toBe(true);
    expect(mock.broadcasts.map((b) => b.sequence)).toEqual([4n, 5n, 6n]);
  });

  it("re-signs with the chain's sequence after a sequence mismatch", async () => {
    await lane.send(account, [sendMsg()]);
    mock.bumpSequenceOnce = account.address; // someone else used sequence 5
    const r = await lane.send(account, [sendMsg()]);
    expect(r.code).toBe(0);
    expect(mock.broadcasts.map((b) => [b.sequence, b.hash.length > 0])).toEqual([
      [4n, true],
      [5n, true],
      [6n, true],
    ]);
  });

  it("returns a chain refusal as a code; sendOrThrow throws it", async () => {
    const r = await lane.send(account, [sendMsg()], { mode: "classical", gas: 200_000 });
    expect(r.code).toBe(13);
    expect(r.codespace).toBe("pqc");
    expect(mock.broadcasts[0]!.hybrid).toBe(false);
    await expect(lane.sendOrThrow(account, [sendMsg()], { mode: "classical", gas: 200_000 })).rejects.toThrow(/refused: code 13/);
  });

  it("sends nothing when the simulation is refused", async () => {
    mock.simulateError = "insufficient funds";
    await expect(lane.send(account, [sendMsg()])).rejects.toBeInstanceOf(SimulationError);
    expect(mock.broadcasts).toHaveLength(0);
  });

  it("explains an unfunded account", async () => {
    mock.sequences.clear();
    await expect(lane.send(account, [sendMsg()])).rejects.toThrow(/fund it first/);
  });
});

describe("NativeLane.postToInbox", () => {
  it("posts n payloads in one tx and returns their inbox sequences", async () => {
    const r = await lane.postToInbox(account, [new Uint8Array([0x53, 1]), new Uint8Array([0x53, 2])]);
    expect(mock.broadcasts).toHaveLength(1);
    expect(mock.broadcasts[0]!.typeUrls).toEqual(["/qorechain.rdk.v1.MsgPostRollupData", "/qorechain.rdk.v1.MsgPostRollupData"]);
    expect(r.sequences).toEqual([1n, 2n]);
  });

  it("refuses empty or oversized payloads before signing", async () => {
    await expect(lane.postToInbox(account, [new Uint8Array(6145)])).rejects.toThrow(/outside 1\.\.6144/);
    await expect(lane.postToInbox(account, [])).rejects.toThrow(/at least one/);
    expect(mock.broadcasts).toHaveLength(0);
  });
});

describe("NativeLane.registerKemKey", () => {
  it("publishes the QoreSeal ML-KEM key once, and skips when the chain already holds it", async () => {
    const r = await lane.registerKemKey(account);
    expect(r).not.toBe("already-registered");
    expect(mock.broadcasts[0]!.typeUrls).toEqual(["/qorechain.pqc.v1.MsgRegisterKEMKey"]);
    mock.kemKeys.set(account.address, Buffer.from(sealKeys(account).mlkemPublicKey).toString("hex"));
    expect(await lane.kemKey(account.address)).toBe(Buffer.from(sealKeys(account).mlkemPublicKey).toString("hex"));
    expect(await lane.registerKemKey(account)).toBe("already-registered");
    expect(mock.broadcasts).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parses the expected sequence from the chain's log", () => {
    expect(expectedSequence("account sequence mismatch, expected 12, got 9: incorrect account sequence")).toBe(12n);
    expect(expectedSequence("out of gas")).toBeUndefined();
  });
  it("reads posted sequences for one rollup only", () => {
    const ev = (r: string, s: string) => ({ type: "rdk_data_posted", attributes: [{ key: "rollup_id", value: r }, { key: "sequence", value: s }] });
    expect(postedSequences([ev("a", "3"), ev("b", "9"), ev("a", "4")], "a")).toEqual([3n, 4n]);
  });
});
