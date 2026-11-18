import { useId } from "react";

/** A wax seal stamped with a lattice: the mark for anything sealed with ML-KEM until a round closes. */
export function Seal({ size = 28, broken = false }: { size?: number; broken?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="wax">
      <defs>
        <radialGradient id={`g${id}`} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor="#f07a55" />
          <stop offset="0.55" stopColor="var(--wax)" />
          <stop offset="1" stopColor="var(--wax-deep)" />
        </radialGradient>
        <pattern id={`p${id}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <circle cx="2.5" cy="2.5" r="0.9" fill="rgba(255,240,225,0.55)" />
        </pattern>
      </defs>
      <path
        d="M20 2.5c3 0 4.2 2 6.8 2.9 2.7.9 5 .1 6.9 2.3 1.9 2.1 1 4.5 1.9 7.1.8 2.4 3 3.8 3 6.7s-2.2 4.2-3 6.7c-.9 2.6 0 5-1.9 7.1-1.9 2.2-4.2 1.4-6.9 2.3-2.6.9-3.8 2.9-6.8 2.9s-4.2-2-6.8-2.9c-2.7-.9-5-.1-6.9-2.3-1.9-2.1-1-4.5-1.9-7.1C1.6 24.6-.6 23.4-.6 20.5s2.2-4.2 3-6.7c.9-2.6 0-5 1.9-7.1 1.9-2.2 4.2-1.4 6.9-2.3C15.8 4.5 17 2.5 20 2.5z"
        transform="translate(0.6 -0.5) scale(0.97)"
        fill={`url(#g${id})`}
      />
      <circle cx="20" cy="20" r="10.5" fill={`url(#p${id})`} stroke="rgba(255,235,215,0.45)" strokeWidth="1" />
      {broken && <path d="M20 4 L17 15 L23 22 L18 37" stroke="var(--bg)" strokeWidth="2.2" fill="none" />}
    </svg>
  );
}
