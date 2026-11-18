import { describe, expect, it } from "vitest";
import { buildDemoWorld, derive, feedRoundFor } from "@sealed-scouts/watchtower";
import { badBatchDryRun } from "../src/bad-batch.js";
import { BOND, CourtRevert, SimCourt } from "../src/court.js";
import { evilMedianDryRun } from "../src/evil-median.js";
import { stolenKeysDryRun } from "../src/stolen-keys.js";

const refusedAll = (steps: { verdict: string }[]) => steps.filter((s) => s.verdict !== "ACCEPTED").every((s) => s.verdict === "REFUSED");

describe("attack dry runs", () => {
  it("stolen keys: every post, forged report and forged round is refused", async () => {
    const steps = await stolenKeysDryRun();
    expect(steps.length).toBeGreaterThanOrEqual(12);
    expect(refusedAll(steps)).toBe(true);
    expect(steps.filter((s) => s.evidence.pqLayer === "missing")).toHaveLength(3);
    expect(steps.filter((s) => s.evidence.deriveRound === "bad-signature")).toHaveLength(3);
  });

  it("evil median: corrected by the court and the operator slashed; a false challenge fails", async () => {
    const steps = await evilMedianDryRun();
    expect(refusedAll(steps)).toBe(true);
    expect(steps[1]!.evidence).toMatchObject({ status: "corrected", operatorBond: "0", toChallenger: "500000000", burned: "500000000" });
    expect(steps[2]!.evidence.revert).toMatch(/HonestRound/);
  });

  it("bad batch: rejected with the chain's own fraud check; the proof cannot hit an honest batch", async () => {
    const steps = await badBatchDryRun();
    expect(refusedAll(steps)).toBe(true);
    expect(steps[1]!.evidence).toMatchObject({ checkQledgerFraud: true, batchStatus: "rejected", bondLeft: "0" });
    expect(steps[2]!.evidence.code).toBe(51);
  }, 30_000);
});

describe("SimCourt follows the PriceFeed rules", () => {
  const { sim, wrongMedianRound } = buildDemoWorld();
  const court = new SimCourt(sim, "qor1challenger");
  court.bonds.set(sim.operator.address, BOND);
  const leaves = derive(sim, wrongMedianRound).leaves;

  it("refuses leaves that do not hash to the posted root", async () => {
    await expect(court.challengeMedian(wrongMedianRound, leaves.slice(1))).rejects.toThrow(/RootMismatch/);
  });
  it("refuses a round that is not pending", async () => {
    await expect(court.challengeMedian(0n, derive(sim, 0n).leaves)).rejects.toBeInstanceOf(CourtRevert);
  });
  it("refuses to slash over an honest round", async () => {
    sim.feedRounds.set(5n, feedRoundFor(derive(sim, 5n), "pending"));
    await expect(court.challengeMedian(5n, derive(sim, 5n).leaves)).rejects.toThrow(/HonestRound/);
    expect(court.bonds.get(sim.operator.address)).toBe(BOND);
  });
});
