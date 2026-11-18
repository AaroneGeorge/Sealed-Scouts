// Day-1 chain tests with faucet funds (plan 7.6, items 1-4). Each step writes its evidence as JSON.
//   source ops/env.local.sh
//   (cd ops/day1/probe && forge build)        # the evm step deploys this probe
//   npx tsx ops/day1/day1.ts <anchor|keys|classical|post|evm|contracts|all> [--evidence <dir>]
// Steps are safe to re-run: key registration is skipped when the key is already on chain.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RestClient, anchorSignBytesForBatch, decodeWireBytes } from "@qorechain/rdk";
import { seal } from "@qorechain/qoreseal";
import { bank } from "@qorechain/sdk";
import { toEvmAddress } from "@qorechain/evm";
import { decodeEventLog, encodeFunctionData, parseAbi, toHex, type Hex } from "viem";
import { chain, loadAccount, type Account, type Role, type TxResult } from "../../packages/chain/src/index.js";
import { deployContracts, feedConfig, feedTwoSigMode } from "../../packages/operator/src/contracts.js";
import {
  commitment,
  encodeMsg,
  encodeReportPlaintext,
  reportAad,
  reportPurpose,
  signCommit,
  scoutAddress,
} from "@sealed-scouts/core";

const ORGANISER_ROLLUP = "rdk-v328-e2e-mwd5v89d";
const here = dirname(fileURLToPath(import.meta.url));
const evidenceArg = process.argv.indexOf("--evidence");
const EVIDENCE =
  evidenceArg > 0 ? process.argv[evidenceArg + 1]! : join(here, "../../../evidence/day1");
const c = chain();

function save(name: string, data: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true });
  const file = join(EVIDENCE, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`evidence: ${file}`);
}

function txSummary(r: TxResult) {
  return { txHash: r.txHash, code: r.code, codespace: r.codespace, height: r.height, gasUsed: r.gasUsed, gasWanted: r.gasWanted, rawLog: r.rawLog };
}

async function funded(roles: Role[]): Promise<Account[]> {
  const out: Account[] = [];
  for (const role of roles) {
    const a = await loadAccount(role);
    const bal = await c.native.balance(a.address);
    console.log(`${role.padEnd(9)} ${a.address} ${Number(bal) / 1e6} QOR`);
    if (bal > 0n) out.push(a);
  }
  if (out.length === 0) throw new Error(`none of ${roles.join(", ")} holds QOR yet: claim the faucet for OPERATOR, then run ops/fund.ts --topup`);
  return out;
}

/** 1. ML-DSA-87 key with proof of possession, then the ML-KEM-1024 key, for each funded account. */
async function keys() {
  const results: Record<string, unknown> = {};
  for (const a of await funded(["OPERATOR", "SCOUT1", "SCOUT2", "SCOUT3", "TOWER", "ATTACKER"])) {
    const pqc = await c.native.registerPqcKey(a);
    const kem = await c.native.registerKemKey(a);
    results[a.role] = {
      address: a.address,
      pqc: pqc === "already-registered" ? pqc : txSummary(pqc),
      kem: kem === "already-registered" ? kem : txSummary(kem),
      kemKeyOnChain: (await c.native.kemKey(a.address))?.slice(0, 16) + "…",
    };
    console.log(`${a.role}: pqc ${pqc === "already-registered" ? pqc : pqc.txHash}, kem ${kem === "already-registered" ? kem : kem.txHash}`);
  }
  save("keys", results);
}

/** 2. A classical-only native tx from an account with a registered PQC key: the chain must refuse it. */
async function classical() {
  const op = await loadAccount("OPERATOR");
  const msg = bank.send({ fromAddress: op.address, toAddress: op.address, amount: [{ denom: "uqor", amount: "1" }] });
  const r = await c.native.send(op, [msg], { mode: "classical", gas: 200_000 });
  console.log(`classical-only tx: code ${r.code} (${r.codespace}) ${r.rawLog}`);
  save("classical-refusal", { account: op.address, signedWith: "secp256k1 only (no ML-DSA-87 extension)", refused: r.code !== 0, ...txSummary(r) });
}

