// Round timing in main-chain blocks: round = floor((height - genesis) / roundBlocks).
// Inside a round: commit window, then open window, then reveal grace, then idle blocks until the next round.

export interface RoundTiming {
  genesisHeight: bigint;
  roundBlocks: bigint;
  commitBlocks: bigint;
  openBlocks: bigint;
  revealBlocks: bigint;
}

/** Production timing from the plan: 300-block rounds (about 6.5 min). genesisHeight comes from deployments/diana.json. */
export const DEFAULT_TIMING: Omit<RoundTiming, "genesisHeight"> = {
  roundBlocks: 300n,
  commitBlocks: 180n,
  openBlocks: 40n,
  revealBlocks: 40n,
};

export function checkTiming(t: RoundTiming): void {
  if (t.genesisHeight < 0n) throw new RangeError("genesisHeight must be >= 0");
  if (t.commitBlocks <= 0n || t.openBlocks <= 0n || t.revealBlocks <= 0n) throw new RangeError("every window needs at least one block");
  if (t.commitBlocks + t.openBlocks + t.revealBlocks > t.roundBlocks) throw new RangeError("windows do not fit in roundBlocks");
}

/** Round that contains `height`. Throws for heights before genesis. */
export function roundOf(height: bigint, t: RoundTiming): bigint {
  if (height < t.genesisHeight) throw new RangeError(`height ${height} is before genesis ${t.genesisHeight}`);
  return (height - t.genesisHeight) / t.roundBlocks;
}

/** Window boundaries of a round. Every window is half-open: [from, to). */
export interface RoundWindows {
  /** First block of the round; the commit window opens here. */
  start: bigint;
  /** First block after the commit window: REPORT and COMMIT must land before it. Also RoundResult.closeHeight. */
  commitEnd: bigint;
  /** First block after the open window: the operator's OPEN must land in [commitEnd, openEnd). */
  openEnd: bigint;
  /** First block after reveal grace: a scout's REVEAL must land in [commitEnd, revealEnd). */
  revealEnd: bigint;
  /** First block of the next round. */
  end: bigint;
}

export function roundWindows(round: bigint, t: RoundTiming): RoundWindows {
  checkTiming(t);
  if (round < 0n) throw new RangeError("round must be >= 0");
  const start = t.genesisHeight + round * t.roundBlocks;
  const commitEnd = start + t.commitBlocks;
  const openEnd = commitEnd + t.openBlocks;
  return { start, commitEnd, openEnd, revealEnd: openEnd + t.revealBlocks, end: start + t.roundBlocks };
}

export type Phase = "commit" | "open" | "reveal" | "idle";

/** Which window `height` falls in, for bots deciding what to post next. */
export function phaseOf(height: bigint, t: RoundTiming): { round: bigint; phase: Phase } {
  const round = roundOf(height, t);
  const w = roundWindows(round, t);
  const phase: Phase = height < w.commitEnd ? "commit" : height < w.openEnd ? "open" : height < w.revealEnd ? "reveal" : "idle";
  return { round, phase };
}
