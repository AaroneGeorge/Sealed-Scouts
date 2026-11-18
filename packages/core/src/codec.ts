// Inbox message codecs: payload = "SSC1" | kind u8 | body (docs/SPEC.md "Inbox messages").
// encodePriceSet is shared with the commitment hash, so the two layouts cannot drift.
import {
  ADDRESS_BYTES, COMMITMENT_BYTES, COMMITMENT_DOMAIN, LEDGER_ACCOUNT_BYTES, MAGIC, MAX_U128, ML_DSA_87_SIGNATURE_BYTES,
  MsgKind, SALT_BYTES,
} from "./constants.js";
import { Reader, concatBytes, fromHex, toHex, u128, u16, u64, u8, utf8, type Hex } from "./bytes.js";

/** Prices for some feeds, in feed order. Prices carry 8 decimals. */
export interface PriceSet { feedIds: number[]; prices: bigint[] }
/** One report as the operator opens it: who, the salt, and the prices. */
export interface Opening extends PriceSet { scout: Hex; salt: Uint8Array }

export type JoinMsg = { kind: "JOIN"; account: Uint8Array };
export type ReportMsg = { kind: "REPORT"; round: bigint; envelope: Uint8Array };
export type CommitMsg = { kind: "COMMIT"; round: bigint; commitment: Uint8Array; signature: Uint8Array };
export type OpenMsg = { kind: "OPEN"; round: bigint; openings: Opening[] };
export type RevealMsg = { kind: "REVEAL"; round: bigint; salt: Uint8Array } & PriceSet;
export type Msg = JoinMsg | ReportMsg | CommitMsg | OpenMsg | RevealMsg;

function need(ok: boolean, what: string): void {
  if (!ok) throw new RangeError(what);
}

export function encodePriceSet(p: PriceSet): Uint8Array {
  need(p.feedIds.length === p.prices.length, "feedIds and prices differ in length");
  need(p.feedIds.length <= 255, "at most 255 feeds");
  const parts = [u8(p.feedIds.length)];
  p.feedIds.forEach((id, i) => {
    need(p.prices[i]! >= 0n && p.prices[i]! <= MAX_U128, "price out of u128 range");
    parts.push(u16(id), u128(p.prices[i]!));
  });
  return concatBytes(...parts);
}

function readPriceSet(r: Reader): PriceSet {
  const n = Number(r.uint(1));
  const feedIds: number[] = [];
  const prices: bigint[] = [];
  for (let i = 0; i < n; i++) {
    feedIds.push(Number(r.uint(2)));
    prices.push(r.uint(16));
  }
  return { feedIds, prices };
}

function salt(s: Uint8Array): Uint8Array {
  need(s.length === SALT_BYTES, `salt must be ${SALT_BYTES} bytes`);
  return s;
}

function header(kind: number): Uint8Array {
  return concatBytes(MAGIC, u8(kind));
}

/** Encode any message. Throws on a field of the wrong size, so a bad payload is never posted. */
export function encodeMsg(m: Msg): Uint8Array {
  switch (m.kind) {
    case "JOIN":
      need(m.account.length === LEDGER_ACCOUNT_BYTES, `account must be ${LEDGER_ACCOUNT_BYTES} bytes`);
      return concatBytes(header(MsgKind.JOIN), m.account);
    case "REPORT":
      need(m.envelope.length > 0, "empty envelope");
      return concatBytes(header(MsgKind.REPORT), u64(m.round), m.envelope);
    case "COMMIT":
      need(m.commitment.length === COMMITMENT_BYTES, `commitment must be ${COMMITMENT_BYTES} bytes`);
      need(m.signature.length === ML_DSA_87_SIGNATURE_BYTES, `signature must be ${ML_DSA_87_SIGNATURE_BYTES} bytes`);
      return concatBytes(header(MsgKind.COMMIT), u64(m.round), m.commitment, m.signature);
    case "OPEN": {
      need(m.openings.length <= 255, "at most 255 openings");
      const body = m.openings.map((o) => {
        const scout = fromHex(o.scout);
        need(scout.length === ADDRESS_BYTES, `scout must be ${ADDRESS_BYTES} bytes`);
        return concatBytes(scout, salt(o.salt), encodePriceSet(o));
      });
      return concatBytes(header(MsgKind.OPEN), u64(m.round), u8(m.openings.length), ...body);
    }
    case "REVEAL":
      return concatBytes(header(MsgKind.REVEAL), u64(m.round), salt(m.salt), encodePriceSet(m));
  }
}

/**
 * Decode an inbox payload. Returns undefined for anything that is not a well-formed Sealed Scouts message:
 * other rollup traffic (qledger transactions, deposits), unknown kinds, and bodies of the wrong length.
 */
export function decodeMsg(payload: Uint8Array): Msg | undefined {
  if (payload.length < MAGIC.length + 1) return undefined;
  for (let i = 0; i < MAGIC.length; i++) if (payload[i] !== MAGIC[i]) return undefined;
  const r = new Reader(payload.subarray(MAGIC.length + 1));
  try {
    const msg = decodeBody(payload[MAGIC.length]!, r);
    return msg && r.remaining === 0 ? msg : undefined;
  } catch {
    return undefined;
  }
}

function decodeBody(kind: number, r: Reader): Msg | undefined {
  switch (kind) {
    case MsgKind.JOIN:
      return { kind: "JOIN", account: r.bytes(LEDGER_ACCOUNT_BYTES) };
    case MsgKind.REPORT: {
      const round = r.uint(8);
      const envelope = r.rest();
      return envelope.length > 0 ? { kind: "REPORT", round, envelope } : undefined;
    }
    case MsgKind.COMMIT:
      return { kind: "COMMIT", round: r.uint(8), commitment: r.bytes(COMMITMENT_BYTES), signature: r.bytes(ML_DSA_87_SIGNATURE_BYTES) };
    case MsgKind.OPEN: {
      const round = r.uint(8);
      const count = Number(r.uint(1));
      const openings: Opening[] = [];
      for (let i = 0; i < count; i++) {
        const scout = toHex(r.bytes(ADDRESS_BYTES));
        openings.push({ scout, salt: r.bytes(SALT_BYTES), ...readPriceSet(r) });
      }
      return { kind: "OPEN", round, openings };
    }
    case MsgKind.REVEAL:
      return { kind: "REVEAL", round: r.uint(8), salt: r.bytes(SALT_BYTES), ...readPriceSet(r) };
    default:
      return undefined;
  }
}

/** Plaintext a scout seals inside REPORT: salt16 | n u8 | n x (feedId u16 | price u128). Same layout as a REVEAL body. */
export function encodeReportPlaintext(p: { salt: Uint8Array } & PriceSet): Uint8Array {
  return concatBytes(salt(p.salt), encodePriceSet(p));
}

export function decodeReportPlaintext(b: Uint8Array): ({ salt: Uint8Array } & PriceSet) | undefined {
  const r = new Reader(b);
  try {
    const out = { salt: r.bytes(SALT_BYTES), ...readPriceSet(r) };
    return r.remaining === 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * QoreSeal purpose for REPORT envelopes of one rollup. QoreSeal allows only [A-Za-z0-9._:/-] in a purpose,
 * so the rollup id is joined with ":" (not "|").
 */
export const reportPurpose = (rollupId: string): string => `${COMMITMENT_DOMAIN}:${rollupId}`;
/** QoreSeal additional data for a REPORT envelope: `<round>|<scout qor1>`. */
export const reportAad = (round: bigint, scoutQor: string): Uint8Array => utf8(`${round}|${scoutQor}`);
