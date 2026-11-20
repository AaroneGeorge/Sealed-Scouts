import { useId } from "react";
import { gapBetween, type RoundGap, type SeriesPoint } from "../lib/edition";
import { BAND_BPS, SLASH_BPS, bpsFrom, formatPrice, shortHash } from "../lib/format";
import type { Hex, LeafJson } from "../lib/types";
import { useWidth } from "./bits";

const toNum = (raw: string) => Number(BigInt(raw)) / 1e8;

/** A step of 1, 2, 2.5 or 5 times a power of ten, so gridlines fall on round numbers. */
function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= raw) ?? 10) * p;
}

function tickText(v: number, step: number) {
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const MARK_WORD = { corrected: "Corrected", disputed: "Disputed" } as const;

/**
 * Median by round as a plain line, the way a markets page draws it: a few hairline gridlines, the axis labelled once,
 * the latest value labelled at the end of the line, and corrected or disputed rounds marked where they happened.
 * Pending rounds are drawn as open circles.
 */
export function PriceChart({ points, symbol, compact = false, gaps = [], paused = false }: {
  points: SeriesPoint[]; symbol: string; compact?: boolean;
  /** Gaps in the whole window (windowGaps), so a round with no median for this feed is not taken for a gap. */
  gaps?: RoundGap[];
  /** Name the cause ("loop paused") only when the round mode says gaps mean a pause. */
  paused?: boolean;
}) {
  const [ref, W] = useWidth<HTMLDivElement>(compact ? 300 : 640);
  if (points.length === 0) return <div ref={ref} className="note">No medians for {symbol} in this window.</div>;

  const H = compact ? 92 : 250;
  const m = compact ? { t: 10, r: 74, b: 18, l: 4 } : { t: 26, r: 82, b: 30, l: 52 };
  const vals = points.map((p) => toNum(p.price));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  // The axis spans at least 0.5% of the price, so a move of a few hundredths of a percent does not read as a crash.
  const centre = (lo + hi) / 2, minSpan = Math.abs(centre) * 0.005 || 1;
  if (hi - lo < minSpan) { lo = centre - minSpan / 2; hi = centre + minSpan / 2; }
  const step = niceStep((hi - lo) / 3);
  const y0 = compact ? lo - (hi - lo) * 0.15 : Math.floor(lo / step) * step;
  const y1 = compact ? hi + (hi - lo) * 0.15 : Math.ceil(hi / step) * step;
  const rounds = points.map((p) => Number(p.round));
  const r0 = rounds[0]!, r1 = rounds[rounds.length - 1]!;
  const last = points.length - 1;
  // Points sit at even steps, one per round. Where the window has no rounds (gaps come from every replayed round, the
  // same list the table shows) the line breaks and the gap gets extra room, shaded and labelled.
  const gapAt = (i: number) => (i > 0 ? gapBetween(gaps, points[i - 1]!.round, points[i]!.round) : undefined);
  const GAP_SLOTS = 2.4;
  const slot: number[] = [];
  points.forEach((_, i) => { slot.push(i === 0 ? 0 : slot[i - 1]! + 1 + (gapAt(i) ? GAP_SLOTS : 0)); });
  const span = slot[last] ?? 0;
  const X = (i: number) => m.l + (span === 0 ? (W - m.l - m.r) / 2 : (slot[i]! / span) * (W - m.l - m.r));
  const y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const ticks: number[] = [];
  for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(v);

  const pt = (i: number) => `${X(i).toFixed(1)},${y(vals[i]!).toFixed(1)}`;
  const path = points.map((_, i) => `${i === 0 || gapAt(i) ? "M" : "L"}${pt(i)}`).join("");
  const breaks = points.flatMap((_, i) => {
    const g = gapAt(i);
    return g ? [{ g, x0: X(i - 1) + 6, x1: X(i) - 6 }] : [];
  });
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor((W - m.l - m.r) / 34))));
  const latest = points[last]!;

  return (
    <div ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${symbol} median by round, rounds ${r0} to ${r1}; latest ${formatPrice(latest.price)} in round ${latest.round}.`}>
        {!compact && ticks.map((v) => (
          <g key={v}>
            <line className="grid" x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />
            <text x={m.l - 8} y={y(v) + 4} textAnchor="end">{tickText(v, step)}</text>
          </g>
        ))}
        {breaks.map(({ g, x0, x1 }) => (
          <g key={`b${g.after}`} className="pause">
            <rect x={x0} y={m.t - (compact ? 4 : 8)} width={Math.max(0, x1 - x0)} height={H - m.b - m.t + (compact ? 4 : 8)} />
            {!compact && (
              <text x={(x0 + x1) / 2} y={m.t + 8} textAnchor="middle">
                <tspan x={(x0 + x1) / 2}>{g.missing === 1 ? "No round" : "No rounds"}</tspan>
                <tspan x={(x0 + x1) / 2} dy="13">{g.missing === 1 ? g.from : `${g.from}–${g.to}`}</tspan>
                {paused && <tspan x={(x0 + x1) / 2} dy="13">loop paused</tspan>}
              </text>
            )}
          </g>
        ))}
        {!compact && <line className="base" x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} />}
        {!compact && points.map((p, i) => (i % every === 0 || i === last) && (
          <text key={p.round} x={X(i)} y={H - m.b + 17} textAnchor="middle">{i === 0 ? `Round ${p.round}` : p.round}</text>
        ))}
        {compact && (
          <>
            <text x={m.l} y={H - 3}>Round {r0}</text>
            <text x={W - m.r} y={H - 3} textAnchor="end">{r1}</text>
          </>
        )}
        {points.map((p, i) => (p.mark === "corrected" || p.mark === "disputed") && (
          <g key={`m${p.round}`}>
            <line className="mark" x1={X(i)} x2={X(i)} y1={m.t - (compact ? 2 : 10)} y2={H - m.b} strokeDasharray={p.mark === "disputed" ? "3 3" : undefined} />
            {!compact && <text className="mark-label" x={X(i)} y={m.t - 14} textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}>{MARK_WORD[p.mark]}</text>}
          </g>
        ))}
        <path className="line" d={path} />
        {points.map((p, i) => (
          <circle key={p.round} className={`pt ${p.mark === "pending" ? "open" : ""}`} cx={X(i)} cy={y(vals[i]!)}
            r={i === last ? 3.5 : p.mark === "pending" ? 3 : compact ? 0 : 2.2} />
        ))}
        <text className="end-label" x={X(last) + 8} y={y(vals[last]!) + 4}>{formatPrice(latest.price)}</text>
        {points.map((p, i) => (
          <circle key={`h${p.round}`} className="hit" cx={X(i)} cy={y(vals[i]!)} r={10}>
            <title>{`Round ${p.round}: ${formatPrice(p.price)}${p.mark ? ` (${p.mark})` : ""}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/**
 * Every opened report on one axis, measured from the median: the shaded band is where a report counts as in band
 * (±2%), the hatched edges are where it becomes slashable (beyond ±10%).
 */
export function BandChart({ leaves, inBand, feedIndex, median }: { leaves: LeafJson[]; inBand: Set<Hex>; feedIndex: number; median: string }) {
  const [ref, W] = useWidth<HTMLDivElement>(640);
  const hatch = `hatch${useId().replace(/:/g, "")}`;
  const H = 96, pad = 14, mid = W / 2;
  const pts = leaves.map((l) => ({ l, bps: bpsFrom(l.prices[feedIndex]!, median) }));
  const reach = Math.max(1200, ...pts.map((p) => Math.abs(p.bps) + 150));
  const x = (bps: number) => mid + (Math.max(-reach, Math.min(reach, bps)) / reach) * (mid - pad);
  const narrow = W < 420;
  const ticks = narrow ? [-SLASH_BPS, 0, SLASH_BPS] : [-SLASH_BPS, -BAND_BPS, 0, BAND_BPS, SLASH_BPS];
  return (
    <div ref={ref}>
      <svg className="band" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${pts.length} opened reports around the median ${formatPrice(median)}; band ±2%, slashable beyond ±10%.`}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line className="hatch-line" x1="0" y1="0" x2="0" y2="6" />
          </pattern>
        </defs>
        <rect x={pad} y={16} width={x(-SLASH_BPS) - pad} height={44} fill={`url(#${hatch})`} />
        <rect x={x(SLASH_BPS)} y={16} width={W - pad - x(SLASH_BPS)} height={44} fill={`url(#${hatch})`} />
        <rect className="zone-band" x={x(-BAND_BPS)} y={16} width={x(BAND_BPS) - x(-BAND_BPS)} height={44} />
        <line className="axis" x1={pad} x2={W - pad} y1={38} y2={38} />
        <line className="mid" x1={mid} x2={mid} y1={10} y2={66} />
        {ticks.map((b) => (
          <text key={b} x={x(b)} y={84} textAnchor="middle">{b === 0 ? `median ${formatPrice(median)}` : `${b > 0 ? "+" : "−"}${Math.abs(b) / 100}%`}</text>
        ))}
        {pts.map(({ l, bps }, i) => (
          <circle key={l.scout} className={`dot ${inBand.has(l.scout.toLowerCase() as Hex) ? "" : "out"}`} cx={x(bps)} cy={38 + ((i % 3) - 1) * 9} r="5.5">
            <title>{`${shortHash(l.scout, 5)}: ${formatPrice(l.prices[feedIndex]!)} (${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%)`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}
