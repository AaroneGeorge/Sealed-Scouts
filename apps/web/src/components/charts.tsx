import { BAND_BPS, SLASH_BPS, bpsFrom, formatPrice, shortHash } from "../lib/format";
import type { Hex, LeafJson } from "../lib/types";

/** Median history as a thin line; the last point is drawn as a dot. */
export function Sparkline({ values, width = 92, height = 30 }: { values: bigint[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const nums = values.map(Number);
  const min = Math.min(...nums), max = Math.max(...nums);
  const span = max - min || 1;
  const pts = nums.map((v, i) => [(i / (nums.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const last = pts[pts.length - 1]!;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--brass)" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="var(--wax)" />
    </svg>
  );
}

/**
 * Every scout's price on one axis, measured from the median: the green band is where a report counts as in-band
 * (±2%), the red edges are where it becomes slashable (beyond ±10%).
 */
export function BandChart({ leaves, inBand, feedIndex, median }: { leaves: LeafJson[]; inBand: Set<Hex>; feedIndex: number; median: string }) {
  const W = 640, H = 92, mid = W / 2, pad = 16;
  const pts = leaves.map((l) => ({ l, bps: bpsFrom(l.prices[feedIndex]!, median) }));
  const reach = Math.max(1200, ...pts.map((p) => Math.abs(p.bps) + 150));
  const x = (bps: number) => mid + (Math.max(-reach, Math.min(reach, bps)) / reach) * (mid - pad);
  return (
    <svg className="band" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Scout prices around the median">
      <rect x={pad} y={18} width={x(-SLASH_BPS) - pad} height={42} fill="var(--slash)" />
      <rect x={x(SLASH_BPS)} y={18} width={W - pad - x(SLASH_BPS)} height={42} fill="var(--slash)" />
      <rect x={x(-BAND_BPS)} y={18} width={x(BAND_BPS) - x(-BAND_BPS)} height={42} fill="var(--band)" />
      <line x1={pad} x2={W - pad} y1={39} y2={39} stroke="var(--line)" />
      <line x1={mid} x2={mid} y1={12} y2={66} stroke="var(--brass)" strokeWidth="1.5" />
      {[-SLASH_BPS, -BAND_BPS, 0, BAND_BPS, SLASH_BPS].map((b) => (
        <text key={b} x={x(b)} y={82} textAnchor="middle">{b === 0 ? formatPrice(median) : `${b > 0 ? "+" : ""}${b / 100}%`}</text>
      ))}
      {pts.map(({ l, bps }, i) => (
        <g key={l.scout}>
          <circle cx={x(bps)} cy={39 + ((i % 3) - 1) * 9} r="6" fill={inBand.has(l.scout.toLowerCase() as Hex) ? "var(--pass)" : "var(--fail)"} stroke="var(--panel)" strokeWidth="2">
            <title>{`${shortHash(l.scout, 5)}: ${formatPrice(l.prices[feedIndex]!)} (${bps > 0 ? "+" : ""}${(bps / 100).toFixed(2)}%)`}</title>
          </circle>
        </g>
      ))}
    </svg>
  );
}
