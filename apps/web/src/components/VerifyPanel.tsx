import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { verdictOf } from "../lib/edition";
import { EVM_RPC, httpRpc } from "../lib/evm";
import { curlFor, verifyBatch, type Check, type CheckId, type VerifyInput, type VerifyOutcome } from "../lib/receipt";
import { Mark } from "./bits";

const STATE_LABEL: Record<Check["state"], string> = { wait: "Waiting", run: "Checking…", pass: "Passed", fail: "Failed", skip: "Skipped" };

/** Where each check gets its answer. REST reads go through this site's read-only proxy; EVM calls go to the public endpoint. */
const SOURCE: Record<CheckId, string> = {
  rollupLayerBinding: "QoreChain REST: rollup record",
  batchStateRoot: "QoreChain REST: batch record",
  anchorOnChain: "QoreChain REST: layer anchors",
  creatorAuthority: "EVM eth_call: pqcKeyStatus precompile",
  chainBinding: "EVM eth_chainId, anchor height",
  pqcSignature: "EVM eth_call: pqcVerify precompile",
  roundBinding: "Anchor slot, or pqcVerify on the round signature",
  feedContract: "EVM eth_call: PriceFeed.verifyReceipt",
};

/**
 * Re-checks a batch's settlement receipt from this browser, set as a fact check: every claim the receipt makes, the
 * result, and where the answer came from. Chain reads go through our read-only proxy; pqcKeyStatus and pqcVerify are
 * plain eth_calls to the public EVM endpoint. No wallet, no key, no trust in our server for the signature result.
 */
export function VerifyPanel({ input, note }: { input: Omit<VerifyInput, "tamper">; note?: string }) {
  const [tamper, setTamper] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [outcome, setOutcome] = useState<VerifyOutcome>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const rpc = useMemo(() => httpRpc(), []);

  // The tamper setting the last run actually used; the verdict reports this, not the checkbox's current state.
  const [ranTampered, setRanTampered] = useState(false);

  const run = async () => {
    setRunning(true);
    setOutcome(undefined);
    setError(undefined);
    setRanTampered(tamper);
    try {
      setOutcome(await verifyBatch({ ...input, tamper }, { rest: api.chain, rpc }, setChecks));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // Changing the setting makes the last result describe a different check, so clear it.
  const setTamperAndClear = (on: boolean) => {
    setTamper(on);
    if (!running) {
      setOutcome(undefined);
      setChecks([]);
      setError(undefined);
    }
  };

  const verdict = outcome && verdictOf(outcome.valid, outcome.checks, ranTampered);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="controls" style={{ alignItems: "center" }}>
        <button className="btn primary" onClick={run} disabled={running}>{running ? "Checking…" : "Verify on chain"}</button>
        <label className="toggle">
          <input type="checkbox" checked={tamper} disabled={running} onChange={(e) => setTamperAndClear(e.target.checked)} />
          Change one digit first
        </label>
      </div>
      {note && <p className="note" style={{ margin: 0 }}>{note}</p>}

      <div aria-live="polite">
        {outcome && verdict && !running && (
          <div className={`verdict ${outcome.valid ? "pass" : "fail"}`}>
            <span className="lbl">Verdict</span>
            <span className="word">{verdict.word}</span>
            <span className="tally">{verdict.tally}</span>
          </div>
        )}
        {error && <div className="verdict fail"><span className="lbl">Verdict</span><span className="word">Could not finish</span><span className="tally">{error}</span></div>}
      </div>

      {checks.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>
          {running ? "Reading the chain…" : "Press Verify on chain to run the six receipt checks, plus the round checks where they apply. Nothing is checked until you do."}
        </p>
      ) : (
        <table className="factcheck">
          <caption className="sr-only">Settlement receipt checks</caption>
          <thead><tr><th>No.</th><th>Claim checked</th><th>Result</th><th>Source</th></tr></thead>
          <tbody>
            {checks.map((c, i) => (
              <tr key={c.id} className={`${c.state} ${i >= 6 ? "extra" : ""}`}>
                <td className="n">{i < 6 ? `${i + 1}/6` : "+"}</td>
                <td>
                  <div className="claim">{c.title}</div>
                  <div className="meaning">{c.meaning}</div>
                  {c.detail && <div className="detail">{c.detail}</div>}
                </td>
                <td className="res"><Mark kind={c.state}>{STATE_LABEL[c.state]}</Mark></td>
                <td className="src">{SOURCE[c.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checks.length > 6 && <p className="note" style={{ margin: 0 }}>Rows 1 to 6 are the RDK's settlement-receipt checks; the rows marked + bind this price round.</p>}

      {outcome?.call && (
        <details>
          <summary>Repeat the pqcVerify call yourself ({outcome.call.messageBytes}-byte message, {outcome.call.signatureBytes}-byte signature, {outcome.call.pubkeyBytes}-byte key)</summary>
          <pre className="code">{curlFor(outcome.call, EVM_RPC)}</pre>
        </details>
      )}
    </div>
  );
}
