// Measures qledger fraud-proof sizes offline with the RDK's own builder, to check that a MsgChallengeBatch
// always fits what the public endpoint accepts. No network.
//   npx tsx ops/proof-size.ts
import {
  QLEDGER_MAX_BATCH_ENTRIES, QLEDGER_MAX_POST_BYTES, QledgerLedger, EMPTY_INBOX_ACC, buildQledgerFraudProof,
  encodeQledgerDeposit, encodeQledgerTx, executeQledger, qledgerKeypairFromSeed, signQledgerTx, type QledgerEntry,
} from "@qorechain/rdk";

const env = { chainId: "qorechain-diana", rollupId: "sealed-scouts-1" };
const poster = "qor1gydsf0760dumk23gzph45w5y8gltuch8zfn9qf";
const N = QLEDGER_MAX_BATCH_ENTRIES;

function measure(label: string, parent: QledgerLedger, entries: QledgerEntry[]) {
  const { proof } = buildQledgerFraudProof(env, parent.clone(), EMPTY_INBOX_ACC, entries);
  const payload = entries.reduce((s, e) => s + e.payload.length, 0);
  console.log(`${label}: ${entries.length} entries, ${payload} payload bytes -> proof ${proof.length} bytes`);
  return proof.length;
}

// 1. Largest no-op posts the inbox takes (6,144 bytes each): touch no ledger account.
const big = Array.from({ length: N }, (_, i) => ({ height: 1000 + i, poster, payload: new Uint8Array(QLEDGER_MAX_POST_BYTES).fill(0x53) }));
const a = measure("64 max-size posts", new QledgerLedger(), big);

// 2. Worst ledger case: 64 transfers, each from a different funded account to a different new account,
//    so every entry needs two fresh state witnesses.
const parent = new QledgerLedger();
const keys = Array.from({ length: N }, (_, i) => qledgerKeypairFromSeed(new Uint8Array(32).fill(i + 1)));
executeQledger(env, parent, keys.map((k, i) => ({ height: 10 + i, poster: `deposit:${poster}`, payload: encodeQledgerDeposit(k.accountId, 5_000_000n) })));
const transfers = keys.map((k, i) => ({
  height: 2000 + i,
  poster,
  payload: encodeQledgerTx(signQledgerTx({ ...env, secretKey: k.secretKey, publicKey: k.publicKey, nonce: 0, amount: 1n, to: new Uint8Array(32).fill(200 - i) })),
}));
const b = measure("64 transfers, 128 distinct accounts", parent, transfers);

const LIMIT = 749_000; // signed tx bytes the public REST endpoint accepts (1,000,000-byte body, base64)
console.log(`worst case ${Math.max(a, b)} bytes vs ${LIMIT} usable: ${Math.max(a, b) < LIMIT - 20_000 ? "fits with room for the tx envelope" : "DOES NOT FIT"}`);