/** 3. One REPORT and one COMMIT, full size, in ONE tx to the organiser's open based rollup. */
async function post() {
  const op = await loadAccount("OPERATOR");
  const [scout] = await funded(["SCOUT1"]).catch(() => [] as Account[]);
  const poster = scout ?? op;
  const openerKem = await c.native.kemKey(op.address);
  if (!openerKem) throw new Error("OPERATOR has no KEM key on chain yet: run the keys step first");
  const round = 1n;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prices = { feedIds: [1, 2, 3], prices: [179_291_000_000n, 6_397_979_000_000n, 99_884_000n] };
  const scoutHex = scoutAddress(poster.address);
  if (!scoutHex) throw new Error(`bad poster address ${poster.address}`);
  const envelope = seal({
    chainId: c.config.chainId,
    purpose: reportPurpose(ORGANISER_ROLLUP),
    mode: "mlkem",
    recipients: [{ mlkemPublicKey: new Uint8Array(Buffer.from(openerKem, "hex")) }],
    plaintext: encodeReportPlaintext({ salt, ...prices }),
    aad: reportAad(round, poster.address),
  });
  const comm = commitment(round, scoutHex, salt, prices);
  const signature = signCommit(poster.keys.pqc.secretKey, {
    chainId: c.config.chainId,
    rollupId: ORGANISER_ROLLUP,
    round,
    scout: poster.address,
    commitment: comm,
  });
  const report = encodeMsg({ kind: "REPORT", round, envelope });
  const commit = encodeMsg({ kind: "COMMIT", round, commitment: comm, signature });
  const r = await c.native.postToInbox(poster, [report, commit], ORGANISER_ROLLUP);
  console.log(`posted REPORT ${report.length} B + COMMIT ${commit.length} B in tx ${r.txHash}: sequences ${r.sequences.join(", ")}`);
  const back = await c.inbox.read(ORGANISER_ROLLUP, r.sequences[0]!, r.sequences.at(-1)!);
  const sameBytes = back.length === 2 && Buffer.compare(back[0]!.payload, report) === 0 && Buffer.compare(back[1]!.payload, commit) === 0;
  console.log(`read back through the accumulator-checked reader: ${sameBytes ? "identical" : "DIFFERENT"}`);
  save("inbox-post", {
    rollupId: ORGANISER_ROLLUP,
    poster: poster.address,
    messagesInOneTx: 2,
    reportBytes: report.length,
    commitBytes: commit.length,
    sequences: r.sequences,
    readBackIdentical: sameBytes,
    ...txSummary(r),
  });
}

const probeAbi = parseAbi([
  "function verifyAnchor(address creator, bytes anchorBytes, bytes signature) view returns (bool)",
  "function checkAnchor(address creator, bytes anchorBytes, bytes signature) returns (bool)",
  "event AnchorChecked(address indexed creator, bool valid, uint256 gasForCheck)",
]);

/** The latest anchor of a live rollup, rebuilt into the exact bytes its creator signed. */
async function liveAnchor() {
  const rest = new RestClient(c.config.rest, { fetch: c.fetch });
  for (const id of ["vigil-1", "wicketgate-pay", ORGANISER_ROLLUP]) {
    try {
      const rollup = await rest.getRollup(id);
      const a = await rest.getAnchor(rollup.layerId);
      const message = anchorSignBytesForBatch({
        chainId: c.config.chainId,
        layerId: rollup.layerId,
        batchIndex: a.layerHeight,
        stateRoot: decodeWireBytes(a.stateRoot),
        txCount: a.transactionCount,
        validatorSetHash: a.validatorSetHash ? decodeWireBytes(a.validatorSetHash) : undefined,
      });
      return { rollupId: id, batchIndex: a.layerHeight, creator: toEvmAddress(rollup.creator) as Hex, message: toHex(message), signature: toHex(decodeWireBytes(a.pqcSignature)) };
    } catch (err) {
      console.log(`no usable anchor on ${id}: ${(err as Error).message}`);
    }
  }
  throw new Error("no live rollup anchor found");
}

