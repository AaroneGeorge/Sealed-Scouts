import { describe, expect, it } from "vitest";
import { open } from "@qorechain/qoreseal";
import { QLEDGER_MAX_POST_BYTES } from "@qorechain/rdk";
import {
  DEFAULT_RULES, commitment, decodeMsg, decodeReportPlaintext, deriveRound, encodeMsg, reportAad, reportPurpose, roundWindows, scoutAddress,
  verifyCommit, type InboxEntry, type RoundParams,
} from "@sealed-scouts/core";
import { buildReveal, buildSealedReport, sortedPriceSet } from "../src/report.js";
import { CHAIN_ID, ROLLUP_ID, testOpener, testScout } from "./helpers.js";

const prices = { feedIds: [3, 1, 2], prices: [99_950_000n, 175_381_000_000n, 6_269_800_000_000n] };

describe("buildSealedReport", () => {
  const scout = testScout();
  const opener = testOpener();
  const r = buildSealedReport({ chainId: CHAIN_ID, rollupId: ROLLUP_ID, round: 42n, scout, openerKemKey: opener.mlkemPublicKey, prices });

  it("fits both posts in the rollup's post limit", () => {
    expect(r.report.length).toBeLessThanOrEqual(QLEDGER_MAX_POST_BYTES);
    expect(r.commit.length).toBeLessThanOrEqual(QLEDGER_MAX_POST_BYTES);
    expect(r.commit.length).toBe(4 + 1 + 8 + 32 + 4627);
  });

  it("seals prices the opener (and only with the right round and scout) can read", () => {
    const m = decodeMsg(r.report);
    expect(m?.kind).toBe("REPORT");
    if (m?.kind !== "REPORT") return;
    const args = { chainId: CHAIN_ID, purpose: reportPurpose(ROLLUP_ID), envelope: m.envelope, keys: opener };
    const plain = decodeReportPlaintext(open({ ...args, aad: reportAad(42n, scout.address) }))!;
    expect(plain.feedIds).toEqual([1, 2, 3]);
    expect(plain.prices).toEqual([175_381_000_000n, 6_269_800_000_000n, 99_950_000n]);
    expect(plain.salt).toEqual(r.salt);
    expect(() => open({ ...args, aad: reportAad(43n, scout.address) })).toThrow();
    expect(() => open({ ...args, keys: testOpener(), aad: reportAad(42n, scout.address) })).toThrow();
  });

  it("commits to the same prices and signs the commitment with the scout's ML-DSA-87 key", () => {
    const m = decodeMsg(r.commit);
    if (m?.kind !== "COMMIT") throw new Error("not a COMMIT");
    expect(m.commitment).toEqual(commitment(42n, scoutAddress(scout.address)!, r.salt, sortedPriceSet(prices)));
    const ctx = { chainId: CHAIN_ID, rollupId: ROLLUP_ID, round: 42n, scout: scout.address, commitment: m.commitment };
    expect(verifyCommit(scout.keys.pqc.publicKey, ctx, m.signature)).toBe(true);
    expect(verifyCommit(testScout().keys.pqc.publicKey, ctx, m.signature)).toBe(false);
  });

  it("uses a fresh salt each time, so equal prices give different commitments", () => {
    const again = buildSealedReport({ chainId: CHAIN_ID, rollupId: ROLLUP_ID, round: 42n, scout, openerKemKey: opener.mlkemPublicKey, prices });
    expect(again.salt).not.toEqual(r.salt);
    expect(again.commitment).not.toEqual(r.commitment);
  });

  it("refuses an empty report and a bad address", () => {
    const base = { chainId: CHAIN_ID, rollupId: ROLLUP_ID, round: 1n, openerKemKey: opener.mlkemPublicKey };
    expect(() => buildSealedReport({ ...base, scout, prices: { feedIds: [], prices: [] } })).toThrow();
    expect(() => buildSealedReport({ ...base, scout: { ...scout, address: "0xabc" }, prices })).toThrow(/qor1/);
  });
});

describe("posts from three scouts derive the round in core", () => {
  const timing = { genesisHeight: 1000n, roundBlocks: 300n, commitBlocks: 180n, openBlocks: 40n, revealBlocks: 40n };
  const opener = testOpener();
  const scouts = [testScout(), testScout(), testScout()];
  const operator = testScout().address;
  const ethPrices = [175_000_000_000n, 175_100_000_000n, 175_300_000_000n];
  const sealed = scouts.map((s, i) =>
    buildSealedReport({ chainId: CHAIN_ID, rollupId: ROLLUP_ID, round: 0n, scout: s, openerKemKey: opener.mlkemPublicKey, prices: { feedIds: [1], prices: [ethPrices[i]!] } }),
  );
  const params: RoundParams = {
    ...timing, ...DEFAULT_RULES, chainId: CHAIN_ID, rollupId: ROLLUP_ID, operator,
    pqKeyOf: (a) => scouts.find((s) => s.address === a)?.keys.pqc.publicKey,
  };
  const w = roundWindows(0n, timing);
  let seq = 0n;
  const entry = (poster: string, payload: Uint8Array, height: bigint): InboxEntry => ({ seq: ++seq, height, poster, payload });
  const posts = sealed.flatMap((r, i) => [entry(scouts[i]!.address, r.report, w.start + 5n), entry(scouts[i]!.address, r.commit, w.start + 5n)]);

  it("counts every report the operator opens and takes the median", () => {
    const openMsg = encodeMsg({ kind: "OPEN", round: 0n, openings: sealed.map((r) => ({ scout: r.scout20, salt: r.salt, ...r.prices })) });
    const result = deriveRound([...posts, entry(operator, openMsg, w.commitEnd + 1n)], 0n, params, () => true);
    expect(result.status).toBe("ok");
    expect(result.leaves).toHaveLength(3);
    expect(result.medians).toEqual([{ feedId: 1, price: 175_100_000_000n, count: 3 }]);
    expect(result.leaves.map((l) => l.commitSigHash).sort()).toEqual(sealed.map((r) => r.commitSigHash).sort());
  });

  it("a skipped scout's own REVEAL still counts", () => {
    const openMsg = encodeMsg({ kind: "OPEN", round: 0n, openings: sealed.slice(1).map((r) => ({ scout: r.scout20, salt: r.salt, ...r.prices })) });
    const reveal = entry(scouts[0]!.address, buildReveal(sealed[0]!), w.openEnd + 1n);
    const result = deriveRound([...posts, entry(operator, openMsg, w.commitEnd + 1n), reveal], 0n, params, () => true);
    expect(result.leaves).toHaveLength(3);
    expect(result.skippedByOpener).toEqual([scouts[0]!.address]);
  });
});
