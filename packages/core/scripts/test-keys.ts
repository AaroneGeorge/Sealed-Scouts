// TEST-ONLY keys for fixtures and vectors. Seeds are public, derived from fixed labels.
// Never fund these accounts and never use these keys on any chain.
import { mldsa87 } from "@qorechain/pqc";
import { sha256 } from "viem";
import { fromHex, qorAddress, toHex, utf8, type Hex } from "../src/index.js";

export interface TestKey {
  label: string;
  /** 32-byte ML-DSA-87 seed (public, test only). */
  seed: Hex;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** Made-up 20-byte account address; nobody holds its classical key. */
  address: Hex;
  qor: string;
}

const derive = (what: string) => fromHex(sha256(utf8(`sealed-scouts/TEST-ONLY/${what}`)));

const cache = new Map<string, TestKey>();
export function testKey(label: string): TestKey {
  let k = cache.get(label);
  if (!k) {
    const seed = derive(`mldsa87/${label}`);
    const { publicKey, secretKey } = mldsa87.keygen(seed);
    const address = toHex(derive(`address/${label}`).slice(0, 20));
    k = { label, seed: toHex(seed), publicKey, secretKey, address, qor: qorAddress(address) };
    cache.set(label, k);
  }
  return k;
}

/** Deterministic test bytes, e.g. salts. */
export const testBytes = (what: string, n: number): Uint8Array => derive(`bytes/${what}`).slice(0, n);
