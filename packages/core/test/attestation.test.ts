import { describe, expect, it } from "vitest";
import { attestationFromJson, encodeRoundHashInput, jsonify, roundHash, toAttestation, type RoundResult } from "../src/index.js";
import vectors from "../../../fixtures/vectors/round-hash.json";

describe("roundHash", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))("matches the vector %s", (_, c) => {
    const att = attestationFromJson(c.att);
    const d = { chainId: BigInt(c.chainId), rollupId: c.rollupId };
    expect(encodeRoundHashInput(att, d)).toBe(c.encoded);
    expect(roundHash(att, d)).toBe(c.roundHash);
  });

  it("binds the chain, the rollup and every field", () => {
    const att = attestationFromJson(vectors.cases[0]!.att);
    const d = { chainId: 9800n, rollupId: "sealed-scouts-1" };
    const h = roundHash(att, d);
    expect(roundHash(att, { ...d, chainId: 9801n })).not.toBe(h);
    expect(roundHash(att, { ...d, rollupId: "sealed-scouts-2" })).not.toBe(h);
    expect(roundHash({ ...att, medians: [att.medians[0]! + 1n, ...att.medians.slice(1)] }, d)).not.toBe(h);
    expect(roundHash({ ...att, reportCount: 4 }, d)).not.toBe(h);
  });

  it("rejects values that do not fit the Solidity types", () => {
    const att = attestationFromJson(vectors.cases[0]!.att);
    const d = { chainId: 9800n, rollupId: "sealed-scouts-1" };
    expect(() => roundHash({ ...att, counts: [256, 3, 3] }, d)).toThrow();
    expect(() => roundHash({ ...att, round: 1n << 64n }, d)).toThrow();
  });
});

describe("toAttestation", () => {
  it("copies the round result and batch facts field by field", () => {
    const r: RoundResult = {
      round: 5n, status: "ok", leaves: [{ round: 5n, scout: "0x0000000000000000000000000000000000000001", salt: new Uint8Array(16), feedIds: [1], prices: [2n], commitSigHash: `0x${"11".repeat(32)}` }],
      medians: [{ feedId: 1, price: 10n, count: 3 }, { feedId: 3, price: 30n, count: 4 }], reportsRoot: `0x${"ab".repeat(32)}`,
      outliers: [], inBand: [], rejected: [], skippedByOpener: [], openHeight: 2500n, closeHeight: 2680n,
    };
    const att = toAttestation(r, { index: 9n, inboxStart: 100n, inboxEnd: 120n, closeTime: 1_764_000_000n });
    expect(jsonify(att)).toEqual({
      round: "5", batchIndex: "9", inboxStart: "100", inboxEnd: "120", closeHeight: "2680", closeTime: "1764000000",
      feedIds: [1, 3], medians: ["10", "30"], counts: [3, 4], reportsRoot: `0x${"ab".repeat(32)}`, reportCount: 1,
    });
  });
});
