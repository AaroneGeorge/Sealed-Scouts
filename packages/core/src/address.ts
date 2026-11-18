// QoreChain accounts are bech32 "qor1..." strings over 20 bytes. Leaves and commitments use the raw 20 bytes.
import { bech32 } from "@scure/base";
import { ACCOUNT_PREFIX, ADDRESS_BYTES } from "./constants.js";
import { fromHex, toHex, type Hex } from "./bytes.js";

/** 20-byte address of a qor1 account as lowercase 0x hex, or undefined if the string is not a valid qor1 address. */
export function scoutAddress(qor: string): Hex | undefined {
  try {
    const { prefix, words } = bech32.decode(qor as `${string}1${string}`);
    const bytes = bech32.fromWords(words);
    if (prefix !== ACCOUNT_PREFIX || bytes.length !== ADDRESS_BYTES) return undefined;
    return toHex(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/** qor1 bech32 string for a 20-byte address. */
export function qorAddress(addr: Hex | Uint8Array): string {
  const bytes = typeof addr === "string" ? fromHex(addr) : addr;
  if (bytes.length !== ADDRESS_BYTES) throw new RangeError(`address must be ${ADDRESS_BYTES} bytes`);
  return bech32.encode(ACCOUNT_PREFIX, bech32.toWords(bytes));
}
