import { bpsFrom, formatPrice } from "./format";
import type { CheckState } from "./receipt";
import type { AttackRun, FeedStatus, RoundVerdict, TowerRound, TowerStatus, UpheldBatch } from "./types";
import { attackTally } from "./pipeline";
import { VERDICT, displayStatus, latestPrices, roundStatus, symbolOf, type DisplayStatus } from "./view";

/**
 * Pure helpers for the newspaper layout: everything a headline, the ticker, the chart or the corrections box says is
 * derived here from the feed, so the words never run ahead of the data.
 */

type Summary = TowerStatus["latestRounds"][number];

/** Same rule as latestPrices: settled on PriceFeed and agreed by the replay. */
const isSettled = (r: Summary) =>
  (r.feedStatus === "final" || r.feedStatus === "corrected") && (r.verdict === "match" || r.verdict === "corrected");

export interface TickerItem {
  feedId: number;
  symbol: string;
  price: string;
  round: string;
  status: "final" | "corrected";
  /** Change from the previous settled round in basis points; null when there is none in the window. */
  changeBps: number | null;
  prevRound?: string;
}

/** The latest verified prices, each with its change from the settled round before it. */
export function tickerOf(s: TowerStatus): TickerItem[] {
  const now = latestPrices(s);
  if (now.length === 0) return [];
  const settled = s.latestRounds.filter(isSettled);
  const at = settled.findIndex((r) => r.round === now[0]!.round);
  const prev = at > 0 ? settled[at - 1] : undefined;
  return now.map((p) => {
    const before = prev?.medians.find((m) => m.feedId === p.feedId);
    return {
      feedId: p.feedId, symbol: symbolOf(p.feedId), price: p.price, round: p.round, status: p.status,
      changeBps: before ? bpsFrom(p.price, before.price) : null, prevRound: prev?.round,
    };
  });
}

/** "+0.19%", "−1.20%", "unch." (a markets-page word for no change), or "" when unknown. */
export function formatChange(bps: number | null): string {
  if (bps === null) return "";
  if (bps === 0) return "unch.";
  return `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(2)}%`;
}

export type PointMark = "corrected" | "disputed" | "pending" | null;
export interface SeriesPoint { round: string; price: string; mark: PointMark }

/** One feed's replayed median per round in the watchtower's window, oldest first, with anything a reader must know. */
export function seriesOf(s: TowerStatus, feedId: number): SeriesPoint[] {
  return s.latestRounds.flatMap((r) => {
    const m = r.medians.find((x) => x.feedId === feedId);
    if (!m) return [];
    const mark: PointMark = r.feedStatus === "corrected" || r.verdict === "corrected" ? "corrected"
      : r.verdict === "median-wrong" || r.verdict === "root-wrong" ? "disputed"
      : r.feedStatus === "pending" ? "pending" : null;
    return [{ round: r.round, price: m.price, mark }];
  });
}

/**
 * Rounds a corrections box should look at, newest first: any round in the window that was corrected or found wrong,
 * and the target of any median challenge (the challenge list reaches further back than the ten-round window).
 */
export function flaggedRounds(s: TowerStatus): string[] {
  const out = new Set<string>();
  for (const r of s.latestRounds) {
    if (r.feedStatus === "corrected" || r.verdict === "corrected" || r.verdict === "median-wrong") out.add(r.round);
  }
  for (const c of s.challenges) {
    const m = /^round (\d+)$/.exec(c.target);
    if (c.kind === "median" && m) out.add(m[1]!);
  }
  return [...out].sort((a, b) => Number(BigInt(b) - BigInt(a)));
}

/** A full EVM transaction hash; anything else ("none", "", a truncated hash) is not printed as a transaction. */
export const isEvmTx = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);

/**
 * Rounds named by a live run's challenge transaction. The watchtower's challenge list starts again when it restarts,
 * so the evidence is what keeps an old correction findable. The round file still decides what, if anything, is printed.
 */
export function evidenceRounds(runs: AttackRun[] | undefined): string[] {
  const out = new Set<string>();
  for (const run of runs ?? []) {
    if (!/^Live/i.test(run.note)) continue;
    for (const s of run.steps) {
      const m = /\bround (\d+)\b/.exec(s.step);
      if (m && isEvmTx(s.evidence.challengeTx)) out.add(m[1]!);
    }
  }
  return [...out];
}

