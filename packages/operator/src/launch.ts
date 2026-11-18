// npm run launch -w @sealed-scouts/operator -- --yes [--scouts SCOUT1,SCOUT2,SCOUT3] [--reward-pool QOR]
// Creates the rollup (qledger-v1, optimistic, based), bonds the submitter, registers the operator's ML-DSA-87 and
// ML-KEM keys, funds the reward pool on the ledger, and writes deployments/diana.json. Every step is skipped
// when already done, so a failed launch can simply be run again. Needs about 12,000 test QOR on OPERATOR.
import {
  RestClient,
  bondRollupSubmitterMsg,
  createRollupMsg,
  depositToRollupMsg,
  isRestNotFound,
  presets,
} from "@qorechain/rdk";
import { chain, loadAccount, type Role } from "@sealed-scouts/chain";
import { ledgerKeyOf } from "@sealed-scouts/scout";
import { defaultDemo, defaultParams, mergeDeployment, readDeployment, DEPLOYMENT_PATH, type OwnKeys } from "./deployment.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : fallback);

const ROLLUP_ID = process.env.SS_ROLLUP_ID ?? "sealed-scouts-1";
/** Rounds start this many blocks after launch, so the scouts have time to start. */
const GENESIS_DELAY_BLOCKS = 100n;
const qor = (u: bigint | string) => `${(Number(u) / 1e6).toLocaleString("en-US")} QOR`;

const c = chain();
const rest = new RestClient(c.config.rest, { fetch: c.fetch });
const op = await loadAccount("OPERATOR");
const params = await rest.getParams();
const stake = BigInt(params.minStakeForRollup);
const bond = BigInt(params.minSubmitterBond ?? "1000000000");
const pool = BigInt(Math.round(Number(option("--reward-pool", "20")) * 1e6));
const balance = await c.native.balance(op.address);
const need = stake + bond + pool + 50_000_000n; // plus fees and the EVM bond later
console.log(`operator ${op.address}: ${qor(balance)}; launch needs about ${qor(need)} (stake ${qor(stake)}, bond ${qor(bond)}, reward pool ${qor(pool)})`);

if (!flag("--yes")) {
  console.log("dry run: nothing sent. Add --yes to launch.");
  process.exit(0);
}

const prior = readDeployment();
const txs: Record<string, string> = { ...(prior?.txs ?? {}) };
const step = async (name: string, run: () => Promise<string | undefined>) => {
  if (txs[name]) return console.log(`${name}: done before (${txs[name]})`);
  const hash = await run();
  if (hash) {
    txs[name] = hash;
    console.log(`${name}: ${hash}`);
  }
};

await step("registerPqcKey", async () => {
  const r = await c.native.registerPqcKey(op);
  return r === "already-registered" ? r : r.txHash;
});
await step("registerKemKey", async () => {
  const r = await c.native.registerKemKey(op);
  return r === "already-registered" ? r : r.txHash;
});

let exists = true;
try {
  await rest.getRollup(ROLLUP_ID);
} catch (err) {
  if (!isRestNotFound(err)) throw err;
  exists = false;
}
await step("createRollup", async () => {
  if (exists) return "exists";
  if (balance < need) throw new Error(`not enough QOR: ${qor(balance)} < ${qor(need)}`);
  // The official scaffold's optimistic preset: v3.2.8 gives it qledger-v1 execution and based sequencing.
  const msg = presets.nft({ rollupId: ROLLUP_ID }).validate().toCreateMsg(op.address, { stakeAmount: params.minStakeForRollup });
  return (await c.native.sendOrThrow(op, [createRollupMsg(msg)])).txHash;
});
const rollup = await rest.getRollup(ROLLUP_ID);
if (rollup.creator !== op.address) throw new Error(`rollup ${ROLLUP_ID} belongs to ${rollup.creator}, not to our operator`);
if (rollup.executionVm !== "qledger-v1" || rollup.sequencing !== "based") {
  throw new Error(`rollup ${ROLLUP_ID} is ${rollup.executionVm || "no vm"}/${rollup.sequencing || "not based"}, expected qledger-v1/based`);
}

await step("bondSubmitter", async () => {
  const have = BigInt((await rest.getSubmitterBond(ROLLUP_ID, op.address)).amount);
  if (have >= bond) return "bonded";
  return (await c.native.sendOrThrow(op, [bondRollupSubmitterMsg({ submitter: op.address, rollupId: ROLLUP_ID, amount: bond - have })])).txHash;
});

await step("rewardPoolDeposit", async () => {
  const account = ledgerKeyOf(op.keys.pqc.secretKey).accountId;
  return (await c.native.sendOrThrow(op, [depositToRollupMsg({ depositor: op.address, rollupId: ROLLUP_ID, account, amount: pool })])).txHash;
});

const scoutRoles = option("--scouts", "SCOUT1,SCOUT2,SCOUT3").split(",") as Role[];
const scouts = await Promise.all(scoutRoles.map(async (r) => (await loadAccount(r)).address));
const height = BigInt(await rest.getLatestHeight());
const same = prior?.rollupId === ROLLUP_ID;

const deployment: OwnKeys = {
  chainId: c.config.chainId,
  evmChainId: c.config.evmChainId,
  rollupId: ROLLUP_ID,
  operator: op.address,
  operatorEvm: op.evm,
  // Keep the round clock of an earlier launch: rounds already posted must keep their numbers.
  genesisHeight: same ? prior.genesisHeight : String(height + GENESIS_DELAY_BLOCKS),
  createdHeight: String(rollup.createdHeight),
  params: same ? prior.params : defaultParams(),
  demo: same && prior.demo ? prior.demo : defaultDemo(),
  scouts,
  txs,
};
mergeDeployment(deployment);
console.log(`wrote ${DEPLOYMENT_PATH}: rollup ${ROLLUP_ID}, rounds start at height ${deployment.genesisHeight}`);
