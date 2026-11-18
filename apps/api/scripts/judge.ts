/**
 * `npm run judge`: checks the latest Sealed Scouts round end to end against the public QoreChain testnet.
 * Needs no key and no account. Reads deployments/diana.json and the watchtower feed; everything else comes from
 * the chain. Exit 0 = every check passed, 1 = a check failed, 3 = incomplete (something is not live yet).
 *
 *   npm run judge                              our rollup, latest batch
 *   npm run judge -- --rollup vigil-1          the same receipt checks on any other live rollup
 *   npm run judge -- --batch 12 --feed-url https://demo.example/api/feed
 *
 * By default the price-round checks use a fresh local replay by the watchtower (observe mode), not our feed.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  anchorSignBytesForBatch, bech32ToHex, buildSettlementReceipt, createRdkClient, decodeWireBytes, verifySettlementReceipt,
  type SettlementReceipt,
} from "@qorechain/rdk";
import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from "viem";
import { REPO_ROOT } from "../src/config.js";
import { USER_AGENT } from "../src/upstream.js";

const EVM_RPC = process.env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host";
const CHAIN_ID = "qorechain-diana";
const PQC_VERIFY = "0x0000000000000000000000000000000000000a01";
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02";

const { values: args } = parseArgs({
  options: {
    rollup: { type: "string" },
    batch: { type: "string" },
    "feed-url": { type: "string" },
    "feed-dir": { type: "string" },
  },
});

type Outcome = "PASS" | "FAIL" | "SKIP";
const results: { name: string; outcome: Outcome; required: boolean }[] = [];
const started = Date.now();

function line(outcome: Outcome, name: string, detail: string, required = true) {
  results.push({ name, outcome, required });
  const mark = { PASS: "\x1b[32mPASS\x1b[0m", FAIL: "\x1b[31mFAIL\x1b[0m", SKIP: "\x1b[33mSKIP\x1b[0m" }[outcome];
  console.log(`${mark}  ${name}\n      ${detail}`);
}

const politeFetch: typeof fetch = (url, init) =>
  fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "user-agent": USER_AGENT } });

async function evmCall(to: string, abi: Abi, functionName: string, fnArgs: unknown[]): Promise<unknown> {
  const data = encodeFunctionData({ abi, functionName, args: fnArgs } as never);
  const res = await politeFetch(EVM_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const body = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  if (!body.result || body.result === "0x") throw new Error(`${functionName} returned no data`);
  return decodeFunctionResult({ abi, functionName, data: body.result } as never);
}

const precompiles = [
  { type: "function", name: "pqcVerify", stateMutability: "view", inputs: [{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }] },
] as const satisfies Abi;

const att = { type: "tuple", components: [
  { name: "round", type: "uint64" }, { name: "batchIndex", type: "uint64" }, { name: "inboxStart", type: "uint64" },
  { name: "inboxEnd", type: "uint64" }, { name: "closeHeight", type: "uint64" }, { name: "closeTime", type: "uint64" },
  { name: "feedIds", type: "uint16[]" }, { name: "medians", type: "uint128[]" }, { name: "counts", type: "uint8[]" },
  { name: "reportsRoot", type: "bytes32" }, { name: "reportCount", type: "uint16" }] } as const;
const priceFeedAbi = [
  { type: "function", name: "verifyReceipt", stateMutability: "view",
    inputs: [att, { type: "bytes32" }, { type: "uint64" }, { type: "bytes" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "latest", stateMutability: "view", inputs: [{ type: "uint16" }],
    outputs: [{ type: "uint128" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }] },
  { type: "function", name: "twoSigMode", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

const SIG_HEX = 2 * 4627;

/** QoreSign bytes of the round signature in two-signature mode (docs/SPEC.md, Changes 14). */
const roundSigBytes = (rollupId: string, round: string, roundHash: string) =>
  hex0x(Buffer.from(`qorechain-msg-v1|${CHAIN_ID}|sealed-scouts/round/v1|${rollupId}|${round}|${roundHash.replace(/^0x/, "").toLowerCase()}`).toString("hex"));

interface AnchorRaw { layer_height: string; state_root: string | null; validator_set_hash: string | null; pqc_aggregate_signature: string | null; transaction_count: string }

/**
 * The anchor for one batch, read straight from REST: the chain lists a layer's anchors in one response today, but we
 * follow `next_key` in case it pages, then fall back to the newest anchor. Independent of the RDK's own lookup.
 */
