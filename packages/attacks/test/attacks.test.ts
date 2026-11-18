import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDemoWorld, derive, feedRoundFor } from "@sealed-scouts/watchtower";
import { badBatchDryRun } from "../src/bad-batch.js";
import { BOND, CourtRevert, SimCourt } from "../src/court.js";
import { evilMedianDryRun } from "../src/evil-median.js";
import { recordClaims, type Step } from "../src/evidence.js";
import { nativeVerdict, postRoundVerdict, stolenKeysDryRun, windowVerdict } from "../src/stolen-keys.js";

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

describe("recordClaims", () => {
  const step = (verdict: Step["verdict"], tx?: string): Step => ({
    attack: "bad-batch", step: "challenge", verdict, where: "chain", evidence: tx ? { challengeTx: tx } : {},
    claim: { id: "chain-fraud-slash", layer: "native", txKey: "challengeTx" },
  });

  it("merges refused steps with a tx into claims.json and keeps other claims", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ss-claims-")), "evidence", "claims.json");
    expect(recordClaims([step("REFUSED", "")], path)).toEqual([]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ claims: { "rollup-created": { tx: "AA", layer: "native" } } }));
    expect(recordClaims([step("NOT REFUSED", "BB"), step("REFUSED", "CC")], path)).toEqual(["chain-fraud-slash"]);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.claims["rollup-created"]).toEqual({ tx: "AA", layer: "native" });
    expect(file.claims["chain-fraud-slash"]).toMatchObject({ tx: "CC", layer: "native", note: "bad-batch: challenge" });
  });
});

describe("live stolen-keys counts only the expected refusal", () => {
  it("native: the PQ check refuses; any other failure is an ERROR", () => {
    expect(nativeVerdict({ code: 7, codespace: "pqc", rawLog: "missing signature" })).toBe("REFUSED");
    expect(nativeVerdict({ code: 4, codespace: "sdk", rawLog: "unauthorized: PQC hybrid signature verification failed" })).toBe("REFUSED");
    expect(nativeVerdict({ code: 5, codespace: "sdk", rawLog: "insufficient funds" })).toBe("ERROR");
    expect(nativeVerdict({ code: 0, codespace: "", rawLog: "" })).toBe("NOT REFUSED");
  });
  it("postRound: only BadSignature is the ML-DSA check", () => {
    expect(postRoundVerdict("BadSignature")).toBe("REFUSED");
    expect(postRoundVerdict("StaleRound")).toBe("ERROR");
    expect(postRoundVerdict("OperatorNotBonded")).toBe("ERROR");
    expect(postRoundVerdict(undefined)).toBe("NOT REFUSED");
  });
  it("EVM lane: only 'no open EVM authorisation window' counts", () => {
    expect(windowVerdict(new Error("rpc error: no open EVM authorisation window"))).toBe("REFUSED");
    expect(windowVerdict(new Error("nonce too low"))).toBe("ERROR");
  });
});
