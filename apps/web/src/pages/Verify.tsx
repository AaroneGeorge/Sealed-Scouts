import { useEffect, useState } from "react";
import { Empty, Label } from "../components/bits";
import { VerifyPanel } from "../components/VerifyPanel";
import { api } from "../lib/api";
import { useData } from "../lib/useData";

interface RollupsRes { rollups: { rollup_id: string; status: string; settlement_mode: string }[] }

/**
 * Check any anchored batch of any rollup on the testnet. Useful before our rollup is live, and a fair test: the
 * same code that checks our receipts accepts other teams' honest batches and refuses a changed digit.
 */
export function Verify({ defaultRollup, query }: { defaultRollup: string; query: URLSearchParams }) {
  const rollups = useData(() => api.chain<RollupsRes>("/qorechain/rdk/v1/rollups"), []);
  const [rollupId, setRollupId] = useState(query.get("rollup") ?? defaultRollup);
  const [batch, setBatch] = useState(query.get("batch") ?? "");
  const [latest, setLatest] = useState<string>();

  useEffect(() => {
    setLatest(undefined);
    api.chain<{ batch: { batch_index: string } }>(`/qorechain/rdk/v1/latest_batch/${encodeURIComponent(rollupId)}`)
      .then((r) => setLatest(r.batch.batch_index), () => setLatest(""));
  }, [rollupId]);

  const index = batch || latest || "";
  const live = rollups.data?.rollups.filter((r) => r.status === "active" && r.settlement_mode === "optimistic") ?? [];
  const ours = live.some((r) => r.rollup_id === defaultRollup);

  return (
    <div className="stack" style={{ gap: 30 }}>
      <header>
        <span className="kicker">Fact check · no wallet needed</span>
        <h1 className="headline sm">Is this receipt genuine? Check it yourself.</h1>
        <p className="deck">
          Your browser reads the batch from QoreChain and asks the chain itself whether its post-quantum signature holds.
          No wallet, and no need to trust our server.
        </p>
        <details style={{ marginTop: 12 }}>
          <summary>Show details</summary>
          <p className="note" style={{ maxWidth: "var(--measure)" }}>
            It reads the rollup, the batch and the anchor, rebuilds the exact bytes the creator signed, and asks the
            chain's own <code>pqcVerify</code> precompile whether the ML-DSA-87 signature holds.
          </p>
        </details>
      </header>
      <section aria-labelledby="fc-h">
        <Label id="fc-h" aside="Any live rollup on the testnet">The receipt</Label>
        <div className="controls" style={{ marginBottom: 20 }}>
          <label className="field">Rollup
            <select value={rollupId} onChange={(e) => { setRollupId(e.target.value); setBatch(""); }}>
              {!ours && <option value={defaultRollup}>{defaultRollup} (not live yet)</option>}
              {live.map((r) => <option key={r.rollup_id} value={r.rollup_id}>{r.rollup_id}</option>)}
            </select>
          </label>
          <label className="field">Batch index
            <input type="number" min={0} value={index} placeholder={latest === "" ? "no batch" : "latest"} onChange={(e) => setBatch(e.target.value)} style={{ width: 120 }} />
          </label>
        </div>
        {index !== "" ? (
          <VerifyPanel key={`${rollupId}/${index}`} input={{ rollupId, batchIndex: BigInt(index) }}
            note={!ours && rollupId === defaultRollup ? "Our rollup is not launched yet, so this check stops at step 1. Pick another live rollup to see all six pass." : undefined} />
        ) : (
          <Empty>{latest === undefined ? "Finding the latest batch…" : `${rollupId} has no batch on chain yet.`}</Empty>
        )}
      </section>
    </div>
  );
}
