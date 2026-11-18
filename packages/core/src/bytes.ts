// Byte helpers shared by the codecs and hashes. All integers are big-endian.
import { bytesToHex, hexToBytes } from "viem";

export type Hex = `0x${string}`;

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Unsigned big-endian integer of `size` bytes; throws when the value does not fit. */
export function uintBE(value: bigint | number, size: number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(size * 8)) throw new RangeError(`value ${v} does not fit in ${size} bytes`);
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export const u8 = (v: number) => uintBE(v, 1);
export const u16 = (v: number) => uintBE(v, 2);
export const u64 = (v: bigint | number) => uintBE(v, 8);
export const u128 = (v: bigint) => uintBE(v, 16);

export const toHex = (b: Uint8Array): Hex => bytesToHex(b);
export const fromHex = (h: string): Uint8Array => hexToBytes((h.startsWith("0x") ? h : `0x${h}`) as Hex);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Cursor over a byte array. Every read throws `ShortRead` past the end, so decoders stay strict. */
export class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  get remaining(): number {
    return this.b.length - this.o;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.o + n > this.b.length) throw new ShortRead();
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  uint(size: number): bigint {
    let v = 0n;
    for (const x of this.bytes(size)) v = (v << 8n) | BigInt(x);
    return v;
  }
  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

export class ShortRead extends Error {
  constructor() {
    super("payload too short");
  }
}