const precompileAbi = parseAbi([
  "function pqcVerify(bytes pubkey, bytes signature, bytes message) view returns (bool)",
  "function pqcKeyStatus(address account) view returns (bool registered, uint8 algorithmId, bytes pubkey, bool possessionProven)",
]);

/** 0. Read only, no funds: rebuild a live anchor and check it through the precompiles with eth_call. */
async function anchor() {
  const a = await liveAnchor();
  const pub = c.evm.publicClient;
  const [registered, algorithmId, pubkey, possessionProven] = await pub.readContract({
    address: "0x0000000000000000000000000000000000000a02", abi: precompileAbi, functionName: "pqcKeyStatus", args: [a.creator],
  });
  const verify = (message: Hex) =>
    pub.readContract({ address: "0x0000000000000000000000000000000000000a01", abi: precompileAbi, functionName: "pqcVerify", args: [pubkey, a.signature, message] });
  const valid = await verify(a.message);
  const tamperedValid = await verify(flipLastByte(a.message));
  console.log(`${a.rollupId} batch ${a.batchIndex}: key registered ${registered}, pqcVerify ${valid}, tampered ${tamperedValid}`);
  save("anchor-readonly", { ...a, message: undefined, messageBytes: (a.message.length - 2) / 2, signatureBytes: (a.signature.length - 2) / 2, registered, algorithmId, possessionProven, valid, tamperedValid });
}

function flipLastByte(h: Hex): Hex {
  return (h.slice(0, -2) + (h.endsWith("00") ? "01" : "00")) as Hex;
}

