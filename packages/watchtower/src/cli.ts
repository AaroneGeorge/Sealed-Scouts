// Watchtower.
//   npm run watchtower -- --observe [--once]                  replay the live rollup with no key, write the feed
//   npm run watchtower -- --observe --fixture demo --once     same, on the simulated demo history (or a recorded JSON file)
//   npm run watchtower -- --active                            also challenge (needs SS_TOWER_MNEMONIC)
//   --demo / --no-demo: round timing; default SS_DEMO, else the operator's "roundMode" in deployments/diana.json
//   --rounds A..B: judge only rounds A to B (reads only their part of the inbox; needs --no-ledger)
//   --no-ledger: skip the ledger batch replay (it needs the whole inbox)
//   --feed-dir <dir> (default repo/feed, or SS_FEED_DIR)   --interval-ms <ms> (default 15000)
//   --no-restore: re-check every round from the chain instead of taking back the settled ones already in the feed dir
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chain as defaultChain, loadAccount } from "@sealed-scouts/chain";
import { loadDeployment, useDemo } from "@sealed-scouts/scout";
import { DEFAULT_FEED_DIR, FeedWriter } from "./feed.js";
import { liveChallenger, liveSource, towerConfigFrom } from "./live.js";
import { buildDemoWorld } from "./scenario.js";
import { simTowerConfig, sourceFromJson } from "./sim.js";
import type { Challenger, TowerSource } from "./source.js";
import { Watchtower, type TowerConfig } from "./tower.js";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    observe: { type: "boolean", default: false },
    demo: { type: "boolean" },
    active: { type: "boolean", default: false },
    fixture: { type: "string" },
    once: { type: "boolean", default: false },
    rounds: { type: "string" },
    ledger: { type: "boolean", default: true },
    "feed-dir": { type: "string", default: process.env.SS_FEED_DIR ?? DEFAULT_FEED_DIR },
    "interval-ms": { type: "string", default: "15000" },
    restore: { type: "boolean", default: true },
  },
});
if (values.observe === values.active) throw new Error("choose one of --observe or --active");

let cfg: TowerConfig;
let source: TowerSource;
let challenger: Challenger | undefined;
const fixture = values.fixture;
if (fixture) {
  if (values.active) throw new Error("--active works only on the live chain");
  const recorded = fixture === "demo" ? sourceFromJson(buildDemoWorld().sim.toJSON() as Record<string, any>) : sourceFromJson(JSON.parse(readFileSync(fixture, "utf8")));
  cfg = simTowerConfig(recorded.params);
  source = recorded.source;
} else {
  const d = loadDeployment();
  if (!d) throw new Error("deployments/diana.json is missing: the rollup is not launched yet (try --fixture)");
  cfg = towerConfigFrom(d, useDemo(d, values.demo));
  source = liveSource(defaultChain(), d);
  if (values.active) challenger = liveChallenger(defaultChain(), await loadAccount("TOWER"), d.rollupId, d.priceFeed);
}

const range = values.rounds?.match(/^(\d+)\.\.(\d+)$/);
if (values.rounds && (!range || BigInt(range[1]!) > BigInt(range[2]!))) throw new Error(`--rounds takes A..B with A <= B, got ${values.rounds}`);
cfg = { ...cfg, ledger: values.ledger, ...(range ? { rounds: { from: BigInt(range[1]!), to: BigInt(range[2]!) } } : {}) };

const feed = new FeedWriter(values["feed-dir"]!);
const tower = new Watchtower(cfg, source, feed, challenger);
console.log(`watchtower (${tower.mode}) on ${cfg.params.rollupId}${fixture ? ` [fixture: ${fixture}]` : ""}, feed in ${values["feed-dir"]}`);
// A restart takes back the rounds it had already settled; a fixture run always replays from scratch.
if (values.restore && !fixture) console.log(`restored ${tower.restore(feed.rounds())} settled rounds from the feed dir`);
for (;;) {
  try {
    await tower.sync();
  } catch (e) {
    console.error(`${new Date().toISOString()} ${(e as Error).message}`);
    if (values.once) process.exit(1);
  }
  if (values.once) break;
  await new Promise((r) => setTimeout(r, Number(values["interval-ms"])));
}
const s = tower.status();
console.log(`rounds replayed ${s.rounds.replayed} (match ${s.rounds.match}, median wrong ${s.rounds.medianWrong}, root wrong ${s.rounds.rootWrong}), batches ${s.batches.replayed} (fraud ${s.batches.fraud}), omissions ${s.operatorOmissions}`);
