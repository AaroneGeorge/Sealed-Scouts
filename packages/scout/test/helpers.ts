import { randomBytes } from "node:crypto";
import { generateSealKeys } from "@qorechain/qoreseal";
import { pqKeyFromSeed } from "@qorechain/qoresign";
import { qorAddress } from "@sealed-scouts/core";
import fixtures from "./fixtures/venues.json" with { type: "json" };
import type { GetJson } from "../src/prices/index.js";

export const CHAIN_ID = "qorechain-diana";
export const ROLLUP_ID = "sealed-scouts-test";

/** A scout identity with fresh in-memory keys. */
export function testScout() {
  const pq = pqKeyFromSeed(new Uint8Array(randomBytes(32)));
  return { address: qorAddress(new Uint8Array(randomBytes(20))), keys: { pqc: { publicKey: pq.publicKey, secretKey: pq.secretKey } } };
}

export const testOpener = () => generateSealKeys();

/** Serves the recorded venue responses; URLs in `fail` answer with an error. */
export function recordedGet(fail: (url: string) => boolean = () => false): GetJson & { calls: string[] } {
  const calls: string[] = [];
  const responses = fixtures.responses as Record<string, unknown>;
  const get = async (url: string) => {
    calls.push(url);
    if (fail(url)) throw new Error(`HTTP 503 from ${new URL(url).host}`);
    if (!(url in responses)) throw new Error(`no fixture for ${url}`);
    return structuredClone(responses[url]);
  };
  return Object.assign(get, { calls });
}
