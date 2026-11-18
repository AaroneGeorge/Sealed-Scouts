import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { EVM_RPC, httpRpc } from "../lib/evm";
import { curlFor, verifyBatch, type Check, type VerifyInput, type VerifyOutcome } from "../lib/receipt";
import { Pill } from "./bits";

const STATE_LABEL: Record<Check["state"], string> = { wait: "waiting", run: "checking", pass: "pass", fail: "fail", skip: "skipped" };

/**
 * Re-checks a batch's settlement receipt from this browser: chain reads through our read-only proxy, then
 * pqcKeyStatus and pqcVerify as plain eth_calls to the public EVM endpoint. No wallet, no key, no trust in our server
 * for the signature result.
 */
export function VerifyPanel({ input, note }: { input: Omit<VerifyInput, "tamper">; note?: string }) {
  const [tamper, setTamper] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [outcome, setOutcome] = useState<VerifyOutcome>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const rpc = useMemo(() => httpRpc(), []);

  const run = async () => {
    setRunning(true);
    setOutcome(undefined);
    setError(undefined);
    try {
      setOutcome(await verifyBatch({ ...input, tamper }, { rest: api.chain, rpc }, setChecks));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? "Checking…" : "Verify on chain"}
        </button>
        <label className="toggle">
          <input type="checkbox" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
          Change one digit first
        </label>
        <span className="spacer" />
        {outcome && (outcome.valid ? <Pill kind="pass">receipt valid</Pill> : <Pill kind="fail">receipt refused</Pill>)}
      </div>
      {note && <p className="muted small">{note}</p>}
      {error && <p className="err small">Could not finish: {error}</p>}
      {checks.length > 0 && (
        <ol className="checks">
          {checks.map((c, i) => (
            <li key={c.id} className={`check ${c.state} ${i >= 6 ? "extra" : ""}`}>
              <span className="n">{i < 6 ? `${i + 1}/6` : "+"}</span>
              <div>
                <div className="t">{c.title}</div>
                <div className="m">{c.meaning}</div>
                {c.detail && <div className="d">{c.detail}</div>}
              </div>
              <Pill kind={c.state}>{STATE_LABEL[c.state]}</Pill>
            </li>
          ))}
        </ol>
      )}
      {outcome?.call && (
        <details>
          <summary className="small muted">Repeat the pqcVerify call yourself ({outcome.call.messageBytes}-byte message, {outcome.call.signatureBytes}-byte signature, {outcome.call.pubkeyBytes}-byte key)</summary>
          <pre className="code">{curlFor(outcome.call, EVM_RPC)}</pre>
        </details>
      )}
    </div>
  );
}
