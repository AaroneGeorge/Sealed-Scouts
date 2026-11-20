import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortHash } from "../lib/format";
import type { DisplayStatus } from "../lib/view";

const STATUS_LABEL: Record<DisplayStatus, string> = {
  sealed: "Sealed", "not-posted": "Not posted", pending: "Pending", final: "Final", corrected: "Corrected", "no-quorum": "No quorum",
};

/** A round's status as a word in small capitals, not a badge. */
export function StatusMark({ status }: { status: DisplayStatus }) {
  return <span className={`st ${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Any other state word: pass, fail, wait, skip and so on. */
export function Mark({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`st ${kind}`}>{children}</span>;
}

/** A section label: a thick rule over small capitals, with an optional note on the right. */
export function Label({ children, aside, id }: { children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <div className="label">
      <h2 id={id}>{children}</h2>
      {aside && <span className="aside">{aside}</span>}
    </div>
  );
}

/** A shortened hash with the full value on hover and a copy button. */
export function Hash({ value, keep = 6, href }: { value: string; keep?: number; href?: string }) {
  const [copied, setCopied] = useState(false);
  const text = shortHash(value, keep);
  const copy = () => navigator.clipboard?.writeText(value).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  });
  return (
    <span className="hash" title={value}>
      {href ? <a href={href} target="_blank" rel="noreferrer">{text}</a> : text}
      <button type="button" onClick={copy} aria-label={`Copy ${value}`}>{copied ? "copied" : "copy"}</button>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * True for a moment after `value` changes (never on first render), so new data can get a brief highlight.
 * The highlight itself is CSS, and prefers-reduced-motion turns it off.
 */
export function useFresh(value: unknown, ms = 2400): boolean {
  const first = useRef(true);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setFresh(true);
    const t = setTimeout(() => setFresh(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return fresh;
}

/** The width of an element, kept current, so charts draw at real pixels and their type stays readable. */
export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width) || fallback));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width] as const;
}

/** Native transactions are readable as JSON from the public REST endpoint, which needs no account. */
export const nativeTxUrl = (hash: string) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${hash.replace(/^0x/, "").toUpperCase()}`;

/** "19 Nov 2026, 19:03 UTC" */
export function utcStamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d)}, ${
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(d)} UTC`;
}
