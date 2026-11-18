// Scout bot.
//   npm run scout -- --role SCOUT1 [--once] [--demo]      report every round (or once) on the live rollup
//   (round timing: --demo / --no-demo, else SS_DEMO, else the operator's "roundMode" in deployments/diana.json)
//   npm run scout -- --role SCOUT1 --once --dry-run       live prices, sealed REPORT + COMMIT printed, nothing posted
//   npm run scout -- join --role SCOUT1                   post JOIN (the ledger account rewards go to)
//   npm run scout -- withdraw --role SCOUT1 --amount <uqor> [--to qor1...]
import { parseArgs } from "node:util";
import { generateMnemonic } from "@qorechain/sdk";
import { generateSealKeys, open } from "@qorechain/qoreseal";
import { decodeMsg, decodeReportPlaintext, phaseOf, reportAad, reportPurpose, toHex, verifyCommit } from "@sealed-scouts/core";
import { accountFromMnemonic, chain as defaultChain, loadAccount, mnemonicEnvName } from "@sealed-scouts/chain";
import { loadDeployment, timingOf, useDemo, type Deployment } from "./deployment.js";
import { joinPayload, ledgerKeyOf, nextNonce, withdrawalPayload } from "./ledger.js";
import { assertBonded, liveScoutChain, registeredKemKey } from "./live.js";
import { formatE8, politeGetJson, readPrices } from "./prices/index.js";
import { buildSealedReport } from "./report.js";
import { Scout, toPriceSet } from "./scout.js";
import { VENUE_SETS, isScoutRole, type ScoutRole } from "./venue-sets.js";

const { values, positionals } = parseArgs({
  allowNegative: true,
  allowPositionals: true,
  options: {
    role: { type: "string", default: "SCOUT1" },
    once: { type: "boolean", default: false },
    demo: { type: "boolean" },
    "dry-run": { type: "boolean", default: false },
    amount: { type: "string" },
    to: { type: "string" },
    "poll-ms": { type: "string", default: "4000" },
  },
});
const command = positionals[0] ?? "run";
if (!isScoutRole(values.role!)) throw new Error(`--role must be SCOUT1..SCOUT5, got ${values.role}`);
const role: ScoutRole = values.role;
const FEED_NAMES: Record<number, string> = { 1: "fETH/USD", 2: "fBTC/USD", 3: "fUSD/USD", 4: "KOCHI-ONION/INR" };
const getPrices = () => readPrices(VENUE_SETS[role], politeGetJson());

function needDeployment(): Deployment {
  const d = loadDeployment();
  if (!d) throw new Error("deployments/diana.json is missing: the rollup is not launched yet (use --dry-run)");
  return d;
}

async function dryRun(): Promise<void> {
  const d = loadDeployment();
  const haveKey = Boolean(process.env[mnemonicEnvName(role)]);
  const account = haveKey ? await loadAccount(role) : await accountFromMnemonic("CUSTOM", generateMnemonic(256));
  console.log(`${role} ${account.address}${haveKey ? "" : "  (in-memory key: no mnemonic in the environment)"}`);

  const reading = await getPrices();
  for (const f of reading.failed) console.log(`  ${f.venue}: excluded (${f.error})`);
  for (const s of reading.skipped) console.log(`  ${FEED_NAMES[s.feedId]}: skipped (${s.reason})`);
  for (const f of reading.feeds) console.log(`  ${FEED_NAMES[f.feedId]!.padEnd(10)} ${formatE8(f.price).padStart(14)}  from ${f.sources.join(", ")}`);
  if (reading.feeds.length === 0) throw new Error("no feed has enough sources");

  const chainId = d?.chainId ?? "qorechain-diana";
  const rollupId = d?.rollupId ?? process.env.SS_ROLLUP_ID ?? "sealed-scouts-1";
  let opener = generateSealKeys();
  let openerNote = "in-memory opener key (no deployment yet)";
  if (d) {
    try {
      const registered = await registeredKemKey(defaultChain(), d.operator);
      opener = { ...opener, mlkemPublicKey: registered };
      openerNote = `opener ${d.operator}'s registered ML-KEM-1024 key`;
    } catch (e) {
      openerNote = `in-memory opener key (${(e as Error).message})`;
    }
  }
  const round = d ? phaseOf(BigInt(await defaultChain().inbox.rest.getLatestHeight()), d.timing).round : 0n;
  const sealed = buildSealedReport({ chainId, rollupId, round, scout: account, openerKemKey: opener.mlkemPublicKey, prices: toPriceSet(reading.feeds) });

  console.log(`\nround ${round}, rollup ${rollupId}, sealed to the ${openerNote}`);
  console.log(`REPORT ${sealed.report.length} bytes  ${toHex(sealed.report.slice(0, 13))}…`);
  console.log(`COMMIT ${sealed.commit.length} bytes  commitment ${toHex(sealed.commitment)}`);
  console.log(`       commitSigHash ${sealed.commitSigHash}`);
  const ok = verifyCommit(account.keys.pqc.publicKey, { chainId, rollupId, round, scout: account.address, commitment: sealed.commitment }, sealed.signature);
  console.log(`check: ML-DSA-87 commit signature ${ok ? "verifies" : "FAILS"}`);
  if (opener.mlkemSecretKey.length && openerNote.startsWith("in-memory")) {
    const m = decodeMsg(sealed.report);
    if (m?.kind !== "REPORT") throw new Error("REPORT does not decode");
    const plain = decodeReportPlaintext(open({ chainId, purpose: reportPurpose(rollupId), envelope: m.envelope, keys: opener, aad: reportAad(round, account.address) }));
    console.log(`check: opener decrypts ${plain?.feedIds.length} prices, salt matches: ${plain && toHex(plain.salt) === toHex(sealed.salt)}`);
  }
  console.log("dry run: nothing was posted");
}