/** 4. Scoped EVM window: deploy the probe, check a live anchor on chain, measure gas and billing. */
async function evm() {
  const op = await loadAccount("OPERATOR");
  const anchor = await liveAnchor();
  const artifact = JSON.parse(readFileSync(join(here, "probe/out/AnchorProbe.sol/AnchorProbe.json"), "utf8"));
  const pub = c.evm.publicClient;
  const tampered = flipLastByte(anchor.message);

  // Step A: an unscoped window, because a scoped window refuses contract creation.
  const deployed = await c.evm.withWindow(op, { targets: [], maxTxs: 1, blocks: 200 }, async ({ walletClient }) => {
    const gas = await pub.estimateGas({ account: op.evm, data: artifact.bytecode.object });
    const hash = await walletClient.deployContract({ abi: probeAbi, bytecode: artifact.bytecode.object, gas: (gas * 12n) / 10n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error(`deploy ${hash} has no contract address`);
    return { hash, address: rc.contractAddress, estimate: gas, gasUsed: rc.gasUsed, status: rc.status };
  });
  console.log(`probe deployed at ${deployed.address} (tx ${deployed.hash}, gas ${deployed.gasUsed})`);

  // Step B: a window scoped to the probe only. The limit is set to twice the estimate on purpose,
  // to see whether the chain bills gas used or at least half the limit.
  const check = await c.evm.withWindow(op, { targets: [deployed.address], maxTxs: 1, blocks: 200 }, async ({ walletClient }) => {
    const args = [anchor.creator, anchor.message, anchor.signature] as const;
    const viewOk = await pub.readContract({ address: deployed.address, abi: probeAbi, functionName: "verifyAnchor", args });
    const viewTampered = await pub.readContract({ address: deployed.address, abi: probeAbi, functionName: "verifyAnchor", args: [anchor.creator, tampered, anchor.signature] });
    const estimate = await pub.estimateContractGas({ address: deployed.address, abi: probeAbi, functionName: "checkAnchor", args, account: op.evm });
    const gasLimit = estimate * 2n;
    const before = await pub.getBalance({ address: op.evm });
    const hash = await walletClient.writeContract({ address: deployed.address, abi: probeAbi, functionName: "checkAnchor", args, gas: gasLimit });
    const rc = await pub.waitForTransactionReceipt({ hash });
    const after = await pub.getBalance({ address: op.evm, blockNumber: rc.blockNumber });
    const billedGas = (before - after) / rc.effectiveGasPrice;
    const event = rc.logs[0] ? decodeEventLog({ abi: probeAbi, data: rc.logs[0].data, topics: rc.logs[0].topics }) : undefined;
    const logGas = event?.eventName === "AnchorChecked" ? event.args.gasForCheck : undefined;
    return {
      hash, status: rc.status, viewOk, viewTampered, estimate, gasLimit, gasUsed: rc.gasUsed,
      effectiveGasPrice: rc.effectiveGasPrice, billedGasFromBalance: billedGas,
      billedAtLeastHalfLimit: billedGas >= gasLimit / 2n, gasInsideContractForCheck: logGas,
      calldataBytes: (encodeFunctionData({ abi: probeAbi, functionName: "checkAnchor", args }).length - 2) / 2,
    };
  });
  console.log(`checkAnchor: valid view ${check.viewOk}, tampered view ${check.viewTampered}, gas used ${check.gasUsed} of limit ${check.gasLimit}, billed ${check.billedGasFromBalance}`);
  save("evm-probe", { account: op.address, evm: op.evm, anchor: { ...anchor, message: `${anchor.message.length / 2 - 1} bytes` }, deployed, check });
}

/**
 * 5. Rehearse the contract deploy (about 0.7 QOR): PriceFeed + ScoutLend from Track B's artifacts in an unscoped
 * window. Evidence only: deployments/diana.json is left alone, the launch deploys the contracts it will use.
 */
async function contracts() {
  const op = await loadAccount("OPERATOR");
  const before = await c.native.balance(op.address);
  const cfg = feedConfig({ operatorEvm: op.evm, rollupId: "sealed-scouts-1", chainId: c.config.chainId });
  const d = await deployContracts(c, op, cfg);
  const twoSig = await feedTwoSigMode(c, d.PriceFeed);
  const spent = before - (await c.native.balance(op.address));
  console.log(`rehearsal: PriceFeed ${d.PriceFeed} (gas ${d.gasUsed.PriceFeed}), ScoutLend ${d.ScoutLend} (gas ${d.gasUsed.ScoutLend}); spent ${Number(spent) / 1e6} QOR`);
  save("contracts-rehearsal", { ...d, twoSigMode: twoSig, spentUqor: spent, config: cfg, note: "rehearsal only, not written to deployments/diana.json" });
}

const steps: Record<string, () => Promise<void>> = { anchor, keys, classical, post, evm, contracts };
const step = process.argv[2] ?? "all";
const names = step === "all" ? ["keys", "classical", "post", "evm", "contracts"] : steps[step] ? [step] : [];
if (names.length === 0) {
  console.error(`unknown step ${step}: use anchor | keys | classical | post | evm | contracts | all`);
  process.exit(1);
}
// Each step runs even if an earlier one failed (they are independent once keys exist); the summary says which.
const summary: { step: string; ok: boolean; error?: string; seconds: number }[] = [];
for (const name of names) {
  const t = Date.now();
  try {
    await steps[name]!();
    summary.push({ step: name, ok: true, seconds: (Date.now() - t) / 1000 });
  } catch (err) {
    const error = (err as Error).message.split("\n")[0]!;
    console.error(`step ${name} failed: ${error}`);
    summary.push({ step: name, ok: false, error, seconds: (Date.now() - t) / 1000 });
  }
}
if (step === "all") save("summary", { finishedAt: new Date().toISOString(), steps: summary });
process.exitCode = summary.every((s) => s.ok) ? 0 : 1;
