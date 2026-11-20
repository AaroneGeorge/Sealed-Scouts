import { useRef } from "react";
import { Empty, Hash, Label, StatusMark, nativeTxUrl, utcStamp } from "../components/bits";
import { PriceChart } from "../components/charts";
import { BatchCorrection, CorrectionFor, CorrectionsBox } from "../components/Corrections";
import { Explainer } from "../components/Explainer";
import { ReportsTable } from "../components/Reports";
import { api } from "../lib/api";
import {
  allFlagged, batchFraudOf, formatChange, gapLabel, gapMeansPause, leadOf, pauseSpan, replayNote, seriesOf, tickerOf, unpostedRuns, upheldRows,
  windowGaps,
  type RoundGap,
} from "../lib/edition";
import { bpsFrom, formatInt, formatPrice, shortHash } from "../lib/format";
import { newestRound, pipelineOf, usableDetail } from "../lib/pipeline";
import type { AttackRun, TowerRound, TowerStatus } from "../lib/types";
import { useData } from "../lib/useData";
import { FEEDS, displayStatus, roundStatus } from "../lib/view";

const USE_IT = `IPriceFeed feed = IPriceFeed(PRICE_FEED);
// Reverts unless the latest fETH round is final and at most 10 minutes old.
(uint128 price, uint64 round) = feed.readFinal(1, 600);`;

