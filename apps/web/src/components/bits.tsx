import { useState, type ReactNode } from "react";
import { shortHash } from "../lib/format";
import type { DisplayStatus } from "../lib/view";

const STATUS_LABEL: Record<DisplayStatus, string> = {
  sealed: "sealed", "not-posted": "not posted", pending: "pending", final: "final", corrected: "corrected", "no-quorum": "no quorum",
};

export function StatusPill({ status }: { status: DisplayStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Pill({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`pill ${kind}`}>{children}</span>;
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
      <button type="button" onClick={copy} aria-label="Copy">{copied ? "✓" : "⧉"}</button>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Native transactions are readable as JSON from the public REST endpoint, which needs no account. */
export const nativeTxUrl = (hash: string) => `https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/${hash.replace(/^0x/, "").toUpperCase()}`;
