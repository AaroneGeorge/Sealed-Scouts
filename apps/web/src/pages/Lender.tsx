import { useMemo, useState } from "react";
import { Empty, Hash, Label, Mark } from "../components/bits";
import { api } from "../lib/api";
import { httpRpc, priceFeedAbi, readContract } from "../lib/evm";
import { formatPrice, timeAgo } from "../lib/format";
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
const STATUS_KIND: Record<string, string> = { final: "final", corrected: "corrected", pending: "pending", none: "none" };

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
    <div className="stack" style={{ gap: 40 }}>
      <header>
        <span className="kicker">Lending desk · read only</span>
        <h1 className="headline sm">A lender that only trusts a final price</h1>
        <p className="deck">
          ScoutLend lends fUSD against fETH. It reads <code>PriceFeed.readFinal</code>, which reverts while a round is
          pending, challenged or older than {Number(MAX_AGE) / 60} minutes. So a forged or disputed price never reaches a loan.
        </p>
      </header>
      {!priceFeed ? (
        <Empty>PriceFeed is not deployed yet. This view reads it straight from the EVM once deployments/diana.json lists it.</Empty>
      ) : (
        <div className="cols-2 split ruled">
          <section aria-labelledby="rates-h">
            <Label id="rates-h" aside="Read from the EVM every 20 seconds">What the contract sees</Label>
            {reads.error && <p className="note bad">{reads.error}</p>}
            <div className="scroll">
              <table className="listing">
                <thead><tr><th>Feed</th><th className="num">Latest</th><th>Status</th><th className="num">Round</th><th className="num">Age</th><th className="num sym">readFinal({String(MAX_AGE)} s)</th></tr></thead>
                <tbody>
                  {reads.loading && !reads.data && <tr><td colSpan={6} className="muted">Reading PriceFeed…</td></tr>}
                  {(reads.data ?? []).map((r) => (
                    <tr key={r.feedId}>
                      <td><b>{feeds.find((f) => f.feedId === r.feedId)?.symbol}</b></td>
                      <td className="num">{r.latest ? formatPrice(r.latest.price) : "–"}</td>
                      <td>{r.latest && <Mark kind={STATUS_KIND[r.latest.status] ?? "none"}>{r.latest.status}</Mark>}</td>
                      <td className="num">{r.latest ? String(r.latest.round) : "–"}</td>
                      <td className={`num ${r.latest && r.latest.time > 0n && Date.now() / 1000 - Number(r.latest.time) > Number(MAX_AGE) ? "bad" : ""}`}>
                        {r.latest && r.latest.time > 0n ? timeAgo(Number(r.latest.time)) : "–"}
                      </td>
                      <td className="num">{r.final ? <b>{formatPrice(r.final.price)}</b> : <span className="bad">reverts</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              Age is the time since the round's close, as PriceFeed records it; past {Number(MAX_AGE) / 60} minutes readFinal reverts.
              PriceFeed <Hash value={priceFeed} keep={6} />{scoutLend && <> · ScoutLend <Hash value={scoutLend} keep={6} /></>}
            </p>
          </section>
          <section aria-labelledby="borrow-h">
            <Label id="borrow-h" aside={`Loan-to-value ${Number(DEMO_LTV_BPS) / 100}%`}>Borrow check</Label>
            <label className="field" style={{ marginBottom: 14 }}>fETH collateral
              <input type="text" inputMode="decimal" value={collateral} onChange={(e) => setCollateral(e.target.value)} style={{ width: 160 }} />
            </label>
            {eth?.final && maxBorrow !== undefined ? (
              <p className="body-text" style={{ margin: 0 }}>
                Borrow up to <b className="fig">{formatPrice(maxBorrow)} fUSD</b> at fETH ${formatPrice(eth.final.price)}, the final price from round {String(eth.final.round)}.
              </p>
            ) : reads.loading && !reads.data ? (
              <p className="note" style={{ margin: 0 }}>Reading the feed…</p>
            ) : (
              <p className="body-text bad" style={{ margin: 0 }}>Borrowing is closed: {eth?.refusal ?? "no final fETH price"}.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
