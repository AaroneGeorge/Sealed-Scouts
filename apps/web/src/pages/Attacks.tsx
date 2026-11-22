import type { ReactNode } from "react";
import { Empty, Hash, Label, nativeTxUrl, utcStamp } from "../components/bits";
import {
  BatchCorrection, BatchFigures, CorrectionFigures, CorrectionFor, CorrectionsBox, RoundCorrection, useBatchProof,
} from "../components/Corrections";
import { Watchtower } from "../components/Watchtower";
import { api } from "../lib/api";
import { allFlagged, batchFraudOf, correctionOf, formatQor, liveRunOf, medianChallengeOf, runCounts, spell } from "../lib/edition";
import { attackTally, isLiveRun } from "../lib/pipeline";
import { useAnchor } from "../lib/router";
import type { AttackRun, AttackStep, TowerRound, TowerStatus } from "../lib/types";
import { useData } from "../lib/useData";
import { symbolOf } from "../lib/view";

const RESULT: Record<AttackStep["verdict"], { word: string; kind: string }> = {
  REFUSED: { word: "Refused", kind: "pass" },
  ACCEPTED: { word: "Setup step", kind: "wait" },
  "NOT REFUSED": { word: "Not refused", kind: "fail" },
};

const title = (name: string) => name.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const NATIVE_TX = /^[0-9A-Fa-f]{64}$/;

/** The bad-batch card's run: the one its fraud proof comes from, else the newest counted run by that name. */
const batchRunOf = (runs: AttackRun[]) => {
  const f = batchFraudOf(runs);
  return (f && runs.find((r) => r.name === f.run && r.at === f.at)) || liveRunOf(runs, "bad-batch");
};

export function Attacks({ status, anchor }: { status?: TowerStatus; anchor?: string }) {
  const { data, error, missing, loading } = useData(api.attacks, []);
  const runs = data ?? [];
  const median = medianChallengeOf(data);
  // The median card's round file is loaded here, so "Other corrections" knows whether the card could show it.
  const medianFile = useData(() => (median?.round ? api.round(median.round) : Promise.resolve(undefined)), [median?.round]);
  // Only a file for this round counts: right after the evidence arrives, the hook still holds the empty first load.
  const fileFor = median?.round && medianFile.data?.round === median.round ? medianFile.data : undefined;
  const medianRound = fileFor && fileFor.verdict !== "unknown" && Array.isArray(fileFor.medians) ? fileFor : undefined;
  const medianFailed = !!median?.round && !medianRound && (!!fileFor || (!!medianFile.error && !medianFile.loading));
  // Scroll once the evidence and the round file are in (or known to be unreadable), so the boxes above a card no
  // longer move it.
  useAnchor(anchor, !!data && (!median?.round || !!medianRound || medianFailed));

  const live = runs.filter(isLiveRun);
  const keysRun = liveRunOf(runs, "stolen-keys");
  const batchRun = batchRunOf(runs);
  // A bad-batch run that someone else's challenge won is told inside the bad-batch card.
  const uncountedBatch = live.filter((r) => !runCounts(r) && /^bad-batch/.test(r.name));
  // Only the exact runs the cards show are left out of "Other live runs"; an older counted run is still listed.
  const shown = new Set<AttackRun>([keysRun, median?.run, batchRun, ...uncountedBatch].filter((r): r is AttackRun => !!r));
  const otherLive = live.filter((r) => !shown.has(r));
  const dry = runs.filter((r) => !isLiveRun(r));
  const cardShowsMedian = !!medianRound && !!correctionOf(medianRound);
  const otherFlagged = status ? allFlagged(status, data).filter((id) => !(cardShowsMedian && id === median?.round)) : [];
  return (
    <div className="stack" style={{ gap: 40 }}>
      <header>
        <span className="kicker">Attacks</span>
        <h1 className="headline sm">Three attacks on the oracle, and what stopped them</h1>
        <p className="deck">
          Each was run on the QoreChain testnet. The refusals are the chain's and the contracts' own answers, with their
          transactions.
        </p>
      </header>
      {loading && !data ? <Empty>Loading evidence…</Empty> : !data || data.length === 0 ? (
        <Empty>{missing || data?.length === 0 ? "No attack runs recorded yet." : `Could not load evidence: ${error}`}</Empty>
      ) : (
        <>
          <section aria-labelledby="live-h">
            <Label id="live-h" aside="Transactions on qorechain-diana">Live on the testnet</Label>
            <StolenKeysCard run={keysRun} />
            <LyingOperatorCard runs={runs} mode={status?.mode} file={medianRound} failed={medianFailed} />
            <BadBatchCard runs={runs} run={batchRun} status={status} run1={uncountedBatch} />
          </section>
          {otherLive.length > 0 && (
            <section aria-labelledby="other-h">
              <Label id="other-h">Other live runs</Label>
              {otherLive.map((run, i) => <Incident key={`${run.name}-${run.at}-${i}`} run={run} />)}
            </section>
          )}
          {otherFlagged.length > 0 && (
            <CorrectionsBox title="Other corrections">
              {otherFlagged.map((id) => <CorrectionFor key={id} id={id} runs={data} mode={status?.mode} />)}
            </CorrectionsBox>
          )}
          {dry.length > 0 && (
            <details className="dry-runs">
              <summary>Dry runs and the classical-oracle comparison: local checks, no chain transactions ({dry.length} file{dry.length === 1 ? "" : "s"})</summary>
              {dry.map((run, i) => <Incident key={`${run.name}-${run.at}-${i}`} run={run} />)}
            </details>
          )}
        </>
      )}
      {status && (
        <details className="dry-runs">
          <summary>Show the watchtower's full record</summary>
          <Watchtower status={status} runs={data} />
        </details>
      )}
    </div>
  );
}

