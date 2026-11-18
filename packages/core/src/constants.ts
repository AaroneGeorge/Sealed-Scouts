// Fixed values from docs/SPEC.md. Change them only together with the spec.

/** First 4 bytes of every Sealed Scouts inbox payload. */
export const MAGIC = new Uint8Array([0x53, 0x53, 0x43, 0x31]); // "SSC1"

export const MsgKind = { JOIN: 0x01, REPORT: 0x02, COMMIT: 0x03, OPEN: 0x04, REVEAL: 0x05 } as const;
export type MsgKindName = keyof typeof MsgKind;

export const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;
export const ML_DSA_87_SIGNATURE_BYTES = 4627;
export const SALT_BYTES = 16;
export const ADDRESS_BYTES = 20;
export const LEDGER_ACCOUNT_BYTES = 32;
export const COMMITMENT_BYTES = 32;
export const MAX_U128 = (1n << 128n) - 1n;

export const COMMITMENT_DOMAIN = "sealed-scouts/report/v1";
export const COMMIT_TEXT_DOMAIN = "sealed-scouts/commit/v1";
export const ROUND_HASH_DOMAIN = "sealed-scouts/round/v1";
/** QoreSign message v1 prefix; the signed bytes are this + chainId + "|" + text. */
export const MESSAGE_PQ_DOMAIN = "qorechain-msg-v1|";
export const ANCHOR_DOMAIN_V2 = "qorechain-multilayer-anchor-v2";

/** Bech32 prefix of QoreChain accounts. */
export const ACCOUNT_PREFIX = "qor";

/** Prices carry 8 decimals. */
export const PRICE_DECIMALS = 8;
export const FEEDS = { "fETH/USD": 1, "fBTC/USD": 2, "fUSD/USD": 3, "KOCHI-ONION/INR": 4 } as const;
