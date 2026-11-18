// The opener: after the commit window, decrypt each sealed REPORT with the operator's ML-KEM key and
// publish the openings in one OPEN. An opening is published only if it hashes to the poster's COMMIT,
// so the operator never posts a value it cannot stand behind; anyone can re-check it the same way.
import { open as openEnvelope, type SealKeyPair } from "@qorechain/qoreseal";
import {
  commitment,
  decodeMsg,
  decodeReportPlaintext,
  encodeMsg,
  reportAad,
  reportPurpose,
  roundWindows,
  scoutAddress,
  type InboxEntry,
  type Opening,
  type RoundTiming,
} from "@sealed-scouts/core";

export interface OpenContext {
  chainId: string;
  rollupId: string;
  timing: RoundTiming;
  keys: SealKeyPair;
}

export interface OpenResult {
  openings: Opening[];
  /** Posters whose report the opener could not open, and why. They can still REVEAL themselves. */
  unopened: { poster: string; reason: string }[];
}

export function buildOpenings(entries: InboxEntry[], round: bigint, ctx: OpenContext): OpenResult {
  const w = roundWindows(round, ctx.timing);
  const reports = new Map<string, Uint8Array[]>();
  const commits = new Map<string, Uint8Array[]>();
  for (const e of entries) {
    if (e.height < w.start || e.height >= w.commitEnd) continue;
    const m = decodeMsg(e.payload);
    if (!m || !("round" in m) || m.round !== round) continue;
    if (m.kind === "REPORT") push(reports, e.poster, m.envelope);
    if (m.kind === "COMMIT") push(commits, e.poster, m.commitment);
  }

  const openings: Opening[] = [];
  const unopened: OpenResult["unopened"] = [];
  for (const [poster, envs] of reports) {
    const comms = commits.get(poster) ?? [];
    const scout = scoutAddress(poster);
    if (!scout) unopened.push({ poster, reason: "bad-address" });
    else if (envs.length !== 1 || comms.length !== 1) unopened.push({ poster, reason: "needs exactly one REPORT and one COMMIT" });
    else {
      const opened = tryOpen(envs[0]!, round, poster, ctx);
      if (!opened) unopened.push({ poster, reason: "cannot decrypt" });
      else if (!sameBytes(commitment(round, scout, opened.salt, opened), comms[0]!)) unopened.push({ poster, reason: "opening-mismatch" });
      else openings.push({ scout, salt: opened.salt, feedIds: opened.feedIds, prices: opened.prices });
    }
  }
  openings.sort((a, b) => (a.scout.toLowerCase() < b.scout.toLowerCase() ? -1 : 1));
  return { openings, unopened };
}

/** The OPEN payload for a round. An empty OPEN is still posted: it marks the round as handled. */
export function openPayload(round: bigint, openings: Opening[]): Uint8Array {
  return encodeMsg({ kind: "OPEN", round, openings });
}

function tryOpen(envelope: Uint8Array, round: bigint, poster: string, ctx: OpenContext) {
  try {
    const plain = openEnvelope({
      chainId: ctx.chainId,
      purpose: reportPurpose(ctx.rollupId),
      envelope,
      keys: ctx.keys,
      aad: reportAad(round, poster),
    });
    return decodeReportPlaintext(plain);
  } catch {
    return undefined;
  }
}

function push(m: Map<string, Uint8Array[]>, k: string, v: Uint8Array) {
  m.set(k, [...(m.get(k) ?? []), v]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
