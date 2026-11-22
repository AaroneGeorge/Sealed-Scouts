import { describe, expect, it } from "vitest";
import { bpsFrom, formatPrice, shortHash } from "../src/lib/format";
import { parseRoute } from "../src/lib/router";

describe("formatPrice (8 decimals)", () => {
  it("shows two decimals for large prices", () => expect(formatPrice("179291000000")).toBe("1,792.91"));
  it("shows four decimals under 10", () => expect(formatPrice("99884000")).toBe("0.9988"));
  it("truncates instead of rounding", () => expect(formatPrice("199999999")).toBe("1.9999"));
});

describe("bpsFrom", () => {
  it("is signed", () => {
    expect(bpsFrom("102", "100")).toBe(200);
    expect(bpsFrom("90", "100")).toBe(-1000);
  });
  it("is 0 for a zero median", () => expect(bpsFrom("5", "0")).toBe(0));
});

describe("shortHash", () => {
  it("keeps the 0x prefix", () => expect(shortHash(`0x${"a".repeat(64)}`, 4)).toBe("0xaaaa…aaaa"));
  it("leaves short values alone", () => expect(shortHash("abc")).toBe("abc"));
});

describe("parseRoute", () => {
  it("reads a round", () => expect(parseRoute("#/round/417")).toMatchObject({ page: "round", param: "417" }));
  it("reads verify with a query", () => {
    const r = parseRoute("#/verify?rollup=vigil-1&batch=28");
    expect(r.page).toBe("verify");
    expect(r.query.get("batch")).toBe("28");
  });
  it("falls back to rounds", () => expect(parseRoute("#/nope").page).toBe("rounds"));
  it("reads an anchor after a second #", () => {
    expect(parseRoute("#/attacks#bad-batch")).toMatchObject({ page: "attacks", anchor: "bad-batch" });
    expect(parseRoute("#/verify?batch=2#x")).toMatchObject({ page: "verify", anchor: "x" });
    expect(parseRoute("#/verify?batch=2#x").query.get("batch")).toBe("2");
    expect(parseRoute("#/attacks").anchor).toBeUndefined();
    expect(parseRoute("#/attacks#<b>").anchor).toBeUndefined();
  });
});
