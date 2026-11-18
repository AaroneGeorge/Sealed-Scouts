// npm run loop -w @sealed-scouts/operator [-- --demo | --no-demo]
// Runs the operator until stopped. Demo or normal timing is chosen by the scouts' rule (useDemo): the flag, else
// SS_DEMO (1/true or 0/false), else the last roundMode in the file. Demo mode uses the deployment's demo timing
// and keeps its own state folder, since demo rounds are numbered on a different clock. At start it writes the
// mode it runs as `roundMode` into deployments/diana.json, which scouts and the web default to.
// Needs SS_OPERATOR_MNEMONIC (and SS_RELAYER_MNEMONIC to relay rounds) and deployments/diana.json.
// Start it detached (see ops/operator.sh) so it survives the shell.
import { chain, loadAccount, sealKeys } from "@sealed-scouts/chain";
import { useDemo } from "@sealed-scouts/scout";
import { readDeployment, setRoundMode } from "./deployment.js";
import { Operator } from "./operator.js";
import { RUN_DIR, StateStore } from "./state.js";

const TICK_MS = Number(process.env.SS_TICK_MS ?? "6000");

const deployment = readDeployment();
if (!deployment) throw new Error("deployments/diana.json is missing: run npm run launch first");
const c = chain();
const operator = await loadAccount("OPERATOR");
if (operator.address !== deployment.operator) throw new Error(`OPERATOR key ${operator.address} is not the deployment's operator ${deployment.operator}`);
const relayer = process.env.SS_RELAYER_MNEMONIC ? await loadAccount("RELAYER") : undefined;

const flag = process.argv.includes("--demo") ? true : process.argv.includes("--no-demo") ? false : undefined;
const demo = useDemo({ roundMode: deployment.roundMode } as Parameters<typeof useDemo>[0], flag);
setRoundMode(demo ? "demo" : "normal");
const store = new StateStore(demo ? `${RUN_DIR}-demo` : RUN_DIR);
const op = new Operator({ chain: c, deployment, operator, relayer, sealKeys: sealKeys(operator), store, demo });
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
