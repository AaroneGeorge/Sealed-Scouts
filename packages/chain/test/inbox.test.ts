import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_INBOX_ACC, bytesToHex, fetchQledgerEntries, inboxAccumulate, postedDataHash } from "@qorechain/rdk";
import { defaultConfig } from "../src/config.js";
import { INBOX_READ_CHUNK, InboxReader } from "../src/inbox.js";
import type { FetchLike } from "../src/http.js";

const ROLLUP = "test-rollup";
const config = { ...defaultConfig({}), signBytesVersion: "v2" as const };

interface Post {
  seq: bigint;
  height: bigint;
  poster: string;
  payload: Uint8Array;
  acc: string;
}

/** A fake chain holding `n` posts, with accumulators computed exactly as the chain does. */
function fakeChain(n: number) {
  const posts: Post[] = [];
  let acc: Uint8Array = EMPTY_INBOX_ACC;
  for (let i = 1; i <= n; i++) {
    const p = { seq: BigInt(i), height: BigInt(1000 + i * 3), poster: `qor1poster${i % 2}`, payload: new Uint8Array([0x53, 0x53, 0x43, 0x31, i]) };
    acc = inboxAccumulate({ chainId: config.chainId, rollupId: ROLLUP, prevAcc: acc, sequence: p.seq, height: p.height, poster: p.poster, dataHash: postedDataHash(p.payload) });
    posts.push({ ...p, acc: bytesToHex(acc) });
  }
  const pruned = new Set<bigint>();
  const queries: string[] = [];
  /** What the tx index serves; a test may tamper with it. */
  const served = new Map(posts.map((p) => [p.seq, p.payload]));
  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 300, status, statusText: "", json: async () => body, text: async () => JSON.stringify(body) });
  const fetch: FetchLike = async (url) => {
    const u = new URL(url);
    if (u.pathname === `/qorechain/rdk/v1/inbox/${ROLLUP}`) {
      const head = posts.at(-1)!;
      return json(200, { inbox: { rollup_id: ROLLUP, head_sequence: String(head.seq), head_acc: head.acc, consumed_sequence: "0", consumed_acc: "" } });
    }
    const pd = new RegExp(`/qorechain/rdk/v1/posted_data/${ROLLUP}/(\\d+)$`).exec(u.pathname);
    if (pd) {
      const p = posts.find((x) => x.seq === BigInt(pd[1]!));
      if (!p || pruned.has(p.seq)) return json(404, { code: 5, message: "not found" });
      return json(200, { posted_data: { rollup_id: ROLLUP, sequence: String(p.seq), height: String(p.height), poster: p.poster, inbox_acc: p.acc } });
    }
    if (u.pathname === "/cosmos/tx/v1beta1/txs") {
      const q = u.searchParams.get("query")!;
      queries.push(q);
      if (!q.startsWith("rdk_data_posted")) return json(200, { tx_responses: [], total: "0" });
      const minHeight = BigInt(/tx\.height>=(\d+)/.exec(q)?.[1] ?? "0");
      const maxHeight = BigInt(/tx\.height<=(\d+)/.exec(q)?.[1] ?? String(2n ** 62n));
      // Paged like the node: the RDK reads at most 50 pages of `limit`, oldest first.
      const page = Number(u.searchParams.get("page") ?? "1");
      const limit = Number(u.searchParams.get("limit") ?? "100");
      const all = posts.filter((p) => p.height >= minHeight && p.height <= maxHeight);
      const txs = all.slice((page - 1) * limit, page * limit).map((p) => {
        const data = served.get(p.seq)!;
        return {
          height: String(p.height),
          txhash: `TX${p.seq}`,
          tx: { body: { messages: [{ "@type": "/qorechain.rdk.v1.MsgPostRollupData", poster: p.poster, rollup_id: ROLLUP, data: Buffer.from(data).toString("base64") }] } },
          events: [{ type: "rdk_data_posted", attributes: [
            { key: "rollup_id", value: ROLLUP }, { key: "sequence", value: String(p.seq) },
            { key: "data_hash", value: bytesToHex(postedDataHash(data)) }, { key: "poster", value: p.poster },
          ] }],
        };
      });
      return json(200, { tx_responses: txs, total: String(all.length) });
    }
    return json(404, { message: `no mock for ${u.pathname}` });
  };
  return { posts, pruned, queries, served, fetch, reader: new InboxReader({ config, fetch }) };
}

