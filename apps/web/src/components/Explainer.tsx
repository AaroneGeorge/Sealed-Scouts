import type { ReactNode } from "react";
import type { Pipeline, PipelineStep } from "../lib/pipeline";

/** A small envelope with a wax dot: one sealed report. */
function Envelope({ x, y, title, faint = false }: { x: number; y: number; title?: string; faint?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {title && <title>{title}</title>}
      <rect className={faint ? "faint" : "paper"} width="34" height="23" />
      <path className={faint ? "faint" : "ink"} d="M0 0 L17 13 L34 0" />
      {!faint && <circle className="wax" cx="17" cy="13" r="4" />}
    </g>
  );
}

const Arrow = () => (
  <svg className="arrow" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h9M7 3l4 4-4 4" /></svg>
);

function Station({ n, title, term, step, children, plate, last = false }: {
  n: number; title: string; term: string; step?: PipelineStep; children: ReactNode; plate: ReactNode; last?: boolean;
}) {
  const off = step ? !step.lit : false;
  return (
    <li className={`station ${off ? "off" : ""}`}>
      <svg className="plate" viewBox="0 0 170 92" aria-hidden="true">{plate}</svg>
      <h3><span className="n">{n}</span>{title}</h3>
      <div className="term">{term}</div>
      <p>{children}</p>
      {step && (
        <div className="now">
          <b>Now</b>
          {/* The short label keeps the line to one line; the full sentence is there for screen readers, and on hover. */}
          <span className={step.tone === "fail" ? "bad" : step.lit ? "" : "muted"} title={step.text}>
            {step.short && step.short !== step.text
              ? <><span aria-hidden="true">{step.short}</span><span className="sr-only">{step.text}</span></>
              : step.text}
          </span>
        </div>
      )}
      {!last && <Arrow />}
    </li>
  );
}

/**
 * How a price gets from five scouts to a loan, drawn as a newspaper explainer: five numbered stations, each with the
 * real term a reader can look up, and under each, what the current round shows. Unlit stations are greyed out.
 */
export function Explainer({ p, rollupId }: { p: Pipeline; rollupId: string }) {
  const scouts = p.scouts.slice(0, 7);
  const gap = scouts.length > 5 ? 20 : 27;
  const startX = Math.max(4, (170 - (34 + gap * Math.max(0, scouts.length - 1))) / 2);
  const inTray = Math.min(5, p.scouts.length);
  return (
    <div>
      <ol className="explainer" aria-label={`How a price is made, with round ${p.round}'s state at each step`} style={{ listStyle: "none", padding: 0, margin: 0 }}>
        <Station n={1} title="Scouts" term="ML-KEM-1024" step={{ lit: p.scouts.length > 0, tone: "pass", short: p.scouts.length
          ? `${p.scouts.length} scout${p.scouts.length === 1 ? "" : "s"} posted` : "no reports", text: p.scouts.length
          ? `${p.scouts.length} report${p.scouts.length === 1 ? "" : "s"} posted in round ${p.round}` : `no reports in round ${p.round}` }}
          plate={scouts.length === 0 ? <Envelope x={68} y={34} faint /> : scouts.map((s, i) => (
            <Envelope key={s.key} x={startX + i * gap} y={30 + (i % 2) * 12} title={s.title} />
          ))}>
          Each scout seals its price, so nobody can copy it.
        </Station>
        <Station n={2} title="Rollup inbox" term={rollupId} step={p.inbox}
          plate={<>
            <path className="ink" d="M30 40 V78 H140 V40" />
            <path className="ink" d="M22 40 H148" />
            {Array.from({ length: inTray }, (_, i) => <Envelope key={i} x={45 + i * 12} y={50 - i * 4} />)}
            {inTray === 0 && <Envelope x={68} y={50} faint />}
          </>}>
          The chain orders every sealed report; only its size shows.
        </Station>
        <Station n={3} title="Median and anchor" term="ML-DSA-87" step={p.median}
          plate={<>
            <path className="ink" d="M14 34 H156" />
            {[34, 62, 85, 101, 128].map((cx, i) => <circle key={i} className="fill" cx={cx} cy={34} r={i === 2 ? 0 : 3.4} />)}
            <path className="ink" d="M85 20 V48" strokeWidth={2} />
            <rect className="paper" x="44" y="58" width="82" height="24" />
            <text className="tx" x="85" y="74" textAnchor="middle">ML-DSA-87</text>
          </>}>
          When the window closes, the reports are opened and the median is signed.
        </Station>
        <Station n={4} title="PriceFeed" term="pqcVerify" step={p.feed}
          plate={<>
            <rect className="paper" x="48" y="10" width="74" height="74" />
            {[26, 36, 46].map((yy) => <path key={yy} className="ink" d={`M58 ${yy} H112`} />)}
            <path className="ink" d="M64 64 l9 9 l20 -20" strokeWidth={2.4} />
          </>}>
          A contract checks the post-quantum signature on chain, then waits out a challenge window.
        </Station>
        <Station n={5} title="ScoutLend" term="readFinal" step={p.lend} last
          plate={<>
            {[66, 56, 46, 36].map((yy) => <ellipse key={yy} className="paper" cx="85" cy={yy} rx="30" ry="8" />)}
            <path className="ink" d="M55 66 V74 M115 66 V74" />
            <ellipse className="ink" cx="85" cy="74" rx="30" ry="8" />
          </>}>
          The lender takes only a final, fresh price.
        </Station>
      </ol>
      <div className="watch-strip">
        <h3>Watchtower</h3>
        <p>Anyone can replay every round from chain data and challenge a wrong price or batch; the cheat loses its bond.</p>
        <div className="now"><span className="st" style={{ marginRight: 6, color: "var(--ink-2)" }}>Now</span>
          <span className={p.replay.tone === "fail" ? "bad" : ""}>Round {p.round}: {p.replay.text}</span>
        </div>
      </div>
    </div>
  );
}
