import { useState } from "react";
import { Empty, Hash, Label, StatusMark } from "../components/bits";
import { BandChart } from "../components/charts";
import { CorrectionBox } from "../components/Corrections";
import { ReportsTable } from "../components/Reports";
import { VerifyPanel } from "../components/VerifyPanel";
import { api } from "../lib/api";
import { correctionOf, replayNote, roundHeadline, spell } from "../lib/edition";
import { formatInt, formatPrice } from "../lib/format";
import type { Hex } from "../lib/types";
import { useData } from "../lib/useData";
import { FEEDS, roundStatus, symbolOf } from "../lib/view";

export function Round({ id, rollupId, priceFeed, mode }: { id: string; rollupId: string; priceFeed: Hex | null; mode?: string }) {
  const { data: r, error, missing, loading } = useData(() => api.round(id), [id], 15_000);
  const [feedId, setFeedId] = useState(1);
  const needsRuns = !!r && r.verdict !== "unknown" && !!correctionOf(r);
  const runs = useData(() => (needsRuns ? api.attacks() : Promise.resolve([])), [needsRuns]);
  const back = <a href="#/" className="back">← Front page</a>;

  if (loading && !r) return <>{back}<Empty>Loading round {id}…</Empty></>;
  if (!r) return <>{back}<Empty>{missing ? `Round ${id} is not in the feed.` : `Could not load round ${id}: ${error}`}</Empty></>;
  // The watchtower publishes a bare {round, verdict: "unknown", error} when it could not read the chain for a round.
  if (r.verdict === "unknown") return <>{back}<Empty>Round {id}: the watchtower could not read the chain for this round and will retry. {(r as { error?: string }).error}</Empty></>;

  const feeds = FEEDS.filter((f) => r.medians.some((m) => m.feedId === f.feedId));
  const median = r.medians.find((m) => m.feedId === feedId)?.price;
  const feedIndex = r.leaves[0]?.feedIds.indexOf(feedId) ?? -1;
  const inBand = new Set(r.inBand.map((a) => a.toLowerCase() as Hex));
  const note = replayNote(r.feed?.status, r.verdict);
  const sigBytes = r.anchorSig ? (r.anchorSig.length - 2) / 2 : undefined;
  return (
    <div className="stack" style={{ gap: 40 }}>
      <header>
        {back}
        <span className="kicker">Round {r.round} · rollup {rollupId}{r.feed ? ` · batch ${r.feed.batchIndex}` : ""}</span>
        <h1 className="headline sm">{roundHeadline(r)}</h1>
        <p className="deck">
          {cap(spell(r.reports.length))} scout{r.reports.length === 1 ? "" : "s"} posted a sealed price; {spell(r.leaves.length)} counted,{" "}
          {spell(r.inBand.length)} within 2% of the median, {r.outliers.length ? spell(r.outliers.length) : "none"} outside.
        </p>
        <p className="byline">
          PriceFeed status: <StatusMark status={roundStatus(r)} />
          {note && <> · Watchtower replay: <span className={note.tone === "fail" ? "bad" : undefined}>{note.text}</span></>}
        </p>
      </header>

      <CorrectionBox round={r} runs={runs.data} mode={mode} />

      <section aria-labelledby="reports-h">
        <Label id="reports-h" aside="One dot per opened report">The reports</Label>
        <div className="tabs" role="tablist" aria-label="Feed">
          {feeds.map((f) => (
            <button key={f.feedId} role="tab" aria-selected={f.feedId === feedId} onClick={() => setFeedId(f.feedId)}>{f.symbol}</button>
          ))}
        </div>
        {median && feedIndex >= 0 ? (
          <>
            <p className="note">
              Median <b className="fig">{formatPrice(median)}</b> from {r.medians.find((m) => m.feedId === feedId)?.count} reports. Shaded: within 2%
              (earns a reward). Hatched: beyond 10% (can be slashed).
            </p>
            <BandChart leaves={r.leaves} inBand={inBand} feedIndex={feedIndex} median={median} />
          </>
        ) : <p className="note">No median for this feed in this round.</p>}
        <div style={{ marginTop: 18 }}>
          <ReportsTable round={r} feedId={feedId} median={median} />
        </div>
        <details style={{ marginTop: 10 }}>
          <summary>Show details</summary>
          <p className="note">
            Each report is {formatInt(r.reports[0]?.reportBytes ?? 0)} bytes of ML-KEM-1024 ciphertext until the operator opens
            the round. A broken seal means the report has been opened and checked against its signed commitment.
          </p>
        </details>
        {r.rejected.length > 0 && (
          <ul className="note" style={{ marginTop: 12, paddingLeft: 16 }}>
            {r.rejected.map((x) => <li key={x.scout + x.reason}><code>{x.scout}</code>: <span className="bad">{x.reason}</span></li>)}
          </ul>
        )}
      </section>

      <section aria-labelledby="anchor-h">
        <Label id="anchor-h" aside="What ties this price to the chain">The anchor</Label>
        <dl className="facts">
          <dt>Heights</dt><dd>{formatInt(r.openHeight)} to {formatInt(r.closeHeight)}</dd>
          <dt>Batch</dt><dd>{r.feed?.batchIndex ?? "not posted"}</dd>
          <dt>Round hash</dt><dd>{r.roundHash ? <Hash value={r.roundHash} keep={8} /> : "not in the feed yet"}</dd>
          <dt>Reports root</dt><dd><Hash value={r.reportsRoot} keep={8} /></dd>
          <dt>Signature</dt>
          <dd>{sigBytes ? `ML-DSA-87, ${formatInt(sigBytes)} bytes${r.twoSig ? " (anchor and round signatures)" : ""}` : "not in the feed yet"}</dd>
          <dt>Opened on time</dt><dd>{r.operator.openPosted ? "yes" : <span className="bad">no</span>}</dd>
          <dt>Left out</dt>
          <dd>{r.operator.leftOut.length === 0 ? "none" : r.operator.leftOut.map((l) => (
            <div key={l.scout}><code>{l.scout.slice(0, 12)}…</code> {l.how === "revealed" ? "self-revealed, still counted" : <span className="bad">lost</span>}</div>
          ))}</dd>
        </dl>
        <details style={{ marginTop: 12 }}>
          <summary>Show details</summary>
          <p className="note">
            The round hash rides in the batch's signed anchor; PriceFeed rebuilds the bytes and checks the ML-DSA-87
            signature with pqcVerify. Each opening is checked against its commitment.
          </p>
        </details>
      </section>

      <details>
        <summary>Show the replay against PriceFeed and every inbox post</summary>
        <div className="cols-2 ruled" style={{ marginTop: 8 }}>
          <section aria-labelledby="replay-h">
            <Label id="replay-h" aside="What the chain holds against what the inbox says">Replay against PriceFeed</Label>
            {r.feed ? (
              <div className="scroll">
                <table className="listing">
                  <thead><tr><th>Feed</th><th className="num">Replayed</th><th className="num">On PriceFeed</th></tr></thead>
                  <tbody>
                    {r.medians.map((m) => {
                      const i = r.feed!.feedIds.indexOf(m.feedId);
                      const onChain = i >= 0 ? r.feed!.medians[i] : undefined;
                      return (
                        <tr key={m.feedId}>
                          <td>{symbolOf(m.feedId)}</td>
                          <td className="num">{formatPrice(m.price)}</td>
                          <td className={`num ${onChain !== m.price ? "bad" : ""}`}>{onChain ? formatPrice(onChain) : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="note">Not posted to PriceFeed.</p>}
          </section>
          <section aria-labelledby="inbox-h">
            <Label id="inbox-h" aside="Sizes are public; contents stay sealed until close">Inbox posts</Label>
            <div className="scroll">
              <table className="listing">
                <thead><tr><th>Scout</th><th className="num">Height</th><th className="num">REPORT bytes</th><th className="num">COMMIT bytes</th><th>Counted</th></tr></thead>
                <tbody>
                  {r.reports.map((p) => (
                    <tr key={p.scout}>
                      <td><Hash value={p.scout} keep={5} /></td>
                      <td className="num">{formatInt(p.height)}</td>
                      <td className="num">{formatInt(p.reportBytes)}</td>
                      <td className="num">{formatInt(p.commitBytes)}</td>
                      <td>{p.counted ? "yes" : <span className="bad">no</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </details>

      <section aria-labelledby="receipt-h">
        <Label id="receipt-h" aside="Checked against the chain from your browser">Check the receipt yourself</Label>
        {r.feed ? (
          <VerifyPanel
            input={{ rollupId, batchIndex: BigInt(r.feed.batchIndex), round: { round: BigInt(r.round), roundHash: r.roundHash, attestation: r.attestation, priceFeed, twoSig: r.twoSig, anchorSig: r.anchorSig } }}
            note={`Batch ${r.feed.batchIndex}: six checks against the chain, then two that tie this price round to it.`}
          />
        ) : (
          <p className="note">This round has no batch on PriceFeed{r.verdict === "no-quorum" ? ": too few valid reports, so nothing is posted." : " yet."}</p>
        )}
      </section>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
