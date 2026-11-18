// Test-only round builder: scouts from the public TEST-ONLY fixture keys, sealed to a test opener key.
import { readFileSync } from "node:fs";
import { mldsa87 } from "@qorechain/pqc";
import { deriveSealKeys, seal, type SealKeyPair } from "@qorechain/qoreseal";
import {
  commitment, encodeMsg, encodeReportPlaintext, fromHex, reportAad, reportPurpose, roundWindows, signCommit,
  type InboxEntry, type RoundParams, type RoundTiming,
} from "@sealed-scouts/core";

export const CHAIN_ID = "qorechain-diana";
export const ROLLUP = "sealed-scouts-test";
export const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const OPERATOR = "qor1operatortest";
export const timing: RoundTiming = { genesisHeight: 1000n, roundBlocks: 100n, commitBlocks: 50n, openBlocks: 20n, revealBlocks: 20n };

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/scouts.json", import.meta.url), "utf8")) as {
  scouts: { qor: string; address: `0x${string}`; seed: string; publicKey: string }[];
};
export const scouts = fixture.scouts.slice(0, 4).map((s) => ({ ...s, keys: mldsa87.keygen(fromHex(s.seed)) }));
export const openerKeys: SealKeyPair = deriveSealKeys({ mnemonic: TEST_MNEMONIC, index: 0 });

export function params(): RoundParams {
  const keys = new Map(scouts.map((s) => [s.qor, s.keys.publicKey]));
  return { ...timing, quorum: 3, bandBps: 200, slashBps: 1000, chainId: CHAIN_ID, rollupId: ROLLUP, operator: OPERATOR, pqKeyOf: (q) => keys.get(q) };
}

export class Inbox {
  entries: InboxEntry[] = [];
  post(height: bigint, poster: string, payload: Uint8Array) {
    this.entries.push({ seq: BigInt(this.entries.length + 1), height, poster, payload });
  }
}

/** REPORT + COMMIT of one scout in the commit window. `sealTo` lets a test seal to the wrong key. */
export function report(inbox: Inbox, round: bigint, s: (typeof scouts)[number], prices: bigint[], opts: { sealTo?: SealKeyPair; commitPrices?: bigint[]; height?: bigint } = {}) {
  const w = roundWindows(round, timing);
  const salt = new Uint8Array(16).fill(7);
  const set = { feedIds: [1, 2], prices };
  const envelope = seal({
    chainId: CHAIN_ID, purpose: reportPurpose(ROLLUP), mode: "mlkem",
    recipients: [{ mlkemPublicKey: (opts.sealTo ?? openerKeys).mlkemPublicKey }],
    plaintext: encodeReportPlaintext({ salt, ...set }), aad: reportAad(round, s.qor),
  });
  const comm = commitment(round, s.address, salt, { feedIds: [1, 2], prices: opts.commitPrices ?? prices });
  const signature = signCommit(s.keys.secretKey, { chainId: CHAIN_ID, rollupId: ROLLUP, round, scout: s.qor, commitment: comm });
  const h = opts.height ?? w.start + 5n;
  inbox.post(h, s.qor, encodeMsg({ kind: "REPORT", round, envelope }));
  inbox.post(h + 1n, s.qor, encodeMsg({ kind: "COMMIT", round, commitment: comm, signature }));
}
