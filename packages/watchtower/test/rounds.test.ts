import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromHex, jsonify, resultFromJson, type RoundParams } from "@sealed-scouts/core";
import { entryFromJson } from "@sealed-scouts/core";
import { checkRound, type FeedRound } from "../src/rounds.js";
import { feedRoundFor } from "../src/scenario.js";

const dir = new URL("../../../fixtures/", import.meta.url);
const keys = new Map<string, Uint8Array>(
  JSON.parse(readFileSync(new URL("scouts.json", dir), "utf8")).scouts.map((s: any) => [s.qor, fromHex(s.publicKey)]),
);
const fixtures = readdirSync(new URL("rounds/", dir)).filter((f) => f.endsWith(".json")).sort();

function load(name: string) {
  const f = JSON.parse(readFileSync(new URL(`rounds/${name}`, dir), "utf8"));
  const p = f.params;
  const params: RoundParams = {
    ...p,
    genesisHeight: BigInt(p.genesisHeight), roundBlocks: BigInt(p.roundBlocks), commitBlocks: BigInt(p.commitBlocks),
    openBlocks: BigInt(p.openBlocks), revealBlocks: BigInt(p.revealBlocks),
    pqKeyOf: (s: string) => (f.registered.includes(s) ? keys.get(s) : undefined),
  };
  return { f, params, entries: f.entries.map(entryFromJson), eligible: (s: string) => f.eligible.includes(s), round: BigInt(f.round) };
}

describe("checkRound on the core fixture rounds", () => {
  it("found the fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(12));

  it.each(fixtures)("%s: replay equals the expected result", (name) => {
    const { f, params, entries, eligible, round } = load(name);
    const c = checkRound(entries, round, params, eligible);
    expect(jsonify(c.derived)).toEqual(jsonify(resultFromJson(f.expected)));
    expect(c.verdict).toBe(f.expected.status === "no-quorum" ? "no-quorum" : "not-posted");
    // Every report the opener skipped shows up as left out, revealed or lost.
    for (const s of c.derived.skippedByOpener) expect(c.leftOut).toContainEqual({ scout: s, how: "revealed" });
  });

  it("flags a committed report nobody opened as lost", () => {
    const { params, entries, eligible, round } = load("04-missing-open-no-reveal.json");
    const c = checkRound(entries, round, params, eligible);
    expect(c.leftOut.filter((l) => l.how === "lost").length).toBeGreaterThan(0);
  });

  describe("against what the feed holds", () => {
    const { params, entries, eligible, round } = load("01-honest.json");
    const honest = checkRound(entries, round, params, eligible);
    const feed = (patch: Partial<FeedRound>): FeedRound => ({ ...feedRoundFor(honest.derived, "pending"), ...patch });

    it("match when the feed equals the replay", () => {
      expect(checkRound(entries, round, params, eligible, feed({})).verdict).toBe("match");
    });
    it("median-wrong when only a median differs (the court can fix this)", () => {
      const f = feed({});
      expect(checkRound(entries, round, params, eligible, { ...f, medians: [1n, ...f.medians.slice(1)] }).verdict).toBe("median-wrong");
      expect(checkRound(entries, round, params, eligible, { ...f, counts: [9, ...f.counts.slice(1)] }).verdict).toBe("median-wrong");
      expect(checkRound(entries, round, params, eligible, { ...f, feedIds: f.feedIds.slice(1), medians: f.medians.slice(1), counts: f.counts.slice(1) }).verdict).toBe("median-wrong");
    });
    it("root-wrong when the operator committed a different report set", () => {
      expect(checkRound(entries, round, params, eligible, feed({ reportsRoot: `0x${"11".repeat(32)}` })).verdict).toBe("root-wrong");
      expect(checkRound(entries, round, params, eligible, feed({ reportCount: 4 })).verdict).toBe("root-wrong");
    });
    it("corrected once the court replaced the median", () => {
      expect(checkRound(entries, round, params, eligible, feed({ status: "corrected" })).verdict).toBe("corrected");
    });
    it("not-posted when the feed has no such round", () => {
      expect(checkRound(entries, round, params, eligible, feed({ status: "none" })).verdict).toBe("not-posted");
    });
  });
});
