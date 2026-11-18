// Build a round's two inbox posts: REPORT (prices sealed to the opener with ML-KEM-1024) and COMMIT
// (salted commitment plus the scout's ML-DSA-87 signature). docs/SPEC.md, "Inbox messages".
import { randomBytes } from "node:crypto";
import { seal } from "@qorechain/qoreseal";
import { QLEDGER_MAX_POST_BYTES } from "@qorechain/rdk";
import {
  SALT_BYTES, commitment, commitSigHash, encodeMsg, encodeReportPlaintext, reportAad, reportPurpose, scoutAddress, signCommit,
  type PriceSet,
} from "@sealed-scouts/core";

/** The parts of a chain account the scout signs with. A @sealed-scouts/chain Account fits. */
export interface ScoutSigner { address: string; keys: { pqc: { secretKey: Uint8Array } } }

export interface ReportInput {
  chainId: string;
  rollupId: string;
  round: bigint;
  scout: ScoutSigner;
  /** The opener's registered ML-KEM-1024 key (1,568 bytes). */
  openerKemKey: Uint8Array;
  prices: PriceSet;
  salt?: Uint8Array;
}

export interface SealedReport {
  round: bigint;
  scout20: `0x${string}`;
  salt: Uint8Array;
  prices: PriceSet;
  commitment: Uint8Array;
  signature: Uint8Array;
  commitSigHash: `0x${string}`;
  /** Inbox payloads, in posting order. */
  report: Uint8Array;
  commit: Uint8Array;
}

/** Feeds in ascending id order, so the same prices always give the same commitment. */
export function sortedPriceSet(p: PriceSet): PriceSet {
  const order = p.feedIds.map((_, i) => i).sort((a, b) => p.feedIds[a]! - p.feedIds[b]!);
  return { feedIds: order.map((i) => p.feedIds[i]!), prices: order.map((i) => p.prices[i]!) };
}

export function buildSealedReport(input: ReportInput): SealedReport {
  const { chainId, rollupId, round, scout } = input;
  const scout20 = scoutAddress(scout.address);
  if (!scout20) throw new Error(`not a qor1 address: ${scout.address}`);
  const prices = sortedPriceSet(input.prices);
  if (prices.feedIds.length === 0) throw new Error("a report needs at least one feed");
  const salt = input.salt ?? new Uint8Array(randomBytes(SALT_BYTES));

  const envelope = seal({
    chainId,
    purpose: reportPurpose(rollupId),
    mode: "mlkem",
    recipients: [{ mlkemPublicKey: input.openerKemKey }],
    plaintext: encodeReportPlaintext({ salt, ...prices }),
    aad: reportAad(round, scout.address),
  });
  const c = commitment(round, scout20, salt, prices);
  const signature = signCommit(scout.keys.pqc.secretKey, { chainId, rollupId, round, scout: scout.address, commitment: c });

  const report = encodeMsg({ kind: "REPORT", round, envelope });
  const commit = encodeMsg({ kind: "COMMIT", round, commitment: c, signature });
  for (const [name, p] of [["REPORT", report], ["COMMIT", commit]] as const) {
    if (p.length > QLEDGER_MAX_POST_BYTES) throw new Error(`${name} is ${p.length} bytes, over the ${QLEDGER_MAX_POST_BYTES}-byte post limit`);
  }
  return { round, scout20, salt, prices, commitment: c, signature, commitSigHash: commitSigHash(signature), report, commit };
}

/** REVEAL: the scout opens its own report when the operator left it out of OPEN. */
export function buildReveal(r: Pick<SealedReport, "round" | "salt" | "prices">): Uint8Array {
  return encodeMsg({ kind: "REVEAL", round: r.round, salt: r.salt, ...r.prices });
}