async function findAnchor(layerId: string, batchIndex: number, rootHex: string): Promise<AnchorRaw | undefined> {
  const rest = process.env.QORE_REST ?? "https://api-testnet.qore.host";
  const get = async <T>(path: string) => (await (await politeFetch(rest + path)).json()) as T;
  const hit = (a?: AnchorRaw) => !!a && Number(a.layer_height) === batchIndex && hex0x(Buffer.from(decodeWireBytes(a.state_root ?? "")).toString("hex")) === hex0x(rootHex);
  const base = `/qorechain/multilayer/v1/anchors/${encodeURIComponent(layerId)}`;
  let key: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = await get<{ anchors?: AnchorRaw[]; pagination?: { next_key?: string | null } }>(key ? `${base}?pagination.key=${encodeURIComponent(key)}` : base);
    const found = (r.anchors ?? []).find(hit);
    if (found) return found;
    key = r.pagination?.next_key ?? undefined;
    if (!key) break;
  }
  const latest = await get<{ anchor?: AnchorRaw }>(`/qorechain/multilayer/v1/anchor/${encodeURIComponent(layerId)}`);
  return hit(latest.anchor) ? latest.anchor : undefined;
}

const wire = (v: string | null) => hex0x(Buffer.from(decodeWireBytes(v ?? "")).toString("hex"));

const hex0x = (h: string) => (h.startsWith("0x") ? h : `0x${h}`) as Hex;

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface Deployments { rollupId?: string; demoUrl?: string; priceFeed?: string; contracts?: { PriceFeed?: string } }
/** The parts of the watchtower's feed files (packages/watchtower) that the judge reads. */
interface RoundFile {
  round: string;
  verdict: string;
  feed: { status: string; batchIndex: string } | null;
  roundHash?: string;
  /** Two-signature mode, and the anchorSig argument as posted to PriceFeed (anchorSig ‖ roundSig in that mode). */
  twoSig?: boolean;
  anchorSig?: string;
  attestation?: { round: string; batchIndex: string; inboxStart: string; inboxEnd: string; closeHeight: string; closeTime: string;
    feedIds: number[]; medians: string[]; counts: number[]; reportsRoot: string; reportCount: number };
}
interface StatusFile { rollupId: string; latestRounds: { round: string }[] }

/**
 * Replays the rounds here, with the watchtower in observe mode (no key), into a temporary folder. This is the
 * strongest check: nothing from our servers is trusted. Returns the folder, or undefined if it did not finish in time.
 */
async function replayLocally(): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "sealed-scouts-judge-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--observe", "--once", "--feed-dir", dir],
    { cwd: join(REPO_ROOT, "packages/watchtower"), stdio: "ignore" });
  const timer = setTimeout(() => child.kill(), 90_000);
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  clearTimeout(timer);
  return code === 0 ? dir : undefined;
}

/** The watchtower feed: our own local replay, else a URL (the hosted demo), else a local folder. */
async function feedReader(deployments: Deployments | undefined) {
  if (!args["feed-url"] && !args["feed-dir"] && deployments) {
    console.log("Replaying the rounds locally with the watchtower (observe mode, no key)...");
    const dir = await replayLocally();
    if (dir) return <T>(name: string) => readJson<T>(join(dir, name));
    console.log("note: the local replay did not finish in 90 s; reading the published feed instead.");
  }
  const url = args["feed-url"] ?? (deployments?.demoUrl ? `${deployments.demoUrl.replace(/\/+$/, "")}/api/feed` : undefined);
  if (url) {
    return async <T>(name: string): Promise<T | undefined> => {
      const r = await politeFetch(`${url}/${name}`);
      return r.ok ? ((await r.json()) as T) : undefined;
    };
  }
  const dir = args["feed-dir"] ?? join(REPO_ROOT, "feed");
  return <T>(name: string) => readJson<T>(join(dir, name));
}

