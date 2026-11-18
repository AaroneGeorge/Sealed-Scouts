import { Sparkline } from "../components/charts";
import { Empty, Pill, StatusPill } from "../components/bits";
import { formatInt, formatPrice } from "../lib/format";
import type { TowerStatus } from "../lib/types";
import { FEEDS, VERDICT, displayStatus, latestPrices, symbolOf } from "../lib/view";

const USE_IT = `IPriceFeed feed = IPriceFeed(PRICE_FEED);
// Reverts unless the latest fETH round is final and at most 10 minutes old.
(uint128 price, uint64 round) = feed.readFinal(1, 600);`;

export function Rounds({ status }: { status: TowerStatus }) {
  const feeds = FEEDS.filter((f) => status.latestRounds.some((r) => r.medians.some((m) => m.feedId === f.feedId)));
  const history = (feedId: number) =>
    status.latestRounds.flatMap((r) => r.medians.filter((m) => m.feedId === feedId).map((m) => BigInt(m.price)));
  const prices = latestPrices(status);
  const rounds = [...status.latestRounds].reverse();
  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Post-quantum price oracle · QoreChain testnet</span>
        <h1>Prices a quantum attacker can't forge and a lazy reporter can't copy.</h1>
        <p>
          Scouts seal each report with ML-KEM-1024. A rollup on QoreChain orders the reports and takes the median. Every
          batch is signed with ML-DSA-87, and the feed contract checks that same signature on chain before it trusts a price.
        </p>
      </section>

      {prices.length > 0 && (
        <section className="grid cols-3">
          {prices.map((p) => (
            <div key={p.feedId} className="panel price-card">
              <Sparkline values={history(p.feedId)} />
              <div className="sym">{symbolOf(p.feedId)}</div>
              <div className="px">${formatPrice(p.price)}</div>
              <div className="meta">
                <StatusPill status={p.status} />
                <span>round {p.round}</span>
                <span>{p.count} reports</span>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Rounds</h2>
          <span className="hint">Replayed by the watchtower up to height {formatInt(status.chainHeight)}. Tap a round to see every report.</span>
        </div>
        {rounds.length === 0 ? <Empty>No rounds replayed yet.</Empty> : (
          <div className="table-wrap">
            <table className="table cards">
              <thead>
                <tr><th>Round</th><th>Feed status</th><th>Replay</th>{feeds.map((f) => <th key={f.feedId} className="num">{f.symbol}</th>)}<th className="num">Reports</th></tr>
              </thead>
              <tbody>
                {rounds.map((r) => (
                  <tr key={r.round} className="link" onClick={() => (location.hash = `#/round/${r.round}`)}>
                    <td data-label="Round"><a href={`#/round/${r.round}`} className="mono">#{r.round}</a></td>
                    <td data-label="Feed status"><StatusPill status={displayStatus(r.feedStatus, r.verdict)} /></td>
                    <td data-label="Replay"><Pill kind={VERDICT[r.verdict].tone}>{VERDICT[r.verdict].text}</Pill></td>
                    {feeds.map((f) => {
                      const m = r.medians.find((x) => x.feedId === f.feedId);
                      return <td key={f.feedId} data-label={f.symbol} className="num">{m ? formatPrice(m.price) : "·"}</td>;
                    })}
                    <td data-label="Reports" className="num">{r.reports}{r.leftOut ? <span className="err"> · {r.leftOut} skipped</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="grid cols-2">
        <Watchtower status={status} />
        <div className="panel">
          <div className="panel-head"><h2>Use the feed</h2><span className="hint">Solidity, QoreChain EVM</span></div>
          <pre className="code">{USE_IT}</pre>
          <p className="muted small" style={{ marginTop: 12 }}>
            A pending, disputed or stale round never reaches your contract: <code>readFinal</code> reverts instead.
          </p>
        </div>
      </section>
    </div>
  );
}

function Watchtower({ status: s }: { status: TowerStatus }) {
  const wrong = s.rounds.medianWrong + s.rounds.rootWrong;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Watchtower</h2>
        <span className="hint">{s.mode} mode · updated {new Date(s.updatedAt).toLocaleTimeString()}</span>
      </div>
      <div className="stats">
        <div className="stat"><b>{s.batches.replayed}</b><span>batches replayed</span></div>
        <div className={`stat ${s.batches.fraud ? "alert" : ""}`}><b>{s.batches.fraud}</b><span>wrong ledger roots</span></div>
        <div className="stat"><b>{s.rounds.replayed}</b><span>rounds replayed</span></div>
        <div className={`stat ${wrong ? "alert" : ""}`}><b>{wrong}</b><span>wrong rounds</span></div>
        <div className="stat"><b>{s.challenges.filter((c) => c.sent).length}</b><span>challenges sent</span></div>
        <div className={`stat ${s.operatorOmissions ? "alert" : ""}`}><b>{s.operatorOmissions}</b><span>reports the operator skipped</span></div>
      </div>
      {s.challenges.length > 0 && (
        <ul className="small" style={{ margin: "12px 0 0", paddingLeft: 18 }}>
          {s.challenges.map((c) => (
            <li key={c.target + c.at}>
              {c.target}: {c.kind} challenge {c.sent ? <>sent{c.txHash ? <> · <code>{c.txHash.slice(0, 12)}…</code></> : null}</> : c.error ? <span className="err">failed</span> : <span className="muted">ready (observe mode sends nothing)</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small" style={{ marginTop: 12 }}>
        Anyone can run the watchtower with no key: it replays the rollup ledger and every round from chain data.
      </p>
    </div>
  );
}