async function run(): Promise<void> {
  const d = needDeployment();
  const account = await loadAccount(role);
  const chain = defaultChain();
  const demo = useDemo(d, values.demo);
  const timing = timingOf(d, demo);
  await assertBonded(chain, account, d.priceFeed, d.scouts);
  const scout = new Scout({
    config: { chainId: d.chainId, rollupId: d.rollupId, operator: d.operator, timing },
    signer: account,
    chain: liveScoutChain(chain, account, d.rollupId),
    readPrices: getPrices,
    openerKemKey: () => registeredKemKey(chain, d.operator),
  });
  if (values.once) {
    const height = BigInt(await chain.inbox.rest.getLatestHeight());
    const { round, phase } = phaseOf(height, timing);
    if (phase !== "commit") throw new Error(`height ${height} is in the ${phase} window of round ${round}; --once reports only in a commit window`);
    await scout.report(round);
    return;
  }
  console.log(`${role} ${account.address} reporting on ${d.rollupId} (${demo ? "demo" : "normal"} rounds of ${timing.roundBlocks} blocks)`);
  for (;;) {
    await scout.tick().catch((e) => console.error(`${new Date().toISOString()} ${(e as Error).message}`));
    await new Promise((r) => setTimeout(r, Number(values["poll-ms"])));
  }
}

async function join(): Promise<void> {
  const d = needDeployment();
  const account = await loadAccount(role);
  const key = ledgerKeyOf(account.keys.pqc.secretKey);
  const tx = await defaultChain().native.postToInbox(account, [joinPayload(key)], d.rollupId);
  console.log(`JOIN ${role} ledger account ${toHex(key.accountId)} (tx ${tx.txHash}, height ${tx.height})`);
}

async function withdraw(): Promise<void> {
  const d = needDeployment();
  if (!values.amount) throw new Error("--amount <uqor> is required");
  const account = await loadAccount(role);
  const chain = defaultChain();
  const key = ledgerKeyOf(account.keys.pqc.secretKey);
  const head = await chain.inbox.head(d.rollupId);
  const entries = head > 0n ? await chain.inbox.read(d.rollupId, 1n, head) : [];
  const { nonce, balance } = nextNonce(d, entries, key);
  const amount = BigInt(values.amount);
  if (amount > balance) throw new Error(`ledger balance is ${balance} uqor, asked for ${amount}`);
  const payload = withdrawalPayload({ chainId: d.chainId, rollupId: d.rollupId, key, nonce, amount, recipient: values.to ?? account.address });
  const tx = await chain.native.postToInbox(account, [payload], d.rollupId);
  console.log(`withdrawal of ${amount} uqor to ${values.to ?? account.address} posted (nonce ${nonce}, tx ${tx.txHash}).`);
  console.log("It pays out after the batch that includes it is final: then anyone can execute it with its Merkle proof.");
}

const commands: Record<string, () => Promise<void>> = { run: () => (values["dry-run"] ? dryRun() : run()), join, withdraw };
if (!commands[command]) throw new Error(`unknown command ${command} (run, join, withdraw)`);
await commands[command]!();
