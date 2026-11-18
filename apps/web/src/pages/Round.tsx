import { useState } from "react";
import { BandChart } from "../components/charts";
import { Empty, Hash, Pill, StatusPill } from "../components/bits";
import { ScoutTiles } from "../components/ScoutTiles";
import { VerifyPanel } from "../components/VerifyPanel";
import { api } from "../lib/api";
import { formatInt, formatPrice } from "../lib/format";
import type { Hex } from "../lib/types";
import { useData } from "../lib/useData";
import { FEEDS, VERDICT, roundStatus, symbolOf } from "../lib/view";

export function Round({ id, rollupId, priceFeed }: { id: string; rollupId: string; priceFeed: Hex | null }) {
  const { data: r, error, missing, loading } = useData(() => api.round(id), [id], 15_000);
  const [feedId, setFeedId] = useState(1);
  if (loading && !r) return <Empty>Loading round {id}…</Empty>;
  if (!r) return <Empty>{missing ? `Round ${id} is not in the feed.` : `Could not load round ${id}: ${error}`}</Empty>;

  const feeds = FEEDS.filter((f) => r.medians.some((m) => m.feedId === f.feedId));
  const median = r.medians.find((m) => m.feedId === feedId)?.price;
  const feedIndex = r.leaves[0]?.feedIds.indexOf(feedId) ?? -1;
  const inBand = new Set(r.inBand.map((a) => a.toLowerCase() as Hex));
  const v = VERDICT[r.verdict];
  return (
    <div className="stack">
      <a href="#/" className="small muted">← All rounds</a>
      <section className="hero">
        <span className="eyebrow">Round · {rollupId}</span>
        <div className="row"><h1>Round {r.round}</h1><StatusPill status={roundStatus(r)} /><Pill kind={v.tone}>{v.text}</Pill></div>
        <p>
          Reports were accepted from height {formatInt(r.openHeight)} to {formatInt(r.closeHeight)}. {r.reports.length} scouts
          posted; {r.leaves.length} reports counted, {r.inBand.length} in band, {r.outliers.length} outside.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Reports</h2>
          <div className="row" role="tablist">
            {feeds.map((f) => (
              <button key={f.feedId} role="tab" aria-selected={f.feedId === feedId} className="btn"
                style={f.feedId === feedId ? { borderColor: "var(--brass)" } : undefined} onClick={() => setFeedId(f.feedId)}>
                {f.symbol}
              </button>
            ))}
          </div>
        </div>
        {median && feedIndex >= 0 ? (
          <>
            <p className="muted small">Median <b className="mono">{formatPrice(median)}</b> from {r.medians.find((m) => m.feedId === feedId)?.count} reports. Green band: ±2%. Red edges: beyond ±10%, slashable.</p>
            <BandChart leaves={r.leaves} inBand={inBand} feedIndex={feedIndex} median={median} />
          </>
        ) : (
          <p className="muted small">No median for this feed in this round.</p>
        )}
        <div style={{ marginTop: 14 }}>
          <ScoutTiles round={r} feedId={feedId} median={median} />
        </div>
        {r.rejected.length > 0 && (
          <ul className="small" style={{ marginTop: 12 }}>
            {r.rejected.map((x) => <li key={x.scout + x.reason}><code>{x.scout}</code>: <span className="err">{x.reason}</span></li>)}
          </ul>
        )}
      </section>

      <section className="grid cols-2">
        <div className="panel">
          <div className="panel-head"><h2>Replay against PriceFeed</h2><span className="hint">What the chain holds vs. what the inbox says</span></div>
          {r.feed ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Feed</th><th className="num">Replayed</th><th className="num">On PriceFeed</th></tr></thead>
                <tbody>
                  {r.medians.map((m) => {
                    const i = r.feed!.feedIds.indexOf(m.feedId);
                    const onChain = i >= 0 ? r.feed!.medians[i] : undefined;
                    return (
                      <tr key={m.feedId}>
                        <td>{symbolOf(m.feedId)}</td>
                        <td className="num">{formatPrice(m.price)}</td>
                        <td className={`num ${onChain !== m.price ? "diff" : ""}`}>{onChain ? formatPrice(onChain) : "·"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="muted small">Not posted to PriceFeed.</p>}
          {r.challenges.map((c) => (
            <p key={c.at} className="small" style={{ marginTop: 10 }}>
              {c.kind} challenge {c.sent ? "sent" : "ready"}{c.txHash ? <> · <Hash value={c.txHash} keep={8} /></> : null}{c.error ? <span className="err"> · {c.error}</span> : null}
            </p>
          ))}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Operator</h2><span className="hint">Opening is checked against each commitment</span></div>
          <dl className="kv">
            <dt>OPEN posted</dt><dd>{r.operator.openPosted ? "yes, in the open window" : <span className="err">no</span>}</dd>
            <dt>Reports root</dt><dd><Hash value={r.reportsRoot} keep={8} /></dd>
            <dt>Left out</dt>
            <dd>{r.operator.leftOut.length === 0 ? "none" : r.operator.leftOut.map((l) => (
              <div key={l.scout}><code>{l.scout.slice(0, 12)}…</code> {l.how === "revealed" ? "self-revealed, still counted" : <span className="err">lost</span>}</div>
            ))}</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Inbox posts</h2><span className="hint">Ordered and stamped by QoreChain. Sizes are public; contents stay sealed until close.</span></div>
        <div className="table-wrap">
          <table className="table cards dense">
            <thead><tr><th>Scout</th><th className="num">Height</th><th className="num">REPORT bytes</th><th className="num">COMMIT bytes</th><th>Counted</th></tr></thead>
            <tbody>
              {r.reports.map((p) => (
                <tr key={p.scout}>
                  <td data-label="Scout"><Hash value={p.scout} keep={5} /></td>
                  <td data-label="Height" className="num">{formatInt(p.height)}</td>
                  <td data-label="REPORT" className="num">{formatInt(p.reportBytes)}</td>
                  <td data-label="COMMIT" className="num">{formatInt(p.commitBytes)}</td>
                  <td data-label="Counted">{p.counted ? "yes" : <span className="err">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Settlement receipt</h2><span className="hint">The batch that carries this round, checked against the chain</span></div>
        {r.feed ? (
          <VerifyPanel
            input={{ rollupId, batchIndex: BigInt(r.feed.batchIndex), round: { roundHash: r.roundHash, attestation: r.attestation, priceFeed } }}
            note={`Batch ${r.feed.batchIndex}. Six receipt checks against chain state, then two that bind this price round: the anchor's slot holds the round hash, and PriceFeed.verifyReceipt agrees.`}
          />
        ) : (
          <p className="muted small">This round has no batch on PriceFeed{r.verdict === "no-quorum" ? ": too few valid reports, so nothing is posted." : " yet."}</p>
        )}
      </section>
    </div>
  );
}
