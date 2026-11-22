import { useRef } from "react";
import { Empty, Label, Mark, StatusMark } from "../components/bits";
import { PriceChart } from "../components/charts";
import { CorrectionsBox } from "../components/Corrections";
import { Explainer } from "../components/Explainer";
import { api } from "../lib/api";
import {
  attackSummary, feedState, gapLabel, gapMeansPause, leadOf, pauseSpan, recentRounds, seriesOf, towerNumbers, unpostedRuns, windowGaps,
  type RoundGap,
} from "../lib/edition";
import { formatInt, formatPrice } from "../lib/format";
import { newestRound, pipelineOf } from "../lib/pipeline";
import type { AttackRun, TowerStatus } from "../lib/types";
import { useData } from "../lib/useData";
import { FEEDS, isSample } from "../lib/view";

/** How many rounds the front page lists; every round has its own page. */
const RECENT = 5;

export function Rounds({ status, roundMode }: { status: TowerStatus; roundMode?: string }) {
  // One list of gaps for the chart and the table: from every replayed round, not one feed's points.
  const gaps = windowGaps(status);
  const paused = gapMeansPause(roundMode);
  // The status poll re-renders this page every few seconds, so the reader's clock here is fresh enough.
  const feedPaused = !isSample(status) && feedState(status.updatedAt).paused;
  const lead = leadOf(status, { paused: feedPaused });
  const newest = newestRound(status);
  const newestFile = useData(() => (newest ? api.round(newest.round) : Promise.resolve(undefined)), [newest?.round], 15_000);
  const pipeline = pipelineOf(newest, newestFile.data);
  const runs = useData(api.attacks, []);

  const main = FEEDS.find((f) => status.latestRounds.some((r) => r.medians.some((m) => m.feedId === f.feedId)));
  const series = main ? seriesOf(status, main.feedId) : [];

  return (
    <div className="stack" style={{ gap: 44 }}>
      <div className="front">
        <article>
          <header className="lead-head">
            <span className="kicker">{lead.kicker}</span>
            <h1 className="headline">{lead.headline}</h1>
            <p className="deck">{lead.deck}</p>
          </header>

          {main && series.length > 0 && (
            <figure className="chart">
              <div className="title">{main.symbol}, price by round <span>US dollars</span></div>
              <PriceChart points={series} symbol={main.symbol} gaps={gaps} paused={paused} />
              <figcaption className="source">
                Source: the watchtower's replay of the last {spell10(series.length)} rounds.
                {series.some((p) => p.mark === "pending") && " Open circle: still pending."}
                {series.length > 1 && gaps.filter((g) => BigInt(g.before) >= BigInt(series[0]!.round) && BigInt(g.after) <= BigInt(series[series.length - 1]!.round))
                  .map((g) => <span key={g.after}> <PauseNote gap={g} paused={paused} />.</span>)}
              </figcaption>
            </figure>
          )}
        </article>

        <aside className="rail" aria-label="Attacks stopped and the watchtower">
          <AttacksBox runs={runs.data} loading={runs.loading} failed={!!runs.error && !runs.missing} status={status} />
          <TowerFigures status={status} />
        </aside>
      </div>

      {pipeline && (
        <section aria-labelledby="how-h">
          <Label id="how-h" aside={`Now: round ${pipeline.round}`}>How a round works</Label>
          <Explainer p={pipeline} rollupId={status.rollupId} />
        </section>
      )}

      <section aria-labelledby="data-h">
        <Label id="data-h" aside="Select a round for every report">Recent rounds</Label>
        <RoundsTable status={status} paused={paused} />
      </section>
    </div>
  );
}

const spell10 = (n: number) => (n === 10 ? "ten" : String(n));

/** Three lines, one per attack, each linking to its card on the attacks page. */
function AttacksBox({ runs, loading, failed, status }: { runs?: AttackRun[]; loading: boolean; failed: boolean; status: TowerStatus }) {
  // A missing evidence index means no runs are recorded; any other error means they could not be read.
  const lines = attackSummary(runs, status, { failed });
  return (
    <CorrectionsBox title="Attacks stopped">
      <ul className="stopped">
        {lines.map((a) => (
          <li key={a.id}>
            <a href={`#/attacks#${a.id}`}><b>{a.title}</b></a>
            <span className={a.known ? undefined : "muted"}>{!runs && loading ? "loading the evidence…" : a.line}</span>
          </li>
        ))}
      </ul>
      <p className="how more"><a href="#/attacks">Every attack, with its transactions</a></p>
    </CorrectionsBox>
  );
}

