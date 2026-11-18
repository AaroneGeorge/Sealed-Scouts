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
  /** In-band reports not paid yet. Cleared only after the reward post landed. */
  tally: Tally;
  /** Epoch-end round whose rewards are still to be paid. */
  rewardDue?: string;
  /** A reward post in flight: the ledger nonce it used, so a retry can tell whether it landed. */
  rewardPosting?: { round: string; nonce: string };
  /** Settled rounds still to be relayed to PriceFeed, ascending. */
  pendingRelays: string[];
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
    const fresh: OperatorState = { tally: {}, executed: [], pendingRelays: [] };
    return existsSync(this.file) ? { ...fresh, ...JSON.parse(readFileSync(this.file, "utf8")) } : fresh;
  }

  /** Write then rename, so a crash never leaves half a file. */
  save(s: OperatorState): void {
    writeFileSync(this.file + ".tmp", JSON.stringify(s, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }

  /** One JSON record per round: what was derived, anchored and relayed. Bigints are stored as strings. */
  saveRound(round: bigint, record: unknown): void {
    const file = join(this.dir, "rounds", `${round}.json`);
    writeFileSync(
      file + ".tmp",
      JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v), 2),
    );
    renameSync(file + ".tmp", file);
  }

  loadRound(round: bigint): Record<string, any> {
    return JSON.parse(readFileSync(join(this.dir, "rounds", `${round}.json`), "utf8"));
  }
}