async function main() {
  const deployments = await readJson<Deployments>(join(REPO_ROOT, "deployments/diana.json"));
  const rollupId = args.rollup ?? deployments?.rollupId ?? "sealed-scouts-1";
  const ours = !args.rollup || args.rollup === deployments?.rollupId;
  const client = createRdkClient({ network: "testnet", fetch: politeFetch } as never);
  console.log(`Sealed Scouts judge: rollup ${rollupId} on ${CHAIN_ID}. No key needed.\n`);
  if (!deployments) console.log("note: deployments/diana.json is not in the repo yet; using defaults.\n");

  // 1. The rollup exists and runs the fixed ledger with fraud proofs.
  let rollup;
  try {
    rollup = await client.rest.getRollup(rollupId);
  } catch (e) {
    line("SKIP", "Rollup on chain", `rollup ${rollupId} is not on chain yet (${(e as Error).message}). Try --rollup vigil-1 to see the checks run.`);
    return finish();
  }
  const shapeOk = rollup.settlementMode === "optimistic" && rollup.status === "active";
  line(shapeOk ? "PASS" : "FAIL", "Rollup on chain",
    `${rollupId}: ${rollup.settlementMode}, ${rollup.status}, layer ${rollup.layerId}, creator ${rollup.creator}`);

  // 2. The latest batch's settlement receipt, built and verified by the RDK: 6 checks against chain state.
  const batchIndex = args.batch ? Number(args.batch) : (await client.rest.getLatestBatch(rollupId)).batchIndex;
  let receipt: SettlementReceipt | undefined;
  try {
    receipt = await buildSettlementReceipt(client, rollupId, batchIndex);
    const v = await verifySettlementReceipt(receipt, { client });
    const checks = Object.entries(v.checks).map(([k, ok]) => `${ok ? "+" : "-"}${k}`).join(" ");
    line(v.valid ? "PASS" : "FAIL", `Settlement receipt for batch ${batchIndex} (RDK, 6 checks)`, `${checks}${v.reason ? `: ${v.reason}` : ""}`);
  } catch (e) {
    line("FAIL", `Settlement receipt for batch ${batchIndex} (RDK, 6 checks)`, (e as Error).message);
  }

  // The same anchor, read by us (paged), for the checks below; they do not depend on the RDK's lookup.
  const batch = await client.rest.getBatch(rollupId, batchIndex);
  const raw = await findAnchor(rollup.layerId, batchIndex, Buffer.from(decodeWireBytes(batch.stateRoot)).toString("hex"));
  if (!raw) {
    line("FAIL", "Anchor for the batch", `no anchor on layer ${rollup.layerId} commits batch ${batchIndex}`);
    return finish();
  }
  const anchor = { stateRoot: wire(raw.state_root), vsh: wire(raw.validator_set_hash), txCount: Number(raw.transaction_count), sig: wire(raw.pqc_aggregate_signature) };

  // 3. The same receipt with one digit changed must be refused.
  if (receipt) {
    const forged = { ...receipt, transactionCount: (receipt.transactionCount ?? 0) + 1 };
    const vf = await verifySettlementReceipt(forged, { client });
    line(vf.valid ? "FAIL" : "PASS", "Changed receipt is refused", vf.valid ? "a forged receipt verified!" : `refused: ${vf.reason}`);
  }

  // 4. The same anchor signature checked by the chain's EVM precompile, with the key the EVM itself reports.
  const [registered, alg, pubkey] = (await evmCall(PQC_KEY_STATUS, precompiles, "pqcKeyStatus", [hex0x(bech32ToHex(rollup.creator))])) as [boolean, number, Hex, boolean];
  const message = anchorSignBytesForBatch({
    chainId: CHAIN_ID, layerId: rollup.layerId, batchIndex, stateRoot: anchor.stateRoot.slice(2),
    txCount: anchor.txCount, ...(anchor.vsh !== "0x" ? { validatorSetHash: anchor.vsh.slice(2) } : {}),
  } as never);
  const okSig = registered && alg === 1 && (await evmCall(PQC_VERIFY, precompiles, "pqcVerify", [pubkey, anchor.sig, hex0x(Buffer.from(message).toString("hex"))])) === true;
  const bad = Uint8Array.from(message);
  bad[bad.length - 9] ^= 1;
  const badSig = (await evmCall(PQC_VERIFY, precompiles, "pqcVerify", [pubkey, anchor.sig, hex0x(Buffer.from(bad).toString("hex"))])) === true;
  line(okSig && !badSig ? "PASS" : "FAIL", "pqcVerify on the EVM (eth_call)",
    `key from pqcKeyStatus: ${registered ? `ML-DSA-87, ${(pubkey.length - 2) / 2} bytes` : "not registered"}; anchor bytes ${message.length} B -> ${okSig}; one bit changed -> ${badSig}`);

  if (!ours) {
    console.log("\nOther rollup: price-round checks apply only to sealed-scouts.");
    return finish();
  }

  // 5. The watchtower's replay of the round in this batch, and the price round riding in the anchor: the signed
  //    validator_set_hash equals the round hash in the feed. Run your own replay with no key:
  //    npm run watchtower -w @sealed-scouts/watchtower -- --observe --once
  const feed = await feedReader(deployments);
  const status = await feed<StatusFile>("status.json");
  let round: RoundFile | undefined;
  for (const r of [...(status?.latestRounds ?? [])].reverse()) {
    const f = await feed<RoundFile>(`rounds/${r.round}.json`);
    if (f?.feed && Number(f.feed.batchIndex) === batchIndex) {
      round = f;
      break;
    }
  }
  if (round) line(round.verdict === "match" || round.verdict === "corrected" ? "PASS" : "FAIL", `Watchtower replay of round ${round.round}`, `verdict ${round.verdict}; PriceFeed status ${round.feed!.status}`);
  const priceFeed = deployments?.contracts?.PriceFeed ?? deployments?.priceFeed;
  const twoSig = round?.twoSig ?? (priceFeed ? ((await evmCall(priceFeed, priceFeedAbi, "twoSigMode", [])) as boolean) : false);
  if (!round || !round.roundHash) {
    line("SKIP", "Creator signed the price round", !status ? "no watchtower feed found (pass --feed-url or --feed-dir)"
      : !round ? `the feed has no round in batch ${batchIndex}` : "the feed does not carry the round hash yet");
  } else if (!twoSig) {
    const ok = anchor.vsh.toLowerCase() === round.roundHash.toLowerCase();
    line(ok ? "PASS" : "FAIL", `Round ${round.round} bound into the anchor`, `anchor slot ${anchor.vsh}; feed round hash ${round.roundHash}`);
  } else if (!round.anchorSig) {
    line("SKIP", "Creator signed the price round", "two-signature mode, but the feed does not carry the posted signatures yet");
  } else {
    // Two-signature mode (SPEC Changes 14): the anchor slot is empty by design; the round has its own signature.
    const sigs = hex0x(round.anchorSig);
    const sameAnchor = sigs.length === 2 + 2 * SIG_HEX && hex0x(sigs.slice(2, 2 + SIG_HEX)).toLowerCase() === anchor.sig.toLowerCase();
    const okRound = sameAnchor && anchor.vsh === "0x" && (await evmCall(PQC_VERIFY, precompiles, "pqcVerify",
      [pubkey, hex0x(sigs.slice(2 + SIG_HEX)), roundSigBytes(rollupId, round.round, round.roundHash)])) === true;
    line(okRound ? "PASS" : "FAIL", `Round ${round.round} signed by the creator (two-signature mode)`,
      `empty anchor slot: ${anchor.vsh === "0x"}; posted anchor signature is the chain's: ${sameAnchor}; round signature via pqcVerify: ${okRound}`);
  }

  // 6. PriceFeed recomputes the round hash and checks the same signature(s) itself.
  const postedSigs = round?.anchorSig ? hex0x(round.anchorSig) : twoSig ? undefined : anchor.sig;
  if (!priceFeed || !round?.attestation || !postedSigs) {
    line("SKIP", "PriceFeed.verifyReceipt", !priceFeed ? "PriceFeed is not deployed yet" : !round?.attestation ? "no attestation for this batch in the feed" : "the feed does not carry the posted signatures yet");
  } else {
    const a = round.attestation;
    const tuple = { round: BigInt(a.round), batchIndex: BigInt(a.batchIndex), inboxStart: BigInt(a.inboxStart), inboxEnd: BigInt(a.inboxEnd),
      closeHeight: BigInt(a.closeHeight), closeTime: BigInt(a.closeTime), feedIds: a.feedIds, medians: a.medians.map(BigInt),
      counts: a.counts, reportsRoot: a.reportsRoot as Hex, reportCount: a.reportCount };
    const ok = (await evmCall(priceFeed, priceFeedAbi, "verifyReceipt", [tuple, anchor.stateRoot, BigInt(anchor.txCount), postedSigs])) === true;
    line(ok ? "PASS" : "FAIL", "PriceFeed.verifyReceipt", `${priceFeed} -> ${ok}${twoSig ? " (anchorSig ‖ roundSig)" : ""}`);
    const [price, latestRound] = (await evmCall(priceFeed, priceFeedAbi, "latest", [1])) as [bigint, bigint, bigint, number];
    line("PASS", "PriceFeed.latest(fETH)", `round ${latestRound}, price ${price} (8 decimals)`, false);
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => r.outcome === "FAIL");
  const skipped = results.filter((r) => r.outcome === "SKIP" && r.required);
  const passed = results.filter((r) => r.outcome === "PASS");
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped in ${secs}s.`);
  if (failed.length) process.exitCode = 1;
  else if (skipped.length) {
    console.log("INCOMPLETE: some parts are not live yet (see SKIP lines).");
    process.exitCode = 3;
  }
}

main().catch((e) => {
  console.error(`judge stopped: ${(e as Error).message}`);
  process.exitCode = 1;
});
