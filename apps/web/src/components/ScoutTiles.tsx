import { formatInt, formatPrice, shortHash } from "../lib/format";
import type { Hex, TowerRound } from "../lib/types";
import { qorToHex } from "../lib/wire";
import { Seal } from "./Seal";

/**
 * One envelope per scout. Until the round is opened only the sealed size is public; once opened the price shows and
 * the seal breaks. Out-of-band reports are marked red, reports that did not count are dimmed.
 */
export function ScoutTiles({ round, feedId, median }: { round: TowerRound; feedId: number; median?: string }) {
  const inBand = new Set(round.inBand.map((a) => a.toLowerCase()));
  const revealed = new Set(round.operator.leftOut.filter((l) => l.how === "revealed").map((l) => l.scout));
  return (
    <div className="tiles">
      {round.reports.map((r) => {
        const price = r.prices?.find((p) => p.feedId === feedId)?.price;
        const hex = safeHex(r.scout);
        const out = !!price && !!hex && !inBand.has(hex);
        const isMedian = !!price && price === median;
        const cls = ["tile", price ? "open" : "", out ? "out" : "", isMedian ? "median" : ""].join(" ");
        return (
          <div key={r.scout} className={cls} style={r.counted || !price ? undefined : { opacity: 0.55 }}>
            <div className="who" title={r.scout}>{shortHash(r.scout, 4)}</div>
            <Seal size={30} broken={!!price} />
            {price ? (
              <>
                <div className="val">{formatPrice(price)}</div>
                <div className="sub">
                  {isMedian ? "median · " : ""}{!r.counted ? "not counted" : out ? "out of band" : "in band"}
                  {revealed.has(r.scout) ? " · self-revealed" : ""}
                </div>
              </>
            ) : (
              <>
                <div className="val">sealed</div>
                <div className="sub">{formatInt(r.reportBytes)} bytes of ML-KEM ciphertext</div>
              </>
            )}
          </div>
        );
      })}
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