/** Flagged rounds from the feed and from the evidence, newest first, without repeats. */
export const allFlagged = (s: TowerStatus, runs: AttackRun[] | undefined) =>
  [...new Set([...flaggedRounds(s), ...evidenceRounds(runs)])].sort((a, b) => Number(BigInt(b) - BigInt(a)));

export interface CorrectionRow {
  feedId: number;
  /** What the operator signed and posted; undefined when the feed does not carry it. */
  printed?: string;
  /** The median the watchtower recomputes from every opened report. */
  correct: string;
  /** What PriceFeed holds now. */
  onFeed?: string;
}
export interface Correction { round: string; kind: "corrected" | "disputed"; rows: CorrectionRow[]; batchIndex?: string; feedStatus?: FeedStatus }

/**
 * A round's correction notice. "corrected": PriceFeed accepted a median challenge and now holds the recomputed
 * price. "disputed": the replay disagrees with what was posted and no correction is on chain yet.
 */
export function correctionOf(r: TowerRound | undefined): Correction | undefined {
  if (!r || r.verdict === "unknown" || !Array.isArray(r.medians)) return undefined;
  const corrected = r.feed?.status === "corrected" || r.verdict === "corrected";
  if (!corrected && r.verdict !== "median-wrong") return undefined;
  // After a correction PriceFeed's medians are the fixed ones, so the printed figures come from the signed attestation.
  const printedFrom = r.attestation ?? (corrected ? undefined : r.feed ?? undefined);
  const rows = r.medians.map((m) => {
    const i = printedFrom ? printedFrom.feedIds.indexOf(m.feedId) : -1;
    const j = r.feed ? r.feed.feedIds.indexOf(m.feedId) : -1;
    return { feedId: m.feedId, printed: i >= 0 ? printedFrom!.medians[i] : undefined, correct: m.price, onFeed: j >= 0 ? r.feed!.medians[j] : undefined };
  }).filter((row) => row.printed !== row.correct);
  return { round: r.round, kind: corrected ? "corrected" : "disputed", rows, batchIndex: r.feed?.batchIndex, feedStatus: r.feed?.status };
}

export interface ChallengeTx { hash: string; run: string; live: boolean; at: string; step: string }

/** Challenge transactions recorded by the attack runs for one round. */
export function challengeEvidence(runs: AttackRun[] | undefined, round: string): ChallengeTx[] {
  const re = new RegExp(`\\bround ${round}\\b`);
  return (runs ?? []).flatMap((run) => run.steps
    .filter((s) => isEvmTx(s.evidence.challengeTx) && re.test(s.step))
    .map((s) => ({ hash: String(s.evidence.challengeTx), run: run.name, live: /^Live/i.test(run.note), at: run.at, step: s.step })));
}

/**
 * The replay's verdict next to a round's status, or null when it would only repeat it: a corrected round's verdict is
 * "corrected" too, and the page says so once.
 */