export function Rounds({ status, roundMode }: { status: TowerStatus; roundMode?: string }) {
  // One list of gaps for the chart and the table: from every replayed round, not one feed's points.
  const gaps = windowGaps(status);
  const paused = gapMeansPause(roundMode);
  const lead = leadOf(status);
  const newest = newestRound(status);
  const newestFile = useData(() => (newest ? api.round(newest.round) : Promise.resolve(undefined)), [newest?.round], 15_000);
  // The lead story is the newest settled round; it is usually the newest round too, and then one file serves both.
  const otherLead = lead.round && lead.round !== newest?.round ? lead.round : undefined;
  const otherLeadFile = useData(() => (otherLead ? api.round(otherLead) : Promise.resolve(undefined)), [otherLead]);
  const leadId = lead.round ?? newest?.round ?? "";
  const leadRound = usableDetail(leadId, otherLead ? otherLeadFile.data : newestFile.data);
  const pipeline = pipelineOf(newest, newestFile.data);

  // Attack evidence: challenge transactions for flagged rounds, and the bad-batch fraud proof.
  const runs = useData(api.attacks, []);
  const flagged = allFlagged(status, runs.data).slice(0, 2);
  const batchFraud = batchFraudOf(runs.data);

  const feeds = FEEDS.filter((f) => status.latestRounds.some((r) => r.medians.some((m) => m.feedId === f.feedId)));
  const [main, ...others] = feeds;
  const series = main ? seriesOf(status, main.feedId) : [];
  const first = status.latestRounds[0]?.round, last = newest?.round;
  const outside = flagged.filter((id) => !status.latestRounds.some((r) => r.round === id));
  const ticker = tickerOf(status);

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
              <div className="title">{main.symbol}, median by round <span>US dollars{first && last ? `, rounds ${first} to ${last}` : ""}</span></div>
              <PriceChart points={series} symbol={main.symbol} gaps={gaps} paused={paused} />
              {others.length > 0 && (
                <div className="multiples">
                  {others.map((f) => {
                    const t = ticker.find((x) => x.feedId === f.feedId);
                    return (
                      <div key={f.feedId}>
                        <div className="title">{f.symbol} {t && <span className="fig">{formatPrice(t.price)} {formatChange(t.changeBps)}</span>}</div>
                        <PriceChart points={seriesOf(status, f.feedId)} symbol={f.symbol} compact gaps={gaps} paused={paused} />
                      </div>
                    );
                  })}
                </div>
              )}
              <figcaption className="source">
                Source: the watchtower's replay of rollup {status.rollupId}, its ten most recent rounds; each point is the
                median of the opened reports.
                {series.some((p) => p.mark === "pending") && " Open circles: still pending on PriceFeed."}
                {series.length > 1 && gaps.filter((g) => BigInt(g.before) >= BigInt(series[0]!.round) && BigInt(g.after) <= BigInt(series[series.length - 1]!.round))
                  .map((g) => <span key={g.after}> <PauseNote gap={g} paused={paused} />.</span>)}
                {outside.length > 0 && ` Round ${outside.join(" and ")}, flagged by the watchtower, falls before this window: see ${flagged.length > 1 ? "the boxes" : "the box"} under Corrections.`}
              </figcaption>
            </figure>
          )}

          <div className="lead-cols">
            <section aria-labelledby="sealed-h">
              <Label id="sealed-h" aside={main && leadRound ? `Round ${leadRound.round}, ${main.symbol}` : undefined}>The sealed reports</Label>
              {leadRound && main ? (
                <>
                  <ReportsTable round={leadRound} feedId={main.feedId} median={leadRound.medians.find((m) => m.feedId === main.feedId)?.price} compact />
                  <p className="note" style={{ marginTop: 8 }}>
                    Each report is {formatInt(leadRound.reports[0]?.reportBytes ?? 0)} bytes of ML-KEM-1024 ciphertext until
                    the operator opens the round. A broken seal means the report has been opened and checked against its signed commitment.
                  </p>
                </>
              ) : <p className="note">{newestFile.loading || otherLeadFile.loading ? "Loading the round…" : "The round file is not available."}</p>}
            </section>
            <section aria-labelledby="anchor-h">
              <Label id="anchor-h">The anchor</Label>
              {leadRound ? <AnchorFacts r={leadRound} /> : <p className="note">No round to show yet.</p>}
            </section>
          </div>

          <section aria-labelledby="use-h" style={{ marginTop: 34 }}>
            <Label id="use-h" aside="Solidity, QoreChain EVM">Use the feed</Label>
            <pre className="code">{USE_IT}</pre>
            <p className="note" style={{ marginTop: 10 }}>
              A pending, disputed or stale round never reaches your contract: <code>readFinal</code> reverts instead.
            </p>
          </section>
        </article>

        <aside className="rail" aria-label="Corrections and the watchtower">
          {(flagged.length > 0 || batchFraud) && (
            <CorrectionsBox>
              {flagged.map((id) => <CorrectionFor key={id} id={id} runs={runs.data} mode={status.mode} />)}
              <BatchCorrection runs={runs.data} upheld={status.batches.upheld} />
            </CorrectionsBox>
          )}
          <Watchtower status={status} runs={runs.data} />
        </aside>
      </div>

      {pipeline && (
        <section aria-labelledby="how-h">
          <Label id="how-h" aside={`Each step as it stands for round ${pipeline.round}`}>How it works</Label>
          <Explainer p={pipeline} rollupId={status.rollupId} />
        </section>
      )}

      <section aria-labelledby="data-h">
        <Label id="data-h" aside={`Replayed by the watchtower to height ${formatInt(status.chainHeight)}. Select a round for every report.`}>Market data: rounds</Label>
        <RoundsTable status={status} paused={paused} />
      </section>
    </div>
  );
}

