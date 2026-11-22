import type { ReactNode } from "react";
import { api } from "../lib/api";
import { batchFraudOf, challengeEvidence, correctionOf, formatQor, fraudProofOf, spell, type TxResponse } from "../lib/edition";
import { formatInt, formatPrice, shortHash } from "../lib/format";
import type { AttackRun, Challenge, TowerRound, UpheldBatch } from "../lib/types";
import { useData } from "../lib/useData";
import { symbolOf } from "../lib/view";
import { Hash, nativeTxUrl, utcStamp } from "./bits";

/** The first line of a client error, without the library's version footer, with long hashes shortened. */
const firstLine = (e: string) => e.split("\n")[0]!.replace(/\s*Version:.*$/, "").replace(/"?(0x[0-9a-fA-F]{64})"?/g, (_, h: string) => shortHash(h, 6)).trim();

/**
 * A boxed corrections column: one heading, then one entry per correction, ruled apart. Standing alone it is a region
 * with an h2. Inside an attack card (`level` 4) it is a group named by `label`, so the page's landmarks stay distinct
 * and its heading sits under the card's h3.
 */
export function CorrectionsBox({ title = "Corrections", level = 2, label, children }: {
  title?: string; level?: 2 | 4; label?: string; children: ReactNode;
}) {
  const H = level === 4 ? "h4" : "h2";
  return level === 4 ? (
    <div className="corrections" role="group" aria-label={label ?? title}>
      <H>{title}</H>
      {children}
    </div>
  ) : (
    <section className="corrections" aria-label={label ?? title}>
      <H>{title}</H>
      {children}
    </section>
  );
}

/** The round page's box: one round, with the raw challenge detail. */
export function CorrectionBox({ round, runs, mode }: { round: TowerRound; runs?: AttackRun[]; mode?: string }) {
  const c = correctionOf(round);
  if (!c) return null;
  return (
    <CorrectionsBox title={c.kind === "corrected" ? "Corrections" : "Disputed"}>
      <RoundCorrection round={round} runs={runs} mode={mode} />
    </CorrectionsBox>
  );
}

/**
 * One round's entry: what was printed, what it should have read, how the error was caught, and what it cost the
 * operator. A disputed round (wrong on PriceFeed, not corrected yet) is worded as a dispute, so a reader never sees a
 * correction that has not happened. `brief` (the front page) keeps the watchtower's own attempts to one sentence.
 */
export function RoundCorrection({ round, runs, mode, brief = false, figures = true }: {
  round: TowerRound; runs?: AttackRun[]; mode?: string; brief?: boolean;
  /** False where the figures table is already shown above (the attacks page's card). */
  figures?: boolean;
}) {
  const c = correctionOf(round);
  if (!c) return null;
  const txs = challengeEvidence(runs, c.round);
  const corrected = c.kind === "corrected";
  return (
    <div className="entry">
      <p className="lede">
        {corrected
          ? <><b>Round {c.round}.</b> The operator posted a wrong median for this round. PriceFeed has since replaced it with the figure recomputed from every report.</>
          : <><b>Round {c.round}, disputed.</b> The price on PriceFeed disagrees with the median the watchtower recomputes from the opened reports. No correction is on chain yet.</>}
      </p>
      {figures && <CorrectionFigures round={round} />}
      <dl className="how">
        <dt>How it was caught. </dt>
        <dd>
          The watchtower replays each round from the rollup inbox and recomputes the median from every opened report. For
          round {c.round} it did not match the median the operator signed{c.batchIndex ? ` in batch ${c.batchIndex}` : ""}.
        </dd>
      </dl>
      {(txs.length > 0 || round.challenges.length > 0) && (
        <dl className="how">
          <dt>Challenge. </dt>
          <dd>
            {txs.map((t) => (
              <span key={t.hash} style={{ display: "block" }}>
                Median challenge sent to PriceFeed: <Hash value={t.hash} keep={6} />{" "}
                <span className="muted">(EVM tx; {t.run} run, {t.live ? "live testnet" : "dry run"}, {utcStamp(t.at)})</span>
              </span>
            ))}
            {round.challenges.map((ch) => (
              <span key={ch.at} style={{ display: "block" }}>
                {brief ? towerLine(ch, mode, corrected && txs.length > 0) : (
                  <>
                    Watchtower's own {ch.kind} challenge, {utcStamp(ch.at)}:{" "}
                    {ch.sent ? <>sent{ch.txHash ? <> <Hash value={ch.txHash} keep={6} /></> : null}</>
                      : ch.error ? <span className="muted">not confirmed ({firstLine(ch.error)})</span>
                      : <span className="muted">ready, not sent{mode === "observe" ? " (observe mode sends nothing)" : ""}</span>}
                  </>
                )}
              </span>
            ))}
          </dd>
        </dl>
      )}
      <dl className="how">
        <dt>{corrected ? "Penalty. " : "What happens next. "}</dt>
        <dd>
          {corrected
            ? "PriceFeed stored the recomputed median, marked the round Corrected and slashed the operator's whole bond: half to the challenger, half burned."
            : "A median challenge that proves the figure wrong makes PriceFeed store the recomputed median and slash the operator's bond. Until a challenge lands, the posted figure stands on PriceFeed."}
        </dd>
      </dl>
      {brief && <p className="how more"><a href={`#/round/${c.round}`}>Round {c.round} in full</a></p>}
    </div>
  );
}