export function replayNote(feedStatus: FeedStatus | string | null | undefined, verdict: RoundVerdict) {
  if (verdict === "corrected" && (feedStatus === "corrected" || feedStatus == null)) return null;
  return VERDICT[verdict];
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** House style: numbers under ten are spelled out. */
export const spell = (n: number) => (Number.isInteger(n) && n >= 0 && n < 10 ? WORDS[n]! : n.toLocaleString("en-US"));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface Lead { kicker: string; headline: string; deck: string; round?: string }

/**
 * The front page's lead story, worded from the newest settled round in plain words: what the scouts did and what the
 * chain checked. A newer disputed round, or a paused feed, adds one sentence so the story never reads better than the
 * data. `paused` comes from feedState and is left out for the sample feed.
 */
export function leadOf(s: TowerStatus, opts: { paused?: boolean } = {}): Lead {
  const prices = latestPrices(s);
  const newest = s.latestRounds[s.latestRounds.length - 1];
  const pausedNote = opts.paused ? " The feed has paused, so this is its last word." : "";
  if (prices.length === 0) {
    const pending = newest?.feedStatus === "pending" && (newest.verdict === "match" || newest.verdict === "not-posted");
    return {
      kicker: "Price oracle",
      headline: "No price has settled yet",
      deck: (pending
        ? `Round ${newest!.round} is posted and pending. No lender can use it until its challenge window ends.`
        : `The watchtower has replayed ${spell(s.rounds.replayed)} round${s.rounds.replayed === 1 ? "" : "s"}; none is final yet.`) + pausedNote,
      round: newest?.round,
    };
  }
  const p = prices[0]!;
  const sym = symbolOf(p.feedId).replace(/\/USD$/, "");
  const headline = p.status === "corrected"
    ? `${sym} stands at $${formatPrice(p.price)} after round ${p.round} was corrected`
    : `${sym} settles at $${formatPrice(p.price)} in round ${p.round}`;
  const n = p.count;
  let deck = `${cap(spell(n))} scout${n === 1 ? " sealed its price" : "s sealed their prices"}, so none could copy another. ` +
    (p.status === "corrected"
      ? "A challenge replaced the operator's wrong figure on chain, and the corrected price is final."
      : "The chain checked the post-quantum signature and the price is final.");
  const disputed = s.latestRounds.filter((r) => BigInt(r.round) > BigInt(p.round) && (r.verdict === "median-wrong" || r.verdict === "root-wrong"));
  if (disputed.length > 0) {
    const ids = disputed.map((r) => r.round);
    deck += ` Round${ids.length === 1 ? "" : "s"} ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} disputed: the watchtower's replay disagrees with what was posted.`;
  }
  return { kicker: `Price oracle · round ${p.round}`, headline, deck: deck + pausedNote, round: p.round };
}

/** "Friday 20 November 2026" and "10:52 UTC", in UTC so every reader sees the same edition. */
export function dateline(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(d);
  return { date: `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`, time: `${time} UTC` };
}

/** The round page's headline, worded from what PriceFeed and the replay say about the round. */
export function roundHeadline(r: TowerRound): string {
  const n = `Round ${r.round}`;
  if (r.feed?.status === "corrected" || r.verdict === "corrected") return `${n}: a wrong median was challenged and corrected`;
  if (r.verdict === "median-wrong") return `${n}: the replay disputes the posted median`;
  if (r.verdict === "root-wrong") return `${n}: the report set differs from the inbox`;
  const st = roundStatus(r);
  const m = r.medians?.[0];
  const sym = m ? symbolOf(m.feedId).replace(/\/USD$/, "") : "";
  if (st === "no-quorum") return `${n}: too few valid reports for a price`;
  if (st === "final" && m) return `${n}: ${sym} final at $${formatPrice(m.price)}`;
  if (st === "pending" && m) return `${n}: ${sym} posted at $${formatPrice(m.price)}, pending`;
  if (st === "sealed") return `${n}: reports still sealed`;
  return `${n}: opened, not yet posted to PriceFeed`;
}

/**
 * Whether a live attack run counts as ours. A run where someone else's challenge got there first says so in its
 * evidence ("not ours", "lost the race"), and the page must not credit our watchtower with it.
 */
export function runCounts(run: AttackRun): boolean {
  return !/lost the race|not counted/i.test(run.note) && !run.steps.some((s) => /\bnot ours\b/i.test(s.step));
}

export interface BatchFraud {
  run: string;
  at: string;
  batchIndex?: string;
  bondTx?: string;
  /** In uqor, as recorded. */
  bondAmount?: string;
  submitTx?: string;
  stateRoot?: string;
  honestRoot?: string;
  challengeTx: string;
  batchStatus?: string;
  bondLeft?: string;
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

/** The counted live bad-batch run: a fraud proof our watchtower sent, with the bad batch and the bond it cost. */
export function batchFraudOf(runs: AttackRun[] | undefined): BatchFraud | undefined {
  for (const run of runs ?? []) {
    if (!/^Live/i.test(run.note) || !runCounts(run)) continue;
    const challenge = run.steps.find((s) => typeof s.evidence.challengeTx === "string" && s.evidence.challengeTx !== "none" && s.evidence.batchStatus !== undefined);
    if (!challenge) continue;
    const submit = run.steps.find((s) => s.evidence.stateRoot !== undefined);
    const bond = run.steps.find((s) => s.evidence.amount !== undefined && /bond/i.test(s.step));
    return {
      run: run.name, at: run.at,
      batchIndex: submit ? /batch (\d+)/.exec(submit.step)?.[1] : undefined,
      bondTx: str(bond?.evidence.txHash), bondAmount: str(bond?.evidence.amount),
      submitTx: str(submit?.evidence.txHash), stateRoot: str(submit?.evidence.stateRoot), honestRoot: str(submit?.evidence.honestRoot),
      challengeTx: String(challenge.evidence.challengeTx), batchStatus: str(challenge.evidence.batchStatus), bondLeft: str(challenge.evidence.rogueBondLeft),
    };
  }
  return undefined;
}

interface TxEvent { type: string; attributes: { key: string; value: string }[] }
export interface TxResponse { tx_response?: { height?: string; code?: number; events?: TxEvent[] } }

/**
 * The chain's own verdict on a fraud proof: upheld only when the challenge transaction succeeded (code 0) and carries
 * an rdk_fraud_upheld event. Unread when there is no transaction record yet.
 */
export function fraudProofOf(tx: TxResponse | undefined): { state: "unread" } | { state: "not-upheld"; code?: number }
  | ({ state: "upheld" } & NonNullable<ReturnType<typeof fraudUpheldOf>>) {
  if (!tx?.tx_response) return { state: "unread" };
  const up = fraudUpheldOf(tx);
  return up ? { state: "upheld", ...up } : { state: "not-upheld", code: tx.tx_response.code };
}

/** The rdk_fraud_upheld event of a successful challenge transaction, or undefined. */
export function fraudUpheldOf(tx: TxResponse | undefined) {
  const t = tx?.tx_response;
  const e = t?.code === 0 ? t.events?.find((x) => x.type === "rdk_fraud_upheld") : undefined;
  if (!t || !e) return undefined;
  const get = (k: string) => e.attributes.find((a) => a.key === k)?.value;
  return { height: t.height, batchIndex: get("batch_index"), slashed: get("slashed"), reward: get("challenger_reward"), burned: get("burned"), challenger: get("challenger") };
}

/** "1000000000uqor" or "1000000000" (uqor) as "1,000 QOR". */
export function formatQor(raw: string | undefined): string | undefined {
  const m = raw && /^(\d+)(uqor)?$/.exec(raw);
  if (!m) return undefined;
  const v = BigInt(m[1]!);
  const whole = (v / 1_000_000n).toLocaleString("en-US");
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} QOR`;
}

/** The watchtower feed counts as paused once it has not been updated for this long. */
export const FEED_PAUSED_AFTER_MS = 5 * 60 * 1000;

/** Live or paused, from the feed's own timestamp and the reader's clock. */
export function feedState(updatedAt: string, now = Date.now()) {
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return { paused: false, ageMs: 0 };
  const ageMs = Math.max(0, now - t);
  return { paused: ageMs > FEED_PAUSED_AFTER_MS, ageMs };
}

/** "2 h 13 min", "7 min": how long ago, for a reader. */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

/**
 * The verdict line for a finished receipt check. `tampered` is the setting that run used, never the checkbox's state
 * now, so ticking the box after a clean run cannot relabel that run.
 */
export function verdictOf(valid: boolean, checks: { state: CheckState }[], tampered: boolean) {
  const t = checkTally(checks).text;
  return { word: valid ? "Receipt valid" : "Receipt refused", tally: tampered ? `${t}; one digit was changed before checking` : t };
}

export interface RoundGap {
  /** The last round before the gap and the first after it. */
  before: string;
  after: string;
  /** The missing rounds, inclusive. */
  from: string;
  to: string;
  missing: number;
}

/**
 * Breaks in a run of round numbers (oldest first). Round numbers follow chain height, so a jump means no rounds ran:
 * the loop was paused. Any number of gaps.
 */
export function roundGaps(rounds: string[]): RoundGap[] {
  const out: RoundGap[] = [];
  for (let i = 1; i < rounds.length; i++) {
    const a = BigInt(rounds[i - 1]!), b = BigInt(rounds[i]!);
    if (b - a > 1n) out.push({ before: rounds[i - 1]!, after: rounds[i]!, from: String(a + 1n), to: String(b - 1n), missing: Number(b - a - 1n) });
  }
  return out;
}

/** Gaps in the watchtower's window, from every replayed round: the same rounds the market-data table lists. */
export const windowGaps = (s: TowerStatus) => roundGaps(s.latestRounds.map((r) => r.round));

/** The gap lying between two listed rounds, if any (a chart point may skip a round, so match on the range). */
export const gapBetween = (gaps: RoundGap[], a: string, b: string) =>
  gaps.find((g) => BigInt(g.before) >= BigInt(a) && BigInt(g.after) <= BigInt(b));

/**
 * Whether a gap means the loop was paused. Only in the demo round mode, where the round number follows chain height,
 * does a jump mean no rounds ran; otherwise the page states the gap without a cause.
 */
export const gapMeansPause = (roundMode: string | undefined) => roundMode === "demo";

/** "No round 36" or "No rounds 36–505". */
export const gapLabel = (g: RoundGap) => (g.missing === 1 ? `No round ${g.from}` : `No rounds ${g.from}–${g.to}`);

/**
 * When the loop was paused, from the round files on either side: heights always, times only where a round's signed
 * attestation carries its close time (unposted rounds have none).
 */
export function pauseSpan(before: TowerRound | undefined, after: TowerRound | undefined) {
  const closeTime = (r?: TowerRound) => (r?.attestation?.closeTime ? new Date(Number(r.attestation.closeTime) * 1000).toISOString() : undefined);
  return {
    fromHeight: before?.closeHeight, toHeight: after?.openHeight,
    fromTime: closeTime(before), toTime: closeTime(after),
  };
}

/**
 * Runs of rounds that were opened and replayed but never posted to PriceFeed, where a later round was posted: the
 * operator moved on, so these will not be posted. Oldest first, as [first, last].
 */
export function unpostedRuns(s: TowerStatus): [string, string][] {
  const rs = s.latestRounds;
  const lastPosted = rs.reduce((at, r, i) => (r.feedStatus === "pending" || r.feedStatus === "final" || r.feedStatus === "corrected" ? i : at), -1);
  const out: [string, string][] = [];
  for (let i = 0; i < lastPosted; i++) {
    if (rs[i]!.verdict !== "not-posted") continue;
    const prev = out[out.length - 1];
    if (prev && i > 0 && rs[i - 1]!.verdict === "not-posted" && BigInt(rs[i]!.round) - BigInt(rs[i - 1]!.round) === 1n) prev[1] = rs[i]!.round;
    else out.push([rs[i]!.round, rs[i]!.round]);
  }
  return out;
}

/**
 * The fraud proofs the chain upheld, with whose they were. Ours is the one whose transaction is the counted bad-batch
 * run's challenge; a challenger another live run names as a public network challenger is labelled so. No address is
 * assumed.
 */
export function upheldRows(upheld: UpheldBatch[] | undefined, runs: AttackRun[] | undefined): (UpheldBatch & { ours?: boolean; who?: string })[] {
  const ours = batchFraudOf(runs)?.challengeTx.toUpperCase();
  // Without the counted run (still loading, failed, or no bad-batch evidence) nothing can be said about whose a proof
  // was: the rows stay neutral, with neither "ours" nor "not ours".
  if (!ours) return (upheld ?? []).map((u) => ({ ...u }));
  const publicOnes = new Set((runs ?? []).flatMap((r) => r.steps
    .filter((st) => /public network challenger/i.test(st.step) && typeof st.evidence.challenger === "string")
    .map((st) => String(st.evidence.challenger))));
  return (upheld ?? []).map((u) => {
    const mine = u.txHash.toUpperCase() === ours;
    return { ...u, ours: mine, who: mine ? "our watchtower" : publicOnes.has(u.challenger) ? "a public network challenger" : "another challenger" };
  });
}

/** "6 passed, 2 skipped": counts straight from the check states. */
export function checkTally(checks: { state: CheckState }[]) {
  const n = (st: CheckState) => checks.filter((c) => c.state === st).length;
  const counts = { passed: n("pass"), failed: n("fail"), skipped: n("skip"), open: n("wait") + n("run") };
  const text = ([[counts.passed, "passed"], [counts.failed, "failed"], [counts.skipped, "skipped"]] as const)
    .filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
  return { ...counts, text };
}

/** The counted live run of one attack, by the name its evidence file gives it. */
export const liveRunOf = (runs: AttackRun[] | undefined, name: string) =>
  (runs ?? []).find((r) => /^Live/i.test(r.note) && runCounts(r) && r.name === name);

/** The step of a live median-attack run that carries the challenge transaction, and the round it names. */
export function medianChallengeOf(runs: AttackRun[] | undefined) {
  const run = liveRunOf(runs, "evil-median");
  const step = run?.steps.find((s) => isEvmTx(s.evidence.challengeTx));
  if (!run || !step) return undefined;
  return {
    run, step, tx: String(step.evidence.challengeTx), refused: step.verdict === "REFUSED",
    round: /\bround (\d+)\b/.exec(step.step)?.[1],
    // PriceFeed's Status enum: none, pending, final, corrected.
    corrected: step.verdict === "REFUSED" && Number(step.evidence.feedStatus) === 3,
  };
}

export type AttackId = "stolen-keys" | "lying-operator" | "bad-batch";
export interface AttackLine { id: AttackId; title: string; line: string; known: boolean }

/**
 * The front page's "Attacks stopped" box: one line per attack, worded from the evidence and the feed. An attack with
 * no counted live run says so instead of claiming a result; when the evidence could not be loaded at all (`failed`),
 * every line says that rather than "no run on record".
 */
export function attackSummary(runs: AttackRun[] | undefined, s?: TowerStatus, opts: { failed?: boolean } = {}): AttackLine[] {
  const none = opts.failed && !runs ? "evidence could not be loaded" : "no live run on record yet";
  const keys = liveRunOf(runs, "stolen-keys");
  const t = keys ? attackTally(keys) : undefined;
  const keysLine = !t ? none
    : `${t.refused} of ${t.attempts} forged posts refused${t.notRefused ? `; ${t.notRefused} not refused` : ""}`;

  const m = medianChallengeOf(runs);
  const medianLine = !m ? none : m.corrected ? "wrong price corrected, bond slashed" : m.refused ? "wrong price challenged" : "challenge not upheld";

  const f = batchFraudOf(runs);
  const ours = upheldRows(s?.batches.upheld, runs).find((u) => u.ours);
  const slashed = formatQor(ours?.slashedUqor)
    ?? (f?.batchStatus === "rejected" && f.bondLeft === "0" ? formatQor(f.bondAmount) : undefined);
  const batchLine = !f ? none : slashed ? `${slashed} bond slashed by our watchtower` : "fraud proof sent by our watchtower";

  return [
    { id: "stolen-keys", title: "Stolen keys", line: keysLine, known: !!t },
    { id: "lying-operator", title: "Lying operator", line: medianLine, known: !!m },
    { id: "bad-batch", title: "Bad batch", line: batchLine, known: !!f },
  ];
}

/** At most three watchtower figures for the front page; `alert` when a non-zero figure is bad news. */
export function towerNumbers(s: TowerStatus): { label: string; value: number; alert: boolean }[] {
  const standing = s.batches.fraud + s.rounds.medianWrong + s.rounds.rootWrong;
  const proven = s.batches.upheldOnChain;
  return [
    { label: "Rounds replayed", value: s.rounds.replayed, alert: false },
    // Older feeds lack the chain's count; then the corrected rounds stand in rather than a 0.
    proven !== undefined
      ? { label: "Frauds proven on chain", value: proven, alert: false }
      : { label: "Rounds corrected on PriceFeed", value: s.rounds.corrected, alert: false },
    { label: "Fraud still standing", value: standing, alert: standing > 0 },
  ];
}

export interface RecentRow {
  round: string;
  status: DisplayStatus;
  /** The replay disagrees with what was posted (and no correction has landed). */
  disputed: boolean;
  /** fETH/USD replayed median. */
  price?: string;
  reports: number;
  leftOut: number;
  /** A gap between this row and the (shown) row below it. */
  gap?: RoundGap;
}

/** The newest `n` rounds for the front page, newest first, with any gap that falls between two shown rows. */
export function recentRounds(s: TowerStatus, n = 5, feedId = 1): RecentRow[] {
  const gaps = windowGaps(s);
  const rows = s.latestRounds.slice(-n).reverse();
  return rows.map((r, i) => ({
    round: r.round,
    status: displayStatus(r.feedStatus, r.verdict),
    disputed: r.verdict === "median-wrong" || r.verdict === "root-wrong",
    price: r.medians.find((m) => m.feedId === feedId)?.price,
    reports: r.reports,
    leftOut: r.leftOut,
    gap: i < rows.length - 1 ? gaps.find((g) => g.after === r.round) : undefined,
  }));
}
