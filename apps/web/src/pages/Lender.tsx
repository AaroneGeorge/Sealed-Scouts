import { useMemo, useState } from "react";
import { Empty, Hash, Pill } from "../components/bits";
import { api } from "../lib/api";
import { httpRpc, priceFeedAbi, readContract } from "../lib/evm";
import { formatPrice } from "../lib/format";
import type { FeedMeta, Hex } from "../lib/types";
import { FEEDS } from "../lib/view";
import { useData } from "../lib/useData";

/** PriceFeed.latest() status codes, in the order of the contract's Status enum. */
const STATUS = ["none", "pending", "final", "corrected"] as const;
const MAX_AGE = 600n;
/** Loan-to-value for the demo view. ScoutLend's own number wins once it exposes one. */
const DEMO_LTV_BPS = 5000n;

interface FeedRead { feedId: number; latest?: { price: bigint; round: bigint; time: bigint; status: string }; final?: { price: bigint; round: bigint }; refusal?: string }

async function readFeeds(priceFeed: Hex, feeds: FeedMeta[]): Promise<FeedRead[]> {
  const rpc = httpRpc();
  return Promise.all(feeds.map(async ({ feedId }) => {
    const out: FeedRead = { feedId };
    const l = (await readContract(rpc, priceFeed, priceFeedAbi, "latest", [feedId])).result as [bigint, bigint, bigint, number];
    out.latest = { price: l[0], round: l[1], time: l[2], status: STATUS[l[3]] ?? `status ${l[3]}` };
    try {
      const f = (await readContract(rpc, priceFeed, priceFeedAbi, "readFinal", [feedId, MAX_AGE])).result as [bigint, bigint];
      out.final = { price: f[0], round: f[1] };
    } catch (e) {
      out.refusal = (e as Error).message;
    }
    return out;
  }));
}

const feeds = FEEDS.slice(0, 3);

export function Lender({ priceFeed, scoutLend }: { priceFeed: Hex | null; scoutLend: Hex | null }) {
  const reads = useData(() => (priceFeed ? readFeeds(priceFeed, feeds) : Promise.resolve([])), [priceFeed], 20_000);
  const [collateral, setCollateral] = useState("1.5");
  const eth = reads.data?.find((r) => r.feedId === 1);
  const maxBorrow = useMemo(() => {
    if (!eth?.final || !/^\d+(\.\d{0,8})?$/.test(collateral)) return undefined;
    const [w = "0", f = ""] = collateral.split(".");
    const amount = BigInt(w + f.padEnd(8, "0"));
    return (amount * eth.final.price * DEMO_LTV_BPS) / 10_000n / 10n ** 8n;
  }, [eth, collateral]);

  return (
    <div className="stack">
      <section className="hero">
        <span className="eyebrow">Consumer view · read only</span>
        <h1>A lender that only trusts a final price.</h1>
        <p>
          ScoutLend lends fUSD against fETH. It reads <code>PriceFeed.readFinal</code>, which reverts while a round is
          pending, challenged or older than {Number(MAX_AGE) / 60} minutes. So a forged or disputed price never reaches a loan.
        </p>
      </section>
      {!priceFeed ? (
        <Empty>PriceFeed is not deployed yet. This view reads it straight from the EVM once deployments/diana.json lists it.</Empty>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>What the contract sees</h2>
              <span className="hint">PriceFeed <Hash value={priceFeed} keep={6} />{scoutLend && <> · ScoutLend <Hash value={scoutLend} keep={6} /></>}</span>
            </div>
            {reads.error && <p className="err small">{reads.error}</p>}
            <div className="table-wrap">
              <table className="table cards">
                <thead><tr><th>Feed</th><th className="num">Latest</th><th>Status</th><th className="num">Round</th><th>readFinal({String(MAX_AGE)}s)</th></tr></thead>
                <tbody>
                  {(reads.data ?? []).map((r) => (
                    <tr key={r.feedId}>
                      <td data-label="Feed">{feeds.find((f) => f.feedId === r.feedId)?.symbol}</td>
                      <td data-label="Latest" className="num">{r.latest ? formatPrice(r.latest.price) : "·"}</td>
                      <td data-label="Status">{r.latest && <Pill kind={r.latest.status}>{r.latest.status}</Pill>}</td>
                      <td data-label="Round" className="num">{r.latest ? String(r.latest.round) : "·"}</td>
                      <td data-label="readFinal">{r.final ? <Pill kind="pass">{formatPrice(r.final.price)}</Pill> : <Pill kind="fail">reverts</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Borrow check</h2><span className="hint">Loan-to-value {Number(DEMO_LTV_BPS) / 100}%</span></div>
            <div className="row">
              <label className="field">fETH collateral
                <input type="text" inputMode="decimal" value={collateral} onChange={(e) => setCollateral(e.target.value)} style={{ width: 140 }} />
              </label>
              <div>
                {eth?.final && maxBorrow !== undefined ? (
                  <p style={{ margin: 0 }}>Borrow up to <b className="mono">{formatPrice(maxBorrow)} fUSD</b> at fETH ${formatPrice(eth.final.price)} (round {String(eth.final.round)}).</p>
                ) : (
                  <p className="err" style={{ margin: 0 }}>Borrowing is closed: {eth?.refusal ?? "no final fETH price"}.</p>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
