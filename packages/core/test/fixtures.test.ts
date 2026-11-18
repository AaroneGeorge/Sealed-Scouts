import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonify, resultFromJson } from "../src/index.js";
import { buildFixtures, assertChecks } from "../scripts/gen-fixtures.js";
import { buildVectors } from "../scripts/gen-vectors.js";
import { loadFixture, runFixture } from "../scripts/fixture-io.js";
import { FIXTURES_DIR } from "../scripts/write-json.js";

const read = (rel: string) => JSON.parse(readFileSync(resolve(FIXTURES_DIR, rel), "utf8"));
const scouts = read("scouts.json").scouts;
const rounds = readdirSync(resolve(FIXTURES_DIR, "rounds")).filter((f) => f.endsWith(".json")).sort();

describe("fixture rounds", () => {
  it("has at least 12 rounds", () => expect(rounds.length).toBeGreaterThanOrEqual(12));

  it.each(rounds)("%s derives the stored result and passes its hand-written checks", (file) => {
    const f = read(`rounds/${file}`);
    const result = runFixture(loadFixture(f, scouts));
    expect(jsonify(result)).toEqual(f.expected);
    expect(jsonify(resultFromJson(f.expected))).toEqual(f.expected);
    assertChecks(f.name, result, f.checks);
  });
});

describe("generated files are up to date", () => {
  it("vectors", () => {
    for (const [rel, v] of Object.entries(buildVectors())) expect(jsonify(v), rel).toEqual(read(rel));
  });
  it("fixtures", () => {
    for (const [rel, v] of Object.entries(buildFixtures())) expect(jsonify(v), rel).toEqual(read(rel));
  }, 30_000);
});
