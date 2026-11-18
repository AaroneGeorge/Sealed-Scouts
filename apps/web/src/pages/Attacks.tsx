import { Empty } from "../components/bits";
import { api } from "../lib/api";
import type { AttackStep } from "../lib/types";
import { useData } from "../lib/useData";

const TONE: Record<AttackStep["verdict"], string> = { REFUSED: "var(--pass)", ACCEPTED: "var(--pending)", "NOT REFUSED": "var(--fail)" };

export function Attacks() {
  const { data, error, missing, loading } = useData(api.attacks, []);
  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Threat model, replayed</span>
        <h1>Every attack, and what stopped it.</h1>
        <p>
          Each live run is sent to the QoreChain testnet; its refusals are the chain's and the contracts' own answers, with
          error codes and transaction hashes. Dry runs and the classical-oracle comparison run locally and say so.
        </p>
      </section>
      {loading && !data ? <Empty>Loading evidence…</Empty> : !data || data.length === 0 ? (
        <Empty>{missing || data?.length === 0 ? "No attack runs recorded yet." : `Could not load evidence: ${error}`}</Empty>
      ) : data.map((run) => (
        <section key={run.name + run.at} className="panel attack">
          <div className="panel-head">
            <h2>{run.name}</h2>
            <div className="row">
              {!/^Live/i.test(run.note) && <span className="sim">not a testnet run</span>}
              <span className="hint">{new Date(run.at).toLocaleString()}</span>
            </div>
          </div>
          <p className="threat">{run.note}</p>
          <ol className="steps">
            {run.steps.map((s, i) => (
              <li key={i} className={s.verdict === "REFUSED" ? "refused" : s.verdict === "ACCEPTED" ? "accepted" : "failed"}>
                <div>
                  <div className="layer">{s.where}</div>
                  <div className="result" style={{ color: TONE[s.verdict] }}>{s.verdict}</div>
                </div>
                <div>
                  <div><b>{s.attack}</b>: {s.step}</div>
                  <div className="row small mono" style={{ marginTop: 4 }}>
                    {Object.entries(s.evidence).map(([k, v]) => <span key={k} className="muted" style={{ overflowWrap: "anywhere" }}>{k}={String(v)}</span>)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
