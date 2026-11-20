import type { AttackRun, TowerRound, TowerStatus } from "./types";
import { VERDICT } from "./view";

/**
 * The explainer graphic's state for one round: scouts -> rollup inbox -> median and anchor -> PriceFeed -> ScoutLend.
 * A step is lit only when the data says it happened, so the graphic never shows more than the feed knows.
 */

export type StepTone = "pass" | "wait" | "fail";
/** `short` labels the step in the graphic; `text` is the full sentence for the caption under it. */
export interface PipelineStep { lit: boolean; tone: StepTone; short: string; text: string }
export interface PipelineScout {
  key: string;
  label: string;
  /** Full address, or what is known about an unnamed report. */
  title: string;
  /** Unknown until the round file is loaded. */
  counted?: boolean;
}
export interface Pipeline {
  round: string;
  /** One entry per report posted this round; empty when nobody posted. */
  scouts: PipelineScout[];
  inbox: PipelineStep;
  median: PipelineStep;
  feed: PipelineStep;
  lend: PipelineStep;
  replay: (typeof VERDICT)[keyof typeof VERDICT];
}

export type RoundSummary = TowerStatus["latestRounds"][number];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);

/** The newest round the watchtower replayed (latestRounds runs oldest to newest). */
export const newestRound = (s: TowerStatus): RoundSummary | undefined => s.latestRounds[s.latestRounds.length - 1];

/** A round file is usable when it is for this round and is not the bare "could not read the chain" stub. */
export const usableDetail = (round: string, detail?: TowerRound) =>
  detail && detail.round === round && detail.verdict !== "unknown" && Array.isArray(detail.reports) ? detail : undefined;

export function pipelineOf(summary: RoundSummary | undefined, detail?: TowerRound): Pipeline | undefined {
  if (!summary) return undefined;
  const d = usableDetail(summary.round, detail);
  const posted = d ? d.reports.length : summary.reports;

  const scouts: PipelineScout[] = d
    ? d.reports.map((r) => ({ key: r.scout, label: shortAddr(r.scout), title: r.scout, counted: r.counted }))
    : Array.from({ length: posted }, (_, i) => ({ key: `report-${i}`, label: `report ${i + 1}`, title: "a sealed report" }));

  const { verdict, feedStatus: fs } = summary;
  const wrong = verdict === "median-wrong" || verdict === "root-wrong";
  const opened = summary.medians.length > 0 && verdict !== "no-quorum" && verdict !== "unknown";
  const counted = Math.max(0, ...summary.medians.map((m) => m.count));
  const onFeed = fs === "pending" || fs === "final" || fs === "corrected";
  const settled = fs === "final" || fs === "corrected";

  const inbox: PipelineStep = posted > 0
    ? { lit: true, tone: "pass", short: `${posted} sealed`, text: `${plural(posted, "sealed report")} in the inbox` }
    : { lit: false, tone: "wait", short: "empty", text: "no reports yet" };

  const median: PipelineStep = !opened
    ? verdict === "no-quorum"
      ? { lit: false, tone: "wait", short: "no quorum", text: "too few valid reports for a median" }
      : { lit: false, tone: "wait", short: "not opened", text: "not opened yet" }
    : wrong
      ? { lit: true, tone: "fail", short: "replay disagrees", text: `median of ${counted} reports; ${VERDICT[verdict].text}` }
      : { lit: true, tone: "pass", short: `median of ${counted}`, text: `opened; median of ${counted} reports` };

  const feed: PipelineStep = onFeed
    ? { lit: true, tone: fs === "pending" ? "wait" : "pass", short: fs, text: `PriceFeed accepted the ML-DSA-87 signature via pqcVerify; status ${fs}` }
    : { lit: false, tone: "wait", short: "not posted", text: "not posted to PriceFeed yet" };

  const lend: PipelineStep = settled
    ? wrong
      ? { lit: true, tone: "fail", short: "replay disagrees", text: "final on PriceFeed, but the watchtower's replay disagrees" }
      : { lit: true, tone: "pass", short: "readable", text: "final: readFinal serves it while it is under 10 minutes old" }
    : fs === "pending"
      ? { lit: false, tone: "wait", short: "waits for final", text: "pending: readFinal will not serve it until the challenge window ends" }
      : { lit: false, tone: "wait", short: "nothing yet", text: "nothing for ScoutLend to read from this round" };

  return { round: summary.round, scouts, inbox, median, feed, lend, replay: VERDICT[verdict] };
}

/** How many attack attempts in a run were refused. ACCEPTED steps are harmless setup, not attempts. */
export function attackTally(run: AttackRun) {
  const attempts = run.steps.filter((s) => s.verdict !== "ACCEPTED");
  const refused = attempts.filter((s) => s.verdict === "REFUSED").length;
  return { attempts: attempts.length, refused, notRefused: attempts.length - refused, setup: run.steps.length - attempts.length };
}

/** Live runs say so in their note; dry runs and simulations do not. */
export const isLiveRun = (run: AttackRun) => /^Live/i.test(run.note);
