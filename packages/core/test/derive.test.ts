import { describe, expect, it } from "vitest";
import {
  REJECT, deriveRound, jsonify, leafHash, reportsRoot, roundHash, toAttestation, verifyMerkleProof, merkleProof,
  type InboxEntry, type RoundParams,
} from "../src/index.js";
import { Scenario, fixtureParams, px } from "../scripts/scenario.js";
import { testKey } from "../scripts/test-keys.js";

const scouts = [1, 2, 3, 4].map((i) => testKey(`scout${i}`));
const keys = new Map(scouts.map((k) => [k.qor, k.publicKey]));
const all = () => true;
const derive = (s: Scenario, eligible: (q: string, r: bigint) => boolean = all, params: RoundParams = s.params) =>
  deriveRound(s.entries, s.round, params, eligible);

function threeHonest(s: Scenario) {
  return scouts.slice(0, 3).map((k, i) => s.scout(k, px(3120 + i, 97000 + i, 1)));
}

describe("deriveRound", () => {
  it("gives identical output for any input order", () => {
    const s = new Scenario(fixtureParams(keys));
    s.open(threeHonest(s));
    const want = JSON.stringify(jsonify(derive(s)));
    for (let i = 0; i < 5; i++) {
      const shuffled = [...s.entries].sort(() => Math.random() - 0.5);
      expect(JSON.stringify(jsonify(deriveRound(shuffled, s.round, s.params, all)))).toBe(want);
    }
  });

  it("asks eligibility with the poster's qor1 address and the round", () => {
    const s = new Scenario(fixtureParams(keys));
    s.open(threeHonest(s));
    const asked: [string, bigint][] = [];
    derive(s, (q, r) => (asked.push([q, r]), true));
    expect(asked).toEqual(scouts.slice(0, 3).map((k) => [k.qor, s.round]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
  });

  it("accepts OPEN only inside the open window", () => {
    for (const [dh, ok] of [[-1n, false], [0n, true], [39n, true], [40n, false]] as const) {
      const s = new Scenario(fixtureParams(keys));
      s.open(threeHonest(s), { height: s.w.commitEnd + dh });
      const r = derive(s);
      expect(r.leaves.length).toBe(ok ? 3 : 0);
      if (!ok) expect(r.rejected).toContainEqual({ scout: testKey("operator").qor, reason: REJECT.openOutsideWindow });
    }
  });

  it("refuses a REVEAL posted during the commit window", () => {
    const s = new Scenario(fixtureParams(keys));
    const o = threeHonest(s);
    s.open(o.slice(0, 2));
    s.reveal(scouts[2]!, o[2]!, { height: s.w.commitEnd - 1n });
    expect(derive(s).rejected).toEqual([{ scout: scouts[2]!.qor, reason: REJECT.revealOutsideWindow }]);
  });

  it("counts a scout when a mismatched opening comes before the right one", () => {
    const s = new Scenario(fixtureParams(keys));
    const o = threeHonest(s);
    s.open([{ ...o[0]!, prices: [1n, 1n, 1n] }, ...o]);
    expect(derive(s).leaves.length).toBe(3);
    expect(derive(s).skippedByOpener).toEqual([]);
  });

  it("ignores messages that name another round", () => {
    const s = new Scenario(fixtureParams(keys));
    const o = threeHonest(s);
    s.scout(scouts[3]!, px(3120, 97000, 1), { round: s.round + 1n });
    s.open(o);
    const r = derive(s);
    expect(r.leaves.length).toBe(3);
    expect(r.rejected).toEqual([]);
  });

  it("reports eligibility and missing keys before checking the signature", () => {
    const s = new Scenario(fixtureParams(new Map()));
    s.open(threeHonest(s));
    const r = derive(s, (q) => q !== scouts[0]!.qor);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual([REJECT.noPqKey, REJECT.noPqKey, REJECT.notEligible]);
  });

  it("produces leaves that prove into reportsRoot and an attestation that hashes", () => {
    const s = new Scenario(fixtureParams(keys));
    s.open(threeHonest(s));
    const r = derive(s);
    expect(r.reportsRoot).toBe(reportsRoot(r.leaves));
    for (const l of r.leaves) expect(verifyMerkleProof(r.reportsRoot, leafHash(l), merkleProof(r.leaves, l.scout))).toBe(true);
    const att = toAttestation(r, { index: 1n, inboxStart: 1n, inboxEnd: 9n, closeTime: 1n });
    expect(att.reportCount).toBe(3);
    expect(att.closeHeight).toBe(s.w.commitEnd);
    expect(roundHash(att, { chainId: 9800n, rollupId: "sealed-scouts-1" })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("works with shortened demo timing and other quorum and band rules", () => {
    const params = { ...fixtureParams(keys), genesisHeight: 0n, roundBlocks: 60n, commitBlocks: 30n, openBlocks: 10n, revealBlocks: 10n, quorum: 2, bandBps: 10 };
    const s = new Scenario(params, 3n);
    const a = s.scout(scouts[0]!, px(3120, 97000, 1));
    const b = s.scout(scouts[1]!, px(3130, 97000, 1));
    s.open([a, b]);
    const r = derive(s);
    expect(r.openHeight).toBe(180n);
    expect(r.closeHeight).toBe(210n);
    expect(r.status).toBe("ok");
    expect(r.medians[0]).toEqual({ feedId: 1, price: 312_000_000_000n, count: 2 });
    expect(r.inBand.map((l) => l.scout)).toEqual([a.scout]);
  });

  it("returns an empty no-quorum result for an empty inbox", () => {
    const r = deriveRound([] as InboxEntry[], 0n, fixtureParams(keys), all);
    expect(r.status).toBe("no-quorum");
    expect(r.leaves).toEqual([]);
    expect(r.reportsRoot).toBe(`0x${"00".repeat(32)}`);
  });
});
