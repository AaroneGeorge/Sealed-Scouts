// Reward epochs: every in-band report earns a fixed amount on the rollup ledger, paid by the operator's
// ledger account to the account the scout named in its JOIN. Pure functions; the loop posts the transfers.
import { decodeMsg, scoutAddress, type InboxEntry, type RoundResult } from "@sealed-scouts/core";

/** Latest JOIN per poster (qor1 -> 32-byte ledger account id). A later JOIN replaces an earlier one. */
export function joinsFrom(entries: InboxEntry[], into = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  for (const e of entries) {
    const m = decodeMsg(e.payload);
    if (m?.kind === "JOIN") into.set(e.poster, m.account);
  }
  return into;
}

export interface RewardLine {
  scout: string;
  account: Uint8Array;
  reports: number;
  amount: bigint;
}

/** In-band reports per scout (lowercase 0x address), kept across the rounds of one epoch. */
export type Tally = Record<string, number>;

export function addInBand(tally: Tally, result: RoundResult): Tally {
  for (const leaf of result.inBand) {
    const k = leaf.scout.toLowerCase();
    tally[k] = (tally[k] ?? 0) + 1;
  }
  return tally;
}

/** One line per scout in the tally that has a JOIN; scouts without one are left out (nowhere to pay). */
export function rewardLines(tally: Tally, joins: Map<string, Uint8Array>, perReport: bigint): RewardLine[] {
  const byHex = new Map<string, { scout: string; account: Uint8Array }>();
  for (const [qor, account] of joins) {
    const h = scoutAddress(qor);
    if (h) byHex.set(h.toLowerCase(), { scout: qor, account });
  }
  const lines: RewardLine[] = [];
  for (const [h, n] of Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const j = byHex.get(h);
    if (j && n > 0) lines.push({ scout: j.scout, account: j.account, reports: n, amount: perReport * BigInt(n) });
  }
  return lines;
}
