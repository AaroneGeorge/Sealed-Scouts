import { formatInt, formatPrice, shortHash } from "../lib/format";
import type { Hex, TowerRound } from "../lib/types";
import { qorToHex } from "../lib/wire";
import { Seal } from "./Seal";

/**
 * One line per scout that posted, as a listings table. Until the round is opened only the sealed size is public;
 * once opened, the price shows and the seal is drawn broken. Out-of-band and uncounted reports say so in words.
 */
export function ReportsTable({ round, feedId, median, compact = false }: { round: TowerRound; feedId: number; median?: string; compact?: boolean }) {
  const inBand = new Set(round.inBand.map((a) => a.toLowerCase()));
  const revealed = new Set(round.operator.leftOut.filter((l) => l.how === "revealed").map((l) => l.scout));
  return (
    <div className="scroll">
      <table className={`listing ${compact ? "compact" : ""}`}>
        <thead>
          <tr>
            <th className="seal-cell"><span className="sr-only">Seal</span></th>
            <th>Scout</th>
            {!compact && <th className="num">Height</th>}
            <th className="num">Sealed</th>
            <th className="num">Opened</th>
            {!compact && <th className="num">vs median</th>}
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {round.reports.map((r) => {
            const price = r.prices?.find((p) => p.feedId === feedId)?.price;
            const hex = safeHex(r.scout);
            const out = !!price && !!hex && !inBand.has(hex);
            const notes = [
              price && price === median ? "median" : "",
              !price ? "sealed" : !r.counted ? "not counted" : out ? "out of band" : "in band",
              revealed.has(r.scout) ? "self-revealed" : "",
            ].filter(Boolean).join(", ");
            const pct = price && median && BigInt(median) !== 0n
              ? (Number(BigInt(price) - BigInt(median)) / Number(BigInt(median))) * 100 : undefined;
            return (
              <tr key={r.scout}>
                <td className="seal-cell"><Seal size={16} broken={!!price} label={price ? "seal broken: report opened" : "sealed report"} /></td>
                <td className="mono" title={r.scout}>{shortHash(r.scout, compact ? 4 : 6)}</td>
                {!compact && <td className="num">{formatInt(r.height)}</td>}
                <td className="num">{formatInt(r.reportBytes)} B</td>
                <td className="num" style={price ? undefined : { color: "var(--ink-2)" }}>{price ? formatPrice(price) : "sealed"}</td>
                {!compact && <td className="num chg">{pct === undefined ? "" : pct === 0 ? "0.000%" : `${pct > 0 ? "+" : "−"}${Math.abs(pct).toFixed(3)}%`}</td>}
                <td className={out || (price && !r.counted) ? "bad" : undefined}>{notes}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function safeHex(qor: string): Hex | undefined {
  try {
    return qorToHex(qor);
  } catch {
    return undefined;
  }
}
