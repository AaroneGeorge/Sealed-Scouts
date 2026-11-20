/**
 * A wax seal, flat, in the page's one accent colour, pressed with a serif S: the mark for anything sealed with ML-KEM
 * until a round closes. Once the report is opened the seal is drawn broken.
 */
export function Seal({ size = 18, broken = false, label }: { size?: number; broken?: boolean; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="wax" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path
        d="M20 1.5c2.6 0 3.9 2.1 6.3 3 2.5.9 4.9.2 6.7 2 1.8 1.9 1.1 4.2 2 6.7.9 2.4 3 3.7 3 6.3s-2.1 3.9-3 6.3c-.9 2.5-.2 4.9-2 6.7-1.8 1.8-4.2 1.1-6.7 2-2.4.9-3.7 3-6.3 3s-3.9-2.1-6.3-3c-2.5-.9-4.9-.2-6.7-2-1.8-1.8-1.1-4.2-2-6.7C4.1 23.4 2 22.1 2 19.5s2.1-3.9 3-6.3c.9-2.5.2-4.9 2-6.7 1.8-1.8 4.2-1.1 6.7-2 2.4-.9 3.7-3 6.3-3z"
        fill="var(--accent)"
      />
      <circle cx="20" cy="19.5" r="12.5" fill="none" stroke="var(--paper)" strokeWidth={size < 24 ? 2.2 : 1.2} opacity="0.6" />
      {/* The pressed letter only where it is big enough to read; small, it would look like a dollar sign. */}
      {size >= 24 && <text x="20" y="27.5" textAnchor="middle" fill="var(--paper)" style={{ font: "600 22px var(--serif)" }}>S</text>}
      {broken && <path d="M21 0 L17 13 L24 21 L18 40" stroke="var(--paper)" strokeWidth={size < 24 ? 5 : 3.2} fill="none" />}
    </svg>
  );
}