function TowerFigures({ status }: { status: TowerStatus }) {
  return (
    <section aria-labelledby="tower-h">
      <Label id="tower-h">Watchtower</Label>
      <table className="desk">
        <tbody>
          {towerNumbers(status).map((n) => (
            <tr key={n.label} className={n.alert ? "alert" : undefined}><td>{n.label}</td><td className="num fig">{n.value.toLocaleString("en-US")}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="note" style={{ marginTop: 10 }}>Anyone can run the watchtower with no key.</p>
    </section>
  );
}

function RoundsTable({ status, paused }: { status: TowerStatus; paused: boolean }) {
  const main = FEEDS[0]!;
  const rows = recentRounds(status, RECENT, main.feedId);
  // Rows that appear after the first render get a brief highlight.
  const seen = useRef<Set<string> | null>(null);
  const firstPaint = seen.current === null;
  if (firstPaint) seen.current = new Set(rows.map((r) => r.round));
  const isNew = (round: string) => !firstPaint && !seen.current!.has(round);
  const shown = (a: string, b: string) => rows.some((r) => BigInt(r.round) >= BigInt(a) && BigInt(r.round) <= BigInt(b));
  const unposted = unpostedRuns(status).filter(([a, b]) => shown(a, b));
  const out = (
    <>
      <div className="scroll">
        <table className="listing" aria-describedby="rounds-note">
          <thead>
            <tr><th>Round</th><th>Status</th><th className="num sym">{main.symbol}</th><th className="num">Reports</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => [
              <tr key={r.round} className={["link", r.status === "corrected" || r.disputed ? "flag" : "", isNew(r.round) ? "fresh" : ""].join(" ")}
                onClick={() => (location.hash = `#/round/${r.round}`)}>
                <td className="round"><a href={`#/round/${r.round}`}>{r.round}</a></td>
                <td><StatusMark status={r.status} />{r.disputed && <> <Mark kind="disputed">Disputed</Mark></>}</td>
                <td className="num">{r.price ? formatPrice(r.price) : "–"}</td>
                <td className="num">{r.reports}{r.leftOut ? <span className="bad"> ({r.leftOut} skipped)</span> : null}</td>
              </tr>,
              r.gap && <tr key={`gap${r.round}`} className="gap-row"><td colSpan={4}><PauseNote gap={r.gap} paused={paused} /></td></tr>,
            ])}
          </tbody>
        </table>
      </div>
      <p className="table-note" id="rounds-note">
        Status is PriceFeed's; prices are the medians the watchtower recomputed.
        {unposted.map(([a, b]) => ` ${a === b ? `Round ${a} was` : `Rounds ${a}–${b} were`} opened but never posted, so ${a === b ? "its" : "their"} reports count as skipped.`)}
      </p>
    </>
  );
  seen.current = new Set(rows.map((r) => r.round));
  return rows.length === 0 ? <Empty>No rounds replayed yet.</Empty> : out;
}

const shortUtc = (iso: string) => {
  const d = new Date(iso);
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(d)} ${
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(d)}`;
};

/**
 * "No rounds 36–505 (heights … to …, after 19 Nov 20:05 UTC)", plus "the loop was paused" only in the demo round mode,
 * where a jump in round numbers means no rounds ran. Heights and times come from the round files on either side of
 * the gap; a time is given only where that round's attestation carries one.
 */
function PauseNote({ gap, paused }: { gap: RoundGap; paused: boolean }) {
  const before = useData(() => api.round(gap.before), [gap.before]);
  const after = useData(() => api.round(gap.after), [gap.after]);
  const p = pauseSpan(before.data, after.data);
  const heights = p.fromHeight && p.toHeight ? `heights ${formatInt(p.fromHeight)} to ${formatInt(p.toHeight)}` : "";
  const times = p.fromTime && p.toTime ? `${shortUtc(p.fromTime)} – ${shortUtc(p.toTime)} UTC`
    : p.fromTime ? `after ${shortUtc(p.fromTime)} UTC` : p.toTime ? `until ${shortUtc(p.toTime)} UTC` : "";
  const detail = [heights, times].filter(Boolean).join(", ");
  return <>{gapLabel(gap)}{detail ? ` (${detail})` : ""}{paused ? ": the loop was paused" : ""}</>;
}
