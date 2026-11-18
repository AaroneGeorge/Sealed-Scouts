import { bech32 } from "@scure/base";
import { bytesToHex, hexToBytes } from "viem";
import type { Hex } from "./types";

/**
 * QoreChain REST returns byte fields either as hex (batch roots) or as base64 (anchor fields).
 * Same rule as the chain's own clients: even-length pure hex is hex, anything else is base64.
 */
export function decodeWire(value: string | null | undefined): Uint8Array {
  if (!value) return new Uint8Array();
  const isHex = value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
  if (isHex) return hexToBytes(`0x${value}`);
  const bin = atob(value);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const wireHex = (value: string | null | undefined): Hex => bytesToHex(decodeWire(value));

/** A native `qor1…` address and its EVM twin are the same 20 bytes. */
export function qorToHex(address: string): Hex {
  const { prefix, words } = bech32.decode(address as `${string}1${string}`, 120);
  if (prefix !== "qor") throw new Error(`not a qor address: ${address}`);
  return bytesToHex(Uint8Array.from(bech32.fromWords(words)));
}
