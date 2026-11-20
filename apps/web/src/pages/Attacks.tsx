import { Empty, Label, nativeTxUrl, utcStamp } from "../components/bits";
import { api } from "../lib/api";
import { runCounts } from "../lib/edition";
import { attackTally, isLiveRun } from "../lib/pipeline";
import type { AttackRun, AttackStep } from "../lib/types";
import { useData } from "../lib/useData";

const RESULT: Record<AttackStep["verdict"], { word: string; kind: string }> = {
  REFUSED: { word: "Refused", kind: "pass" },
  ACCEPTED: { word: "Setup step", kind: "wait" },
  "NOT REFUSED": { word: "Not refused", kind: "fail" },
};

const title = (name: string) => name.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function Attacks() {
  const { data, error, missing, loading } = useData(api.attacks, []);
  const runs = data ?? [];
  // Counted live runs lead; a run someone else's challenge won sits right under the counted run of the same attack.
  const allLive = runs.filter(isLiveRun);
  const counted = allLive.filter(runCounts);
  const uncounted = allLive.filter((r) => !runCounts(r));
  const live = counted.flatMap((c) => [c, ...uncounted.filter((u) => u.steps[0]?.attack.startsWith(c.name) || u.name.startsWith(c.name))]);
  live.push(...uncounted.filter((u) => !live.includes(u)));
  const dry = runs.filter((r) => !isLiveRun(r));
  return (
    <div className="stack" style={{ gap: 40 }}>
      <header>
        <span className="kicker">Incident reports</span>
        <h1 className="headline sm">Every attack on record, and what refused it</h1>
        <p className="deck">
          Each live run is sent to the QoreChain testnet; its refusals are the chain's and the contracts' own answers, with
          error codes and transaction hashes. Dry runs and the classical-oracle comparison run locally and say so.
        </p>
      </header>
      {loading && !data ? <Empty>Loading evidence…</Empty> : !data || data.length === 0 ? (
        <Empty>{missing || data?.length === 0 ? "No attack runs recorded yet." : `Could not load evidence: ${error}`}</Empty>
      ) : (
        <>
          {live.length > 0 && (
            <section aria-labelledby="live-h">
              <Label id="live-h" aside="Transactions on qorechain-diana">Live on the testnet</Label>
              {live.map((run, i) => <Incident key={`${run.name}-${run.at}-${i}`} run={run} />)}
            </section>
          )}
          {dry.length > 0 && (
            <details className="dry-runs">
              <summary>Dry runs: local checks, no chain transactions ({dry.length} file{dry.length === 1 ? "" : "s"})</summary>
              {dry.map((run, i) => <Incident key={`${run.name}-${run.at}-${i}`} run={run} />)}
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Incident({ run }: { run: AttackRun }) {
  const t = attackTally(run);
  const liveRun = isLiveRun(run);
  const counts = !liveRun || runCounts(run);
  return (
    <article className={`incident ${counts ? "" : "uncounted"}`}>
      <header>
        <h3>{title(run.name)}</h3>
        <div className="filed">
          Filed {utcStamp(run.at)} · {liveRun ? "Live testnet run (qorechain-diana)." : <span className="dry">Not a testnet run.</span>}
        </div>
        <div className="score">
          {counts ? (
            <>
              <b className={t.notRefused ? "bad" : undefined}>{t.refused} of {t.attempts}</b>
              <span>attempts refused{t.setup ? `; ${t.setup} setup step${t.setup === 1 ? "" : "s"}` : ""}</span>
            </>
          ) : (
            <>
              <b className="bad">Not counted</b>
              <span>another challenger acted first</span>
            </>
          )}
        </div>
      </header>
      {(!liveRun || !counts) && <p className="note" style={{ maxWidth: "var(--measure)" }}>{liveRun ? run.note.replace(/^Live testnet run \([^)]*\)\.\s*/, "") : run.note}</p>}
      <div className="scroll">
        <table className="listing stacked">
          <thead><tr><th className="num">#</th><th>Attempt</th><th>Where</th><th>Result</th></tr></thead>
          <tbody>
            {run.steps.map((s, i) => {
              // In a run that does not count, the refusal is real but it was not ours: say whose it was.
              const theirs = !counts && s.verdict === "REFUSED";
              return (
                <tr key={i}>
                  <td className="num muted">{i + 1}</td>
                  <td className="wrap">
                    <div>{s.attack === run.name ? s.step : <><b>{s.attack}</b>: {s.step}</>}</div>
                    <Evidence e={s.evidence} />
                  </td>
                  <td><span className="layer">{s.where}</span></td>
                  <td>{theirs
                    ? <span className="st wait">Refused, not by us</span>
                    : <span className={`st ${RESULT[s.verdict].kind}`}>{RESULT[s.verdict].word}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

const NATIVE_TX = /^[0-9A-Fa-f]{64}$/;

/** The evidence fields as recorded; a native transaction hash links to its JSON on the public REST endpoint. */
function Evidence({ e }: { e: AttackStep["evidence"] }) {
  const entries = Object.entries(e);
  if (entries.length === 0) return null;
  return (
    <div className="evidence">
      {entries.map(([k, v]) => (
        <span key={k}>
          {k}={(k === "txHash" || k === "challengeTx") && typeof v === "string" && NATIVE_TX.test(v)
            ? <a href={nativeTxUrl(v)} target="_blank" rel="noreferrer">{v.slice(0, 10)}…{v.slice(-8)}</a>
            : String(v)}
        </span>
      ))}
    </div>
  );
}
