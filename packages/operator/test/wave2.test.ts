import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoundAttestation } from "@sealed-scouts/core";
import { defaultDemo, defaultParams, mergeDeployment, timingOf, type OwnKeys } from "../src/deployment.js";
import { evilMedianFor, retireEvilMedian, withEvilMedian } from "../src/evil.js";

const att: RoundAttestation = {
  round: 12n, batchIndex: 3n, inboxStart: 10n, inboxEnd: 17n, closeHeight: 500n, closeTime: 1_700_000_000n,
  feedIds: [1, 2], medians: [180_000_000_000n, 6_400_000_000_000n], counts: [3, 3], reportsRoot: `0x${"11".repeat(32)}`, reportCount: 3,
};

describe("evil median switch", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ss-evil-"));

  it("is off by default", () => {
    expect(evilMedianFor(12n, dir(), {})).toBeUndefined();
  });

  it("fires for the env round only, and replaces one median while leaves and root stay real", () => {
    const env = { SS_EVIL_MEDIAN_ROUND: "12", SS_EVIL_MEDIAN_PRICE: "100000000" };
    expect(evilMedianFor(11n, dir(), env)).toBeUndefined();
    const lie = evilMedianFor(12n, dir(), env)!;
    const bad = withEvilMedian(att, lie);
    expect(bad.medians).toEqual([100_000_000n, 6_400_000_000_000n]);
    expect(bad.reportsRoot).toBe(att.reportsRoot);
    expect(att.medians[0]).toBe(180_000_000_000n); // the honest attestation is not mutated
  });

  it("reads the file switch and retires it after use", () => {
    const d = dir();
    writeFileSync(join(d, "evil-median.json"), JSON.stringify({ round: 12, feedId: 2, price: "5" }));
    const lie = evilMedianFor(12n, d, {})!;
    expect([lie.feedId, lie.price]).toEqual([2, 5n]);
    retireEvilMedian(lie);
    expect(existsSync(join(d, "evil-median.json"))).toBe(false);
    expect(existsSync(join(d, "evil-median.used-round-12.json"))).toBe(true);
    expect(evilMedianFor(12n, d, {})).toBeUndefined();
  });

  it("refuses a feed without a median or a zero price", () => {
    expect(() => withEvilMedian(att, { round: 12n, feedId: 3, price: 1n, source: "t" })).toThrow(/no median for feed 3/);
    expect(() => withEvilMedian(att, { round: 12n, feedId: 1, price: 0n, source: "t" })).toThrow(/zero price/);
  });
});

describe("deployments/diana.json", () => {
  const mine: OwnKeys = {
    chainId: "qorechain-diana", evmChainId: 9800, rollupId: "sealed-scouts-1", operator: "qor1op", operatorEvm: "0x0000000000000000000000000000000000000001",
    genesisHeight: "1000", createdHeight: "900", params: defaultParams(), demo: defaultDemo(), scouts: ["qor1a"], txs: { createRollup: "AB" },
  };

  it("merges only Track C's keys and keeps Track B's contracts and unknown keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ss-dep-")), "diana.json");
    writeFileSync(path, JSON.stringify({ contracts: { PriceFeed: "0xfeed" }, deployedBy: "track-b", genesisHeight: "1" }));
    mergeDeployment(mine, path);
    const j = JSON.parse(readFileSync(path, "utf8"));
    expect(j.contracts).toEqual({ PriceFeed: "0xfeed" });
    expect(j.deployedBy).toBe("track-b");
    expect(j.genesisHeight).toBe("1000");
  });

  it("uses the demo timing only in demo mode, with the main genesis unless its own is set", () => {
    const d = { ...mine, contracts: {} };
    expect(timingOf(d).roundBlocks).toBe(300n);
    expect(timingOf(d, true)).toEqual({ genesisHeight: 1000n, roundBlocks: 90n, commitBlocks: 45n, openBlocks: 15n, revealBlocks: 15n });
    expect(timingOf({ ...d, demo: { ...defaultDemo(), genesisHeight: "5000" } }, true).genesisHeight).toBe(5000n);
    expect(timingOf({ ...d, demo: undefined }, true).roundBlocks).toBe(300n);
  });
});