function AnchorFacts({ r }: { r: TowerRound }) {
  const sigBytes = r.anchorSig ? (r.anchorSig.length - 2) / 2 : undefined;
  const v = replayNote(r.feed?.status, r.verdict);
  return (
    <>
      <dl className="facts">
        <dt>Round</dt><dd>{r.round}, heights {formatInt(r.openHeight)} to {formatInt(r.closeHeight)}</dd>
        <dt>Batch</dt><dd>{r.feed?.batchIndex ?? "not posted"}</dd>
        <dt>PriceFeed</dt><dd><StatusMark status={roundStatus(r)} /></dd>
        {v && <><dt>Replay</dt><dd className={v.tone === "fail" ? "bad" : undefined}>{v.text}</dd></>}
        <dt>Round hash</dt><dd>{r.roundHash ? <Hash value={r.roundHash} keep={6} /> : "not in the feed yet"}</dd>
        <dt>Reports root</dt><dd><Hash value={r.reportsRoot} keep={6} /></dd>
        <dt>Signature</dt>
        <dd>{sigBytes ? `ML-DSA-87, ${formatInt(sigBytes)} bytes${r.twoSig ? " (anchor and round signatures)" : ""}` : "not in the feed yet"}</dd>
      </dl>
      <p className="note" style={{ marginTop: 12 }}>
        The round hash rides in the batch's signed anchor; PriceFeed rebuilds the bytes and checks the signature with pqcVerify.{" "}
        {r.feed && <a href={`#/round/${r.round}`}>Check this receipt on chain</a>}
      </p>
    </>
  );
}

function Watchtower({ status: s, runs }: { status: TowerStatus; runs?: AttackRun[] }) {
  const wrong = s.rounds.medianWrong + s.rounds.rootWrong;
  const proven = s.batches.upheldOnChain;
  const upheld = upheldRows(s.batches.upheld, runs);
  const rows: [string, number, boolean][] = [
    ["Rounds replayed", s.rounds.replayed, false],
    ["Batches replayed", s.batches.replayed, false],
    ["Rounds with a wrong median or root", wrong, wrong > 0],
    ["Rounds corrected on PriceFeed", s.rounds.corrected, s.rounds.corrected > 0],
    // Older feeds lack the chain's count; then the row is left out rather than shown as 0.
    ...(proven !== undefined ? [["Wrong ledger roots proven on chain", proven, proven > 0] as [string, number, boolean]] : []),
    ["Fraud in a batch still standing", s.batches.fraud, s.batches.fraud > 0],
    ["Reports the operator skipped", s.operatorOmissions, s.operatorOmissions > 0],
    ["Challenges sent this session", s.challenges.filter((c) => c.sent).length, false],
  ];
  return (
    <section aria-labelledby="tower-h">
      <Label id="tower-h" aside={`${s.mode} mode, ${utcStamp(s.updatedAt)}`}>Watchtower</Label>
      <table className="desk">
        <tbody>
          {rows.map(([k, v, alert]) => (
            <tr key={k} className={alert ? "alert" : undefined}><td>{k}</td><td className="num fig">{v.toLocaleString("en-US")}</td></tr>
          ))}
        </tbody>
      </table>
      {upheld.length > 0 && (
        <ul className="note" style={{ margin: "10px 0 0", paddingLeft: 16 }}>
          {upheld.map((u) => (
            <li key={u.txHash}>
              {u.ours === undefined ? (
                // No counted run to compare with: name the challenger, claim nothing about whose it was.
                <>Batch {u.batchIndex}, proven by challenger <span className="mono">{shortHash(u.challenger, 6)}</span></>
              ) : (
                <>
                  Batch {u.batchIndex}, proven by <b style={{ fontWeight: u.ours ? 700 : 400 }}>{u.who}</b>
                  {u.ours ? "" : <> (<span className="mono">{shortHash(u.challenger, 6)}</span>)</>}
                </>
              )}, {utcStamp(u.time)}: <Hash value={u.txHash} keep={5} href={nativeTxUrl(u.txHash)} />
              {u.ours === false && <span className="muted">; not counted as ours</span>}
            </li>
          ))}
        </ul>
      )}
      {s.challenges.length > 0 && (
        <ul className="note" style={{ margin: "10px 0 0", paddingLeft: 16 }}>
          {s.challenges.map((c) => (
            <li key={c.target + c.at}>
              {c.target}, {c.kind} challenge: {c.sent ? "sent" : c.error ? "not confirmed" : `ready, not sent${s.mode === "observe" ? " (observe mode sends nothing)" : ""}`}
            </li>
          ))}
        </ul>
      )}
      <p className="note" style={{ marginTop: 10 }}>Anyone can run the watchtower with no key: it replays the rollup ledger and every round from chain data.</p>
    </section>
  );
}

