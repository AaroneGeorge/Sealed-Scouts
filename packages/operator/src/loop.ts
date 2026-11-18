// npm run loop -w @sealed-scouts/operator
// Runs the operator until stopped. Needs SS_OPERATOR_MNEMONIC (and SS_RELAYER_MNEMONIC to relay rounds) and
// deployments/diana.json. Start it detached (see ops/operator.sh) so it survives the shell.
import { chain, loadAccount, sealKeys } from "@sealed-scouts/chain";
import { readDeployment } from "./deployment.js";
import { Operator } from "./operator.js";
import { StateStore } from "./state.js";

const TICK_MS = Number(process.env.SS_TICK_MS ?? "6000");

const deployment = readDeployment();
if (!deployment) throw new Error("deployments/diana.json is missing: run npm run launch first");
const c = chain();
const operator = await loadAccount("OPERATOR");
if (operator.address !== deployment.operator) throw new Error(`OPERATOR key ${operator.address} is not the deployment's operator ${deployment.operator}`);
const relayer = process.env.SS_RELAYER_MNEMONIC ? await loadAccount("RELAYER") : undefined;

const op = new Operator({ chain: c, deployment, operator, relayer, sealKeys: sealKeys(operator), store: new StateStore() });
await op.start();

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
while (!stopping) {
  const t = Date.now();
  try {
    await op.tick();
  } catch (err) {
    // One bad tick (a public endpoint down, a refused tx) must not stop the rollup; the next tick retries.
    console.error(`${new Date().toISOString()} tick failed: ${(err as Error).stack ?? err}`);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - (Date.now() - t))));
}
console.log("operator stopped");