describe("InboxReader.read", () => {
  let c: ReturnType<typeof fakeChain>;
  beforeEach(() => {
    c = fakeChain(6);
  });

  it("returns the inclusive range with sequence, height, poster and bytes", async () => {
    const es = await c.reader.read(ROLLUP, 2n, 4n);
    expect(es.map((e) => e.seq)).toEqual([2n, 3n, 4n]);
    expect(es[0]).toEqual({ seq: 2n, height: c.posts[1]!.height, poster: c.posts[1]!.poster, payload: c.posts[1]!.payload });
  });

  it("starts the tx search at the height of the post before the range", async () => {
    await c.reader.read(ROLLUP, 4n, 6n);
    expect(c.queries[0]).toContain(`tx.height>=${c.posts[2]!.height}`);
  });

  it("falls back to an earlier start and the head when commitments were pruned", async () => {
    c.pruned.add(3n);
    c.pruned.add(5n);
    const es = await c.reader.read(ROLLUP, 4n, 5n);
    expect(es.map((e) => e.seq)).toEqual([4n, 5n]);
  });

  it("throws when the bytes do not match the chain's accumulator", async () => {
    c.served.set(3n, new Uint8Array([0x53, 0x53, 0x43, 0x31, 99]));
    await expect(c.reader.read(ROLLUP, 1n, 4n)).rejects.toThrow(/do not match the chain.s inbox accumulator/);
  });

  it("throws on a range past the head or an empty range, never returns nothing", async () => {
    await expect(c.reader.read(ROLLUP, 5n, 9n)).rejects.toThrow(/ends at 6/);
    await expect(c.reader.read(ROLLUP, 3n, 2n)).rejects.toThrow(/bad inbox range/);
  });
});

// The RDK's searchTxs stops after 50 pages of 100 transactions without an error. The live operator hit it once
// the rollup's history passed 5000 posting transactions: every later entry read as "not found in the node's
// transaction index", and every tick failed from then on.
describe("past the RDK's 5000-transaction search cap", () => {
  const N = 5_150;
  let c: ReturnType<typeof fakeChain>;
  beforeEach(() => {
    c = fakeChain(N);
  });

  it("an unbounded search misses the newest entries (the failure this guards against)", async () => {
    await expect(
      fetchQledgerEntries(c.reader.rest, { chainId: config.chainId, rollupId: ROLLUP, from: 5_090n, to: 5_110n, accFrom: c.posts[5_089]!.acc }),
    ).rejects.toThrow(/inbox entry 5091 of rollup test-rollup was not found in the node's transaction index/);
  });

  it("read() covers the whole history in bounded chunks", async () => {
    const es = await c.reader.read(ROLLUP, 1n, BigInt(N));
    expect(es.map((e) => e.seq)).toEqual(c.posts.map((p) => p.seq));
    expect(c.queries.length).toBeGreaterThanOrEqual(Math.ceil(N / Number(INBOX_READ_CHUNK)));
    expect(c.queries.every((q) => /tx\.height<=\d+/.test(q))).toBe(true);
  });

  it("searchWindow bounds the plan's search to the posts a batch can consume", async () => {
    const consumed = 5_050n;
    const rest = await c.reader.searchWindow(ROLLUP, consumed + 1n, consumed + 64n);
    expect(rest.minHeight).toBe(c.posts[5_050]!.height); // post 5051
    expect(rest.maxHeight).toBe(c.posts[5_113]!.height); // post 5114
    const entries = await fetchQledgerEntries(rest, { chainId: config.chainId, rollupId: ROLLUP, from: consumed, to: consumed + 64n, accFrom: c.posts[5_049]!.acc });
    expect(entries).toHaveLength(64);
    expect(entries[0]!.payload).toEqual(c.posts[5_050]!.payload);
  });

  it("searchWindow leaves a bound open when the chain no longer holds the posts near it", async () => {
    for (let s = 5_094n; s <= 5_101n; s++) c.pruned.add(s);
    const rest = await c.reader.searchWindow(ROLLUP, 5_101n);
    expect(rest.minHeight).toBe(0n);
    expect(rest.maxHeight).toBeUndefined();
  });
});
