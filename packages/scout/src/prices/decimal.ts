// Exact decimal handling. Prices are unsigned integers with 8 decimals (docs/SPEC.md); floats never touch them.
import { PRICE_DECIMALS } from "@sealed-scouts/core";

export const ONE = 10n ** BigInt(PRICE_DECIMALS);

/** "1753.81" -> 175381000000n. Extra decimals are cut, not rounded. Throws on anything that is not a positive decimal. */
export function toE8(value: unknown): bigint {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s.trim())) throw new Error(`not a decimal price: ${String(value)}`);
  const [whole, frac = ""] = s.trim().split(".");
  const out = BigInt(whole!) * ONE + BigInt((frac + "0".repeat(PRICE_DECIMALS)).slice(0, PRICE_DECIMALS));
  if (out === 0n) throw new Error("price is zero");
  return out;
}

/** a * b for two 8-decimal values. */
export const mulE8 = (a: bigint, b: bigint): bigint => (a * b) / ONE;

export function formatE8(v: bigint): string {
  const frac = (v % ONE).toString().padStart(PRICE_DECIMALS, "0").replace(/0+$/, "");
  return `${v / ONE}${frac ? `.${frac}` : ""}`;
}
