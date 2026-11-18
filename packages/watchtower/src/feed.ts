// The public status feed the web app reads: feed/status.json and feed/rounds/<round>.json.
// Written atomically (temp file + rename) so a reader never sees half a file. bigint -> decimal string,
// bytes -> 0x hex (the same JSON forms as core's jsonify); undefined fields are left out.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHex } from "@sealed-scouts/core";

export const DEFAULT_FEED_DIR = new URL("../../../feed", import.meta.url).pathname;

const plain = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? toHex(v) : v);

export class FeedWriter {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, "rounds"), { recursive: true });
  }

  private write(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, plain, 1) + "\n");
    renameSync(tmp, path);
  }

  round(round: bigint, value: unknown): void {
    this.write(join(this.dir, "rounds", `${round}.json`), value);
  }

  status(value: unknown): void {
    this.write(join(this.dir, "status.json"), value);
  }
}
