import { describe, expect, it } from "vitest";
import { decodeMsg, encodeMsg, roundWindows, type InboxEntry } from "@sealed-scouts/core";
import { Scout, type ScoutChain } from "../src/scout.js";
import type { PriceReading } from "../src/prices/index.js";
import { CHAIN_ID, ROLLUP_ID, testOpener, testScout } from "./helpers.js";

const timing = { genesisHeight: 100n, roundBlocks: 300n, commitBlocks: 180n, openBlocks: 40n, revealBlocks: 40n };
const reading: PriceReading = { feeds: [{ feedId: 1, price: 175_000_000_000n, sources: ["coinbase", "kraken"] }], skipped: [], failed: [], venues: [] };

function fakeChain(posterOf: () => string) {
  const inbox: InboxEntry[] = [];
  let height = timing.genesisHeight;
  const chain: ScoutChain & { inbox: InboxEntry[]; setHeight(h: bigint): void } = {
    inbox,
    setHeight: (h) => void (height = h),
    height: async () => height,
    inboxHead: async () => BigInt(inbox.length),
    readInbox: async (from, to) => inbox.filter((e) => e.seq > from && e.seq <= to),
    post: async (payloads) => {
      for (const payload of payloads) inbox.push({ seq: BigInt(inbox.length + 1), height, poster: posterOf(), payload });
      return { txHash: `tx${inbox.length}`, code: 0, height };
    },
  };
  return chain;
}

function setup(readPrices = async () => reading) {
  const signer = testScout();
  const operator = testScout().address;
  const opener = testOpener();
  let poster = signer.address;
  const chain = fakeChain(() => poster);
  const scout = new Scout({
    config: { chainId: CHAIN_ID, rollupId: ROLLUP_ID, operator, timing },
    signer, chain, readPrices, openerKemKey: async () => opener.mlkemPublicKey, log: () => {},
  });
  const asOperator = (payload: Uint8Array, height = roundWindows(0n, timing).commitEnd + 1n) => {
    poster = operator;
    chain.inbox.push({ seq: BigInt(chain.inbox.length + 1), height, poster: operator, payload });
    poster = signer.address;
  };
  return { scout, chain, signer, asOperator };
}

const kinds = (inbox: InboxEntry[]) => inbox.map((e) => decodeMsg(e.payload)?.kind);
const w = roundWindows(0n, timing);

describe("Scout.tick", () => {
  it("posts REPORT and COMMIT once per round, in the commit window", async () => {
    const { scout, chain } = setup();
    chain.setHeight(w.start + 3n);
    await scout.tick();
    await scout.tick();
    expect(kinds(chain.inbox)).toEqual(["REPORT", "COMMIT"]);
  });

  it("does not start a post too close to the end of the commit window", async () => {
    const { scout, chain } = setup();
    chain.setHeight(w.commitEnd - 5n);
    await scout.tick();
    expect(chain.inbox).toHaveLength(0);
  });

  it("does not post when no feed has two sources", async () => {
    const { scout, chain } = setup(async () => ({ ...reading, feeds: [], skipped: [{ feedId: 1, reason: "1 source(s), need 2" }] }));
    chain.setHeight(w.start + 3n);
    await scout.tick();
    expect(chain.inbox).toHaveLength(0);
  });

  it("reveals its own report when the operator's OPEN leaves it out", async () => {
    const { scout, chain, asOperator } = setup();
    chain.setHeight(w.start + 3n);
    await scout.tick();
    asOperator(encodeMsg({ kind: "OPEN", round: 0n, openings: [] }));
    chain.setHeight(w.openEnd);
    await scout.tick();
    await scout.tick();
    expect(kinds(chain.inbox)).toEqual(["REPORT", "COMMIT", "OPEN", "REVEAL"]);
  });

  it("stays quiet when the operator opened the report", async () => {
    const { scout, chain, asOperator } = setup();
    chain.setHeight(w.start + 3n);
    const posted = (await scout.report(0n))!;
    asOperator(encodeMsg({ kind: "OPEN", round: 0n, openings: [{ scout: posted.sealed.scout20, salt: posted.sealed.salt, ...posted.sealed.prices }] }));
    chain.setHeight(w.openEnd + 1n);
    await scout.tick();
    expect(kinds(chain.inbox)).toEqual(["REPORT", "COMMIT", "OPEN"]);
  });

  it("an OPEN that lands after the open window does not count: the scout still reveals", async () => {
    const { scout, chain, asOperator } = setup();
    chain.setHeight(w.start + 3n);
    const posted = (await scout.report(0n))!;
    const opening = { scout: posted.sealed.scout20, salt: posted.sealed.salt, ...posted.sealed.prices };
    asOperator(encodeMsg({ kind: "OPEN", round: 0n, openings: [opening] }), w.openEnd);
    chain.setHeight(w.openEnd + 1n);
    await scout.tick();
    expect(kinds(chain.inbox).at(-1)).toBe("REVEAL");
  });

  it("an OPEN with the wrong salt does not count as opening our report", async () => {
    const { scout, chain, asOperator } = setup();
    chain.setHeight(w.start + 3n);
    const posted = (await scout.report(0n))!;
    asOperator(encodeMsg({ kind: "OPEN", round: 0n, openings: [{ scout: posted.sealed.scout20, salt: new Uint8Array(16), ...posted.sealed.prices }] }));
    chain.setHeight(w.openEnd + 1n);
    await scout.tick();
    expect(kinds(chain.inbox).at(-1)).toBe("REVEAL");
  });
});
