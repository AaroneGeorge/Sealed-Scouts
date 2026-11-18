// The loop's small persistent state (outside the repo, under $B/run/operator), so a restart resumes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tally } from "./rewards.js";

export const RUN_DIR = process.env.SS_RUN_DIR ?? new URL("../../../../run/operator", import.meta.url).pathname;

export interface OperatorState {
  /** Last round whose OPEN was posted or deliberately skipped. */
  lastOpened?: string;
  /** Last round whose batch was submitted (or found empty). */
  lastSettled?: string;
  /** In-band reports of the current reward epoch. */
  tally: Tally;
  /** Withdrawals already executed, as "batchIndex:globalIndex". */
  executed: string[];
}

export class StateStore {
  readonly file: string;
  constructor(readonly dir = RUN_DIR) {
    mkdirSync(join(dir, "rounds"), { recursive: true });
    this.file = join(dir, "state.json");
  }

  load(): OperatorState {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { tally: {}, executed: [] };
  }

  /** Write then rename, so a crash never leaves half a file. */
  save(s: OperatorState): void {
    writeFileSync(this.file + ".tmp", JSON.stringify(s, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }

  /** One JSON record per round: what was derived, anchored and relayed. */
  saveRound(round: bigint, record: unknown): void {
    writeFileSync(
      join(this.dir, "rounds", `${round}.json`),
      JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v), 2),
    );
  }
}
