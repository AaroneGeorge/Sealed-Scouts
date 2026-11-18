// Watchtower.
//   npm run watchtower -- --observe [--once]                  replay the live rollup with no key, write the feed
//   npm run watchtower -- --observe --fixture demo --once     same, on the simulated demo history (or a recorded JSON file)
//   npm run watchtower -- --active                            also challenge (needs SS_TOWER_MNEMONIC)
//   --feed-dir <dir> (default repo/feed, or SS_FEED_DIR)   --interval-ms <ms> (default 15000)
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chain as defaultChain, loadAccount } from "@sealed-scouts/chain";
import { loadDeployment } from "@sealed-scouts/scout";
import { DEFAULT_FEED_DIR, FeedWriter } from "./feed.js";
import { liveChallenger, liveSource, towerConfigFrom } from "./live.js";
import { buildDemoWorld } from "./scenario.js";
import { simTowerConfig, sourceFromJson } from "./sim.js";
import type { Challenger, TowerSource } from "./source.js";
import { Watchtower, type TowerConfig } from "./tower.js";

const { values } = parseArgs({
  options: {
    observe: { type: "boolean", default: false },
    active: { type: "boolean", default: false },
    fixture: { type: "string" },
    once: { type: "boolean", default: false },
    "feed-dir": { type: "string", default: process.env.SS_FEED_DIR ?? DEFAULT_FEED_DIR },
    "interval-ms": { type: "string", default: "15000" },
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
  cfg = towerConfigFrom(d);
  source = liveSource(defaultChain(), d.rollupId, d.priceFeed);
  if (values.active) challenger = liveChallenger(defaultChain(), await loadAccount("TOWER"), d.rollupId, d.priceFeed);
}

const tower = new Watchtower(cfg, source, new FeedWriter(values["feed-dir"]!), challenger);
console.log(`watchtower (${tower.mode}) on ${cfg.params.rollupId}${fixture ? ` [fixture: ${fixture}]` : ""}, feed in ${values["feed-dir"]}`);
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
