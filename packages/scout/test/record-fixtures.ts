// Refresh the recorded venue responses used by the unit tests (live calls; run by hand only):
//   npx tsx test/record-fixtures.ts
import { writeFileSync } from "node:fs";
import { politeGetJson, VENUES, VENUE_IDS } from "../src/prices/index.js";

const live = politeGetJson();
const recorded: Record<string, unknown> = {};
for (const id of VENUE_IDS) {
  await VENUES[id].read(async (url) => (recorded[url] = await live(url))).catch((e) => console.error(id, e.message));
}
const out = new URL("./fixtures/venues.json", import.meta.url);
writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), responses: recorded }, null, 1) + "\n");
console.log(`recorded ${Object.keys(recorded).length} responses`);
