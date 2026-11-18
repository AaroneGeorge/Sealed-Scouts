// JSON forms of core types, for fixtures, vectors and the watchtower feed.
// bigint -> decimal string, bytes -> 0x hex. The parsers below turn them back into exact core types.
import { fromHex, toHex, type Hex } from "./bytes.js";
import type { RoundAttestation } from "./attestation.js";
import type { InboxEntry, RoundResult } from "./derive.js";
import type { Leaf } from "./leaf.js";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Plain JSON for any value made of core types. */
export function jsonify(v: unknown): Json {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return toHex(v);
  if (Array.isArray(v)) return v.map(jsonify);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonify(x)]));
  if (typeof v === "function" || v === undefined) throw new TypeError("not JSON data");
  return v as Json;
}

type J = Record<string, any>;
const big = (s: string | number): bigint => BigInt(s);

export const entryFromJson = (j: J): InboxEntry => ({ seq: big(j.seq), height: big(j.height), poster: j.poster, payload: fromHex(j.payload) });

export const leafFromJson = (j: J): Leaf => ({
  round: big(j.round),
  scout: j.scout as Hex,
  salt: fromHex(j.salt),
  feedIds: j.feedIds.map(Number),
  prices: j.prices.map(big),
  commitSigHash: j.commitSigHash as Hex,
});

export const resultFromJson = (j: J): RoundResult => ({
  round: big(j.round),
  status: j.status,
  leaves: j.leaves.map(leafFromJson),
  medians: j.medians.map((m: J) => ({ feedId: Number(m.feedId), price: big(m.price), count: Number(m.count) })),
  reportsRoot: j.reportsRoot,
  outliers: j.outliers.map(leafFromJson),
  inBand: j.inBand.map(leafFromJson),
  rejected: j.rejected,
  skippedByOpener: j.skippedByOpener,
  openHeight: big(j.openHeight),
  closeHeight: big(j.closeHeight),
});

export const attestationFromJson = (j: J): RoundAttestation => ({
  round: big(j.round),
  batchIndex: big(j.batchIndex),
  inboxStart: big(j.inboxStart),
  inboxEnd: big(j.inboxEnd),
  closeHeight: big(j.closeHeight),
  closeTime: big(j.closeTime),
  feedIds: j.feedIds.map(Number),
  medians: j.medians.map(big),
  counts: j.counts.map(Number),
  reportsRoot: j.reportsRoot,
  reportCount: Number(j.reportCount),
});