/** One attack: three labelled lines, the one transaction that shows it, then everything else one click deeper. */
function Card({ id, name, run, tried, stoppedBy, cost, keyTx, children }: {
  id: string; name: string; run?: AttackRun; tried: ReactNode; stoppedBy: ReactNode; cost: ReactNode; keyTx?: ReactNode; children?: ReactNode;
}) {
  const t = run ? attackTally(run) : undefined;
  return (
    <article className="incident card" id={id} aria-labelledby={`${id}-h`}>
      <header>
        <h3 id={`${id}-h`}>{name}</h3>
        <div className="filed">{run ? <>Filed {utcStamp(run.at)} · Live testnet run.</> : "No live run on record yet."}</div>
        {t && (
          <div className="score">
            <b className={t.notRefused ? "bad" : undefined}>{t.refused} of {t.attempts}</b>
            <span>attempt{t.attempts === 1 ? "" : "s"} refused</span>
          </div>
        )}
      </header>
      {run && (
        <>
          <dl className="lines">
            <dt>Tried</dt><dd>{tried}</dd>
            <dt>Stopped by</dt><dd>{stoppedBy}</dd>
            <dt>Cost to attacker</dt><dd>{cost}</dd>
          </dl>
          {keyTx && <p className="key-tx"><span className="k">Key transaction</span> {keyTx}</p>}
        </>
      )}
      {/* Outside the run check, so evidence such as an uncounted earlier run stays visible on its own. */}
      {children}
      {run && (
        <details>
          <summary>{t && t.setup === 0 ? `Show every attempt (${t.attempts})` : `Show every step (${run.steps.length})`}</summary>
          <AttemptTable run={run} />
        </details>
      )}
    </article>
  );
}

function StolenKeysCard({ run }: { run?: AttackRun }) {
  const t = run ? attackTally(run) : undefined;
  const victims = new Set(run?.steps.map((s) => /^(SCOUT\d+):/i.exec(s.step)?.[1]).filter(Boolean)).size;
  const key = run?.steps.find((s) => s.verdict === "REFUSED" && typeof s.evidence.txHash === "string" && NATIVE_TX.test(s.evidence.txHash));
  return (
    <Card id="stolen-keys" name="Stolen keys" run={run}
      tried={<>Posted a fake $1 price with {victims ? `${spell(victims)} scouts'` : "scouts'"} stolen classical keys, and sent a forged $1 round to PriceFeed.</>}
      stoppedBy={<>The chain requires each scout's post-quantum signature as well, and PriceFeed checks the round's. A stolen classical key forges neither.</>}
      cost={t && t.notRefused ? <span className="bad">{cap(spell(t.notRefused))} attempt{t.notRefused === 1 ? " was" : "s were"} not refused.</span> : "Nothing gained: no fake price got through."}
      keyTx={key && <>
        <Hash value={String(key.evidence.txHash)} keep={6} href={nativeTxUrl(String(key.evidence.txHash))} />{" "}
        <span className="muted">{key.step}: refused by the chain{key.evidence.code !== undefined ? ` (code ${key.evidence.code})` : ""}</span>
      </>}
    />
  );
}

