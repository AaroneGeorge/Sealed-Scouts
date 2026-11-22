import { upheldRows } from "../lib/edition";
import { shortHash } from "../lib/format";
import type { AttackRun, TowerStatus } from "../lib/types";
import { Hash, Label, nativeTxUrl, utcStamp } from "./bits";

/** The watchtower's full record: every counter it keeps, each fraud proof the chain upheld, and its own challenges. */
export function Watchtower({ status: s, runs }: { status: TowerStatus; runs?: AttackRun[] }) {
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