/** Printed, should read and PriceFeed now, one row group per wrong feed: the heart of a round's correction. */
export function CorrectionFigures({ round }: { round: TowerRound }) {
  const c = correctionOf(round);
  if (!c || c.rows.length === 0) return null;
  const corrected = c.kind === "corrected";
  return (
    // One row group per feed, two columns, so it fits a narrow column at any width.
    <table>
      {c.rows.map((row) => (
        <tbody key={row.feedId}>
          <tr><th scope="rowgroup" colSpan={2} className="sym">{symbolOf(row.feedId)}</th></tr>
          <tr><td>Printed</td><td className={`num ${corrected ? "was" : "bad"}`}>{row.printed ? `$${formatPrice(row.printed)}` : "not recorded"}</td></tr>
          <tr><td>Should read</td><td className="num"><b>${formatPrice(row.correct)}</b></td></tr>
          <tr><td>PriceFeed now</td><td className={`num ${row.onFeed === row.correct ? "" : "bad"}`}>{row.onFeed ? `$${formatPrice(row.onFeed)}` : "not posted"}</td></tr>
        </tbody>
      ))}
    </table>
  );
}

/** One calm sentence about the watchtower's own attempt, for the front page. */
function towerLine(ch: Challenge, mode: string | undefined, settledByAnother: boolean) {
  if (ch.sent) return <>The watchtower's own {ch.kind} challenge was sent{ch.txHash ? <> (<Hash value={ch.txHash} keep={6} />)</> : null}.</>;
  if (ch.error) {
    const how = /timed out/i.test(ch.error) ? "timed out unconfirmed" : "was not confirmed";
    return <span className="muted">A second challenge from the watchtower {how}{settledByAnother ? "; the challenge above is the one that corrected the round" : ""}.</span>;
  }
  return <span className="muted">The watchtower's challenge is ready but not sent{mode === "observe" ? ": it runs in observe mode, which sends nothing" : ""}.</span>;
}

/**
 * Loads one flagged round's file and prints its entry. Nothing while loading or if the round turns out clean; one
 * plain line if the file cannot be read, so the entry never silently disappears.
 */
export function CorrectionFor({ id, runs, mode }: { id: string; runs?: AttackRun[]; mode?: string }) {
  const { data, loading } = useData(() => api.round(id), [id]);
  if (data) return <RoundCorrection round={data} runs={runs} mode={mode} brief />;
  if (loading) return null;
  return <div className="entry"><p className="lede"><b>Round {id}:</b> the round file could not be read just now.</p></div>;
}

const TxLink = ({ hash }: { hash: string }) => <Hash value={hash} keep={6} href={nativeTxUrl(hash)} />;

/**
 * The bad-batch fraud proof: a rogue submitter's batch with a wrong ledger root, proved wrong with the chain's own
 * fraud proof. The transactions come from the counted attack run; the heights and the slash come from the chain's
 * record of those transactions, read through the read-only proxy. One hook, so a card and its notice share the reads.
 */
export function useBatchProof(runs?: AttackRun[], upheld?: UpheldBatch[]) {
  const f = batchFraudOf(runs);
  const challenge = useData(() => (f ? api.chain<TxResponse>(`/cosmos/tx/v1beta1/txs/${f.challengeTx}`) : Promise.resolve(undefined)), [f?.challengeTx]);
  const submit = useData(() => (f?.submitTx ? api.chain<TxResponse>(`/cosmos/tx/v1beta1/txs/${f.submitTx}`) : Promise.resolve(undefined)), [f?.submitTx]);
  if (!f) return undefined;
  const proof = fraudProofOf(challenge.data);
  // The chain's own record wins. If it cannot be read, the watchtower feed's copy of the same rdk_fraud_upheld event
  // (matched by transaction) stands in; it has no burned amount, so that is then worked out as slashed less reward.
  const fromFeed = proof.state === "unread" && !challenge.loading
    ? upheld?.find((u) => u.txHash.toUpperCase() === f.challengeTx.toUpperCase()) : undefined;
  const up = proof.state === "upheld" ? proof
    : fromFeed ? { height: fromFeed.height, batchIndex: String(fromFeed.batchIndex), slashed: fromFeed.slashedUqor, reward: fromFeed.challengerRewardUqor, burned: undefined, challenger: fromFeed.challenger }
    : undefined;
  const hSubmit = submit.data?.tx_response?.height;
  // The block gap is only news for a proof the chain upheld.
  const gap = up?.height && hSubmit ? Number(BigInt(up.height) - BigInt(hSubmit)) : undefined;
  const batch = up?.batchIndex ?? f.batchIndex;
  const burned = up?.burned ?? (up && /^\d+$/.test(up.slashed ?? "") && /^\d+$/.test(up.reward ?? "") ? String(BigInt(up.slashed!) - BigInt(up.reward!)) : undefined);
  return { f, proof, fromFeed, up, hSubmit, gap, batch, burned, loading: challenge.loading };
}
export type BatchProof = NonNullable<ReturnType<typeof useBatchProof>>;