function LyingOperatorCard({ runs, mode, file: r, failed }: { runs: AttackRun[]; mode?: string; file?: TowerRound; failed: boolean }) {
  const m = medianChallengeOf(runs);
  const sym = r?.medians?.[0] ? symbolOf(r.medians[0].feedId).replace(/\/USD$/, "") : undefined;
  return (
    <Card id="lying-operator" name="Lying operator" run={m?.run}
      tried={<>Posted a wrong {sym ? `${sym} ` : ""}price{m?.round ? ` for round ${m.round}` : ""}, signed with the operator's real key.</>}
      stoppedBy="A median challenge: PriceFeed recomputed the median from the opened reports and replaced the wrong one."
      cost={m?.corrected ? "Operator's bond slashed: half to the challenger, half burned." : "No slash on record yet: the round is not corrected."}
      keyTx={m && <><Hash value={m.tx} keep={6} /> <span className="muted">median challenge (EVM transaction)</span></>}
    >
      {failed && <p className="note"><b>Round {m?.round}:</b> the round file could not be read just now.</p>}
      {r && correctionOf(r) && (
        <CorrectionsBox title="Correction" level={4} label={`Correction to round ${r.round}`}>
          <CorrectionFigures round={r} />
          <details>
            <summary>Show the full notice</summary>
            <RoundCorrection round={r} runs={runs} mode={mode} figures={false} />
            <p className="how more"><a href={`#/round/${r.round}`}>Round {r.round} in full</a></p>
          </details>
        </CorrectionsBox>
      )}
    </Card>
  );
}

function BadBatchCard({ runs, run, status, run1 }: { runs: AttackRun[]; run?: AttackRun; status?: TowerStatus; run1: AttackRun[] }) {
  const b = useBatchProof(runs, status?.batches.upheld);
  const f = b?.f;
  const up = b?.up;
  const bond = formatQor(f?.bondAmount);
  const cost = up
    ? `${formatQor(up.slashed) ?? "The"} bond slashed: ${formatQor(up.reward) ?? "an amount not recorded"} to our watchtower, ${formatQor(b.burned) ?? "the rest"} burned.`
    : b?.loading ? "Reading the chain's verdict…"
    : f?.batchStatus === "rejected" && f.bondLeft === "0" && bond ? `${bond} bond slashed, as the run recorded it.`
    : "No slash on record.";
  return (
    <Card id="bad-batch" name="Bad batch" run={run}
      tried={<>A rogue submitter{bond ? ` bonded ${bond} and` : ""} posted {b?.batch ? `rollup batch ${b.batch}` : "a rollup batch"} with a false ledger root.</>}
      stoppedBy={up
        ? <>Our watchtower replayed the ledger and sent the chain's fraud proof{b!.gap !== undefined && b!.gap >= 0 ? `, ${spell(b!.gap)} block${b!.gap === 1 ? "" : "s"} after the bad batch` : ""}. The chain rejected the batch.</>
        : b?.proof.state === "not-upheld" ? "Our watchtower sent the chain's fraud proof, but the chain did not uphold it."
        : "Our watchtower replayed the ledger and sent the chain's fraud proof."}
      cost={cost}
      keyTx={f && <><Hash value={f.challengeTx} keep={6} href={nativeTxUrl(f.challengeTx)} /> <span className="muted">fraud proof</span></>}
    >
      {b && (
        <CorrectionsBox title="Correction" level={4} label={`Correction to batch ${b.batch ?? ""}`.trim()}>
          <BatchFigures f={b.f} />
          <details>
            <summary>Show the full notice</summary>
            <BatchCorrection b={b} figures={false} />
          </details>
        </CorrectionsBox>
      )}
      {run1.map((r, i) => {
        const blocks = /(\d+) blocks? after the bad batch/.exec(r.note)?.[1];
        return (
          <div key={`${r.name}-${i}`} className="run-note">
            <p className="note">
              An earlier run was proven first by a public network challenger{blocks ? `, ${blocks} blocks after the bad batch` : ""}; it
              is not counted as ours.
            </p>
            <details>
              <summary>Show {r.name}</summary>
              <Incident run={r} />
            </details>
          </div>
        );
      })}
    </Card>
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
      <AttemptTable run={run} />
    </article>
  );
}

/** Every step of a run as recorded, with its evidence. */
function AttemptTable({ run }: { run: AttackRun }) {
  const counts = !isLiveRun(run) || runCounts(run);
  return (
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
  );
}

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
