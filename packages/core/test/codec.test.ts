import { encodeQledgerDeposit, encodeQledgerTx, qledgerKeypairFromSeed, signQledgerTx } from "@qorechain/rdk";
import { describe, expect, it } from "vitest";
import {
  MAGIC, concatBytes, decodeMsg, decodeReportPlaintext, encodeMsg, encodeReportPlaintext, reportAad, reportPurpose, type Msg,
} from "../src/index.js";

const salt = new Uint8Array(16).fill(0xab);
const scout = "0x00112233445566778899aabbccddeeff00112233" as const;
const max128 = (1n << 128n) - 1n;
const samples: Msg[] = [
  { kind: "JOIN", account: new Uint8Array(32).fill(1) },
  { kind: "REPORT", round: 7n, envelope: new Uint8Array(1850).fill(2) },
  { kind: "COMMIT", round: (1n << 64n) - 1n, commitment: new Uint8Array(32).fill(3), signature: new Uint8Array(4627).fill(4) },
  { kind: "OPEN", round: 9n, openings: [] },
  {
    kind: "OPEN", round: 9n,
    openings: [
      { scout, salt, feedIds: [1, 2, 3], prices: [1n, 2n, max128] },
      { scout: "0xffffffffffffffffffffffffffffffffffffffff", salt, feedIds: [], prices: [] },
    ],
  },
  { kind: "REVEAL", round: 0n, salt, feedIds: [65535], prices: [0n] },
];

describe("codec", () => {
  it.each(samples.map((m) => [m.kind, m] as const))("round-trips %s", (_, m) => {
    const bytes = encodeMsg(m);
    expect([...bytes.subarray(0, 4)]).toEqual([...MAGIC]);
    expect(decodeMsg(bytes)).toEqual(m);
  });

  it("has the exact sizes from the spec", () => {
    expect(encodeMsg(samples[0]!).length).toBe(5 + 32);
    expect(encodeMsg(samples[2]!).length).toBe(5 + 8 + 32 + 4627);
    expect(encodeMsg(samples[4]!).length).toBe(5 + 8 + 1 + (20 + 16 + 1 + 3 * 18) + (20 + 16 + 1));
    expect(encodeMsg(samples[5]!).length).toBe(5 + 8 + 16 + 1 + 18);
  });

  it("rejects every truncated or extended message", () => {
    for (const m of samples) {
      const b = encodeMsg(m);
      // REPORT's envelope runs to the end, so only cutting into the header breaks it.
      const cuts = m.kind === "REPORT" ? [b.length - 1850] : [b.length - 1, 6];
      for (const n of cuts) expect(decodeMsg(b.subarray(0, n))).toBeUndefined();
      if (m.kind !== "REPORT") expect(decodeMsg(concatBytes(b, new Uint8Array([0])))).toBeUndefined();
    }
  });

  it("returns undefined for foreign payloads", () => {
    const a = qledgerKeypairFromSeed(new Uint8Array(32).fill(9));
    const tx = signQledgerTx({ chainId: "qorechain-diana", rollupId: "sealed-scouts-1", secretKey: a.secretKey, publicKey: a.publicKey, nonce: 0, amount: 5n, to: a.accountId });
    expect(decodeMsg(encodeQledgerTx(tx))).toBeUndefined();
    expect(decodeMsg(encodeQledgerDeposit(a.accountId, 1n))).toBeUndefined();
    expect(decodeMsg(new Uint8Array())).toBeUndefined();
    expect(decodeMsg(MAGIC)).toBeUndefined();
    expect(decodeMsg(new TextEncoder().encode("SSC2\x01" + "x".repeat(32)))).toBeUndefined();
    expect(decodeMsg(concatBytes(MAGIC, new Uint8Array([0x06]), new Uint8Array(32)))).toBeUndefined();
    expect(decodeMsg(concatBytes(MAGIC, new Uint8Array([0x00])))).toBeUndefined();
  });

  it("refuses to encode fields of the wrong size", () => {
    expect(() => encodeMsg({ kind: "JOIN", account: new Uint8Array(31) })).toThrow();
    expect(() => encodeMsg({ kind: "REPORT", round: 1n, envelope: new Uint8Array() })).toThrow();
    expect(() => encodeMsg({ kind: "COMMIT", round: 1n, commitment: new Uint8Array(32), signature: new Uint8Array(4626) })).toThrow();
    expect(() => encodeMsg({ kind: "COMMIT", round: 1n << 64n, commitment: new Uint8Array(32), signature: new Uint8Array(4627) })).toThrow();
    expect(() => encodeMsg({ kind: "REVEAL", round: 1n, salt: new Uint8Array(15), feedIds: [], prices: [] })).toThrow();
    expect(() => encodeMsg({ kind: "REVEAL", round: 1n, salt, feedIds: [1], prices: [] })).toThrow();
    expect(() => encodeMsg({ kind: "REVEAL", round: 1n, salt, feedIds: [1], prices: [max128 + 1n] })).toThrow();
    expect(() => encodeMsg({ kind: "REVEAL", round: 1n, salt, feedIds: [1], prices: [-1n] })).toThrow();
    expect(() => encodeMsg({ kind: "OPEN", round: 1n, openings: [{ scout: "0x1234", salt, feedIds: [], prices: [] }] })).toThrow();
  });

  it("round-trips the sealed report plaintext and builds seal context strings", () => {
    const p = { salt, feedIds: [1, 2], prices: [5n, 6n] };
    expect(decodeReportPlaintext(encodeReportPlaintext(p))).toEqual(p);
    expect(decodeReportPlaintext(encodeReportPlaintext(p).subarray(1))).toBeUndefined();
    expect(reportPurpose("sealed-scouts-1")).toBe("sealed-scouts/report/v1:sealed-scouts-1");
    expect(new TextDecoder().decode(reportAad(12n, "qor1abc"))).toBe("12|qor1abc");
  });
});