/** The printed and the honest state root, as recorded by the run. */
export function BatchFigures({ f }: { f: BatchProof["f"] }) {
  return (
    <table>
      {/* Two rows rather than three columns, so the roots fit a narrow column at any width. */}
      <thead><tr><th>State root</th><th>As recorded</th></tr></thead>
      <tbody>
        <tr><td>Printed</td><td className="num mono was">{f.stateRoot ?? "not recorded"}</td></tr>
        <tr><td>Should read</td><td className="num mono"><b>{f.honestRoot ?? "not recorded"}</b></td></tr>
      </tbody>
    </table>
  );
}

/** The full bad-batch notice: what happened, how it was caught, the transactions and the penalty. */
export function BatchCorrection({ b, figures = true }: { b: BatchProof; figures?: boolean }) {
  const { f, proof, fromFeed, up, hSubmit, gap, batch, loading } = b;
  const codeNote = proof.state === "not-upheld" && proof.code ? ` (transaction code ${proof.code})` : "";
  return (
    <div className="entry">
      <p className="lede">
        <b>Batch {batch ?? "(index not recorded)"}.</b> A rogue submitter posted a rollup batch with a wrong ledger root.
        {up ? " The chain rejected it." : f.batchStatus ? ` The run recorded the batch as ${f.batchStatus}.` : ""}
      </p>
      {figures && <BatchFigures f={f} />}
      <dl className="how">
        <dt>How it was caught. </dt>
        <dd>
          {up ? (
            <>
              The watchtower replayed the rollup ledger and proved the root wrong with the chain's own qledger fraud proof
              (MsgChallengeBatch){gap !== undefined && gap >= 0
                ? `, ${spell(gap)} block${gap === 1 ? "" : "s"} after the bad batch (heights ${formatInt(hSubmit!)} and ${formatInt(up.height!)})`
                : ""}.
            </>
          ) : proof.state === "not-upheld" ? (
            `The watchtower sent the chain's qledger fraud proof (MsgChallengeBatch), but the chain did not uphold it${codeNote}.`
          ) : (
            "The watchtower replayed the rollup ledger and challenged the root with the chain's own qledger fraud proof (MsgChallengeBatch)."
          )}
        </dd>
      </dl>
      <dl className="how">
        <dt>Transactions. </dt>
        <dd>
          {f.submitTx && <span style={{ display: "block" }}>Bad batch: <TxLink hash={f.submitTx} /></span>}
          <span style={{ display: "block" }}>Fraud proof: <TxLink hash={f.challengeTx} /></span>
          {f.bondTx && <span style={{ display: "block" }}>Rogue's bond{f.bondAmount ? ` (${formatQor(f.bondAmount)})` : ""}: <TxLink hash={f.bondTx} /></span>}
        </dd>
      </dl>
      <dl className="how">
        <dt>Penalty. </dt>
        <dd>
          {up
            ? `The chain upheld the proof (rdk_fraud_upheld${fromFeed ? ", as recorded in the watchtower feed" : ""}), rejected batch ${up.batchIndex ?? batch} and slashed the submitter's ${formatQor(up.slashed) ? `${formatQor(up.slashed)} ` : ""}bond, ${formatQor(up.reward) ?? "an amount not recorded"} to the challenger${up.burned ? `, ${formatQor(up.burned) ?? "an amount not recorded"} burned` : ""}.`
            : proof.state === "not-upheld"
              ? `The chain did not uphold this proof${codeNote}, so its record shows no slash.`
              : loading
              ? "Reading the chain's verdict…"
              : `The chain's record of the proof could not be read just now. The run recorded the batch as ${f.batchStatus ?? "(status not recorded)"} and ${f.bondLeft !== undefined ? `${formatQor(f.bondLeft)} left in the rogue's bond` : "no bond balance"}.`}
        </dd>
      </dl>
    </div>
  );
}
