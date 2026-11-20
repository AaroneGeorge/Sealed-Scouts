import { describe, expect, it } from "vitest";
import { attackTally, isLiveRun, newestRound, pipelineOf } from "../src/lib/pipeline";
import type { AttackRun, TowerRound, TowerStatus } from "../src/lib/types";

type Summary = TowerStatus["latestRounds"][number];
const summary = (over: Partial<Summary> = {}): Summary =>
  ({ round: "5", verdict: "match", medians: [{ feedId: 1, price: "100", count: 5 }], reports: 5, leftOut: 0, feedStatus: "final", ...over });
const detail = (over: Partial<TowerRound> = {}) =>
  ({
    round: "5",
    verdict: "match",
    reports: [
      { scout: "qor134s38tk7avkjstzx2hel6lu64flmvxfjemj430", reportBytes: 1772, commitBytes: 4672, height: "2505", counted: true },
      { scout: "qor1ertass06w3v0w5pujucn2rh6fev52j58huvcmq", reportBytes: 1772, commitBytes: 4672, height: "2506", counted: false },
    ],
    ...over,
  }) as TowerRound;

describe("pipelineOf", () => {
  it("is empty with no round", () => expect(pipelineOf(undefined)).toBeUndefined());

  it("lights every step for a final round that replay agrees with", () => {
    const p = pipelineOf(summary())!;
    expect([p.inbox.lit, p.median.lit, p.feed.lit, p.lend.lit]).toEqual([true, true, true, true]);
    expect([p.inbox.tone, p.median.tone, p.feed.tone, p.lend.tone]).toEqual(["pass", "pass", "pass", "pass"]);
    expect(p.replay.tone).toBe("pass");
  });

  it("stops at PriceFeed while the round is pending", () => {
    const p = pipelineOf(summary({ feedStatus: "pending" }))!;
    expect(p.feed).toMatchObject({ lit: true, tone: "wait", short: "pending" });
    expect(p.lend).toMatchObject({ lit: false, tone: "wait" });
    expect(p.lend.text).toMatch(/pending/);
  });

  it("shows a wrong median as a failure, even once it is final", () => {
    const pending = pipelineOf(summary({ verdict: "median-wrong", feedStatus: "pending" }))!;
    expect(pending.median).toMatchObject({ tone: "fail", short: "replay disagrees" });
    expect(pending.lend.lit).toBe(false);
    const final = pipelineOf(summary({ verdict: "median-wrong", feedStatus: "final" }))!;
    expect(final.lend).toMatchObject({ lit: true, tone: "fail" });
    expect(final.replay.tone).toBe("fail");
  });

  it("lights nothing past the inbox without a quorum", () => {
    const p = pipelineOf(summary({ verdict: "no-quorum", feedStatus: null, reports: 2 }))!;
    expect(p.inbox.lit).toBe(true);
    expect([p.median.lit, p.feed.lit, p.lend.lit]).toEqual([false, false, false]);
    expect(p.scouts).toHaveLength(2);
  });

  it("lights nothing and draws no scouts for a round with no reports", () => {
    const p = pipelineOf(summary({ reports: 0, medians: [], feedStatus: null, verdict: "not-posted" }))!;
    expect(p.scouts).toHaveLength(0);
    expect([p.inbox.lit, p.median.lit, p.feed.lit, p.lend.lit]).toEqual([false, false, false, false]);
  });

  it("names the scouts from the round file and invents none", () => {
    const p = pipelineOf(summary({ reports: 2 }), detail())!;
    expect(p.scouts).toHaveLength(2);
    expect(p.scouts[0]).toMatchObject({ counted: true, title: "qor134s38tk7avkjstzx2hel6lu64flmvxfjemj430", label: "qor134s3…j430" });
    expect(p.scouts[1]!.counted).toBe(false);
  });

  it("ignores a round file for another round or the could-not-read stub", () => {
    expect(pipelineOf(summary(), detail({ round: "4" }))!.scouts[0]!.label).toBe("report 1");
    const stub = { round: "5", verdict: "unknown" } as TowerRound;
    const p = pipelineOf(summary(), stub)!;
    expect(p.scouts).toHaveLength(5);
    expect(p.scouts.every((s) => s.counted === undefined)).toBe(true);
  });

  it("takes the newest round from the status", () => {
    const s = { latestRounds: [summary({ round: "1" }), summary({ round: "2" })] } as TowerStatus;
    expect(newestRound(s)?.round).toBe("2");
    expect(newestRound({ latestRounds: [] } as unknown as TowerStatus)).toBeUndefined();
  });
});

describe("attack runs", () => {
  const step = (verdict: AttackRun["steps"][number]["verdict"]) => ({ attack: "a", step: "s", verdict, where: "chain" as const, evidence: {} });
  it("counts refusals and leaves setup steps out", () => {
    const run: AttackRun = { name: "x", note: "Live", at: "2026-11-18", steps: [step("ACCEPTED"), step("REFUSED"), step("REFUSED"), step("NOT REFUSED")] };
    expect(attackTally(run)).toEqual({ attempts: 3, refused: 2, notRefused: 1, setup: 1 });
  });
  it("tells live runs from dry runs by their note", () => {
    expect(isLiveRun({ name: "x", note: "Live testnet run (qorechain-diana).", at: "", steps: [] })).toBe(true);
    expect(isLiveRun({ name: "x", note: "DRY RUN: local checks", at: "", steps: [] })).toBe(false);
  });
});