function RoundsTable({ status, paused }: { status: TowerStatus; paused: boolean }) {
  const feeds = FEEDS.filter((f) => status.latestRounds.some((r) => r.medians.some((m) => m.feedId === f.feedId)));
  const main = feeds[0];
  const ordered = status.latestRounds;
  // Rows that appear after the first render get a brief highlight.
  const seen = useRef<Set<string> | null>(null);
  const firstPaint = seen.current === null;
  if (firstPaint) seen.current = new Set(ordered.map((r) => r.round));
  const isNew = (round: string) => !firstPaint && !seen.current!.has(round);
  const rows = [...ordered].reverse();
  const gaps = windowGaps(status);
  const unposted = unpostedRuns(status);
  const columns = 5 + feeds.length;
  const out = (
    <>
    <div className="scroll">
      <table className="listing" aria-describedby="rounds-note">
        <thead>
          <tr>
            <th>Round</th><th>Status</th><th>Replay</th>
            {feeds.map((f, i) => [
              <th key={f.feedId} className="num sym">{f.symbol}</th>,
              i === 0 && <th key="chg" className="num">Chg</th>,
            ])}
            <th className="num">Reports</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const st = displayStatus(r.feedStatus, r.verdict);
            const note = replayNote(r.feedStatus, r.verdict);
            const prev = rows[i + 1];
            // A change across a pause would compare prices hours apart, so the column is left empty there.
            const gap = gaps.find((g) => g.after === r.round);
            const mNow = main && r.medians.find((m) => m.feedId === main.feedId);
            const mPrev = main && !gap ? prev?.medians.find((m) => m.feedId === main.feedId) : undefined;
            const flag = st === "corrected" || r.verdict === "median-wrong" || r.verdict === "root-wrong";
            return [
              <tr key={r.round} className={["link", flag ? "flag" : "", isNew(r.round) ? "fresh" : ""].join(" ")} onClick={() => (location.hash = `#/round/${r.round}`)}>
                <td className="round"><a href={`#/round/${r.round}`}>{r.round}</a></td>
                <td><StatusMark status={st} /></td>
                <td className={note?.tone === "fail" ? "bad" : undefined}>{note ? note.text : <span className="muted">see the correction</span>}</td>
                {feeds.map((f, fi) => {
                  const m = r.medians.find((x) => x.feedId === f.feedId);
                  const cell = <td key={f.feedId} className="num">{m ? formatPrice(m.price) : "–"}</td>;
                  if (fi !== 0) return cell;
                  const chg = mNow && mPrev ? formatChange(bpsFrom(mNow.price, mPrev.price)) : "";
                  return [cell, <td key="chg" className="num chg">{chg}</td>];
                })}
                <td className="num">{r.reports}{r.leftOut ? <span className="bad"> ({r.leftOut} skipped)</span> : null}</td>
              </tr>,
              gap && <tr key={`gap${r.round}`} className="gap-row"><td colSpan={columns}><PauseNote gap={gap} paused={paused} /></td></tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
    <p className="table-note" id="rounds-note">
      Status is PriceFeed's view of the round; replay is what the watchtower found when it recomputed the round from the inbox.
      Prices are the replayed medians, which can differ from PriceFeed's while a round is disputed; the round page shows both.
      {main ? ` Chg is ${main.symbol} against the round before.` : ""}
      {unposted.map(([a, b]) => ` ${a === b ? `Round ${a} was` : `Rounds ${a}–${b} were`} opened and replayed but never posted to PriceFeed, and later rounds were, so ${a === b ? "it" : "they"} will not be; ${a === b ? "its" : "their"} reports count as skipped.`)}
    </p>
    </>
  );
  seen.current = new Set(ordered.map((r) => r.round));
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

