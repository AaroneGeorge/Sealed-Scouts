// The PriceFeed functions the watchtower and the attack scripts call (contracts/src/PriceFeed.sol).
import { parseAbi } from "viem";

const LEAF = "(uint64 round, address scout, bytes16 salt, uint16[] feedIds, uint128[] prices, bytes32 commitSigHash)";
const ATTESTATION =
  "(uint64 round, uint64 batchIndex, uint64 inboxStart, uint64 inboxEnd, uint64 closeHeight, uint64 closeTime, uint16[] feedIds, uint128[] medians, uint8[] counts, bytes32 reportsRoot, uint16 reportCount)";

export const PRICE_FEED_ABI = parseAbi([
  "function rounds(uint64 round) view returns (bytes32 reportsRoot, uint64 postedAt, uint64 closeTime, uint64 batchIndex, uint16 reportCount, bool corrected)",
  "function roundFeeds(uint64 round) view returns (uint16[])",
  "function points(uint64 round, uint16 feedId) view returns (uint128 price, uint8 count, bool listed)",
  "function status(uint64 round) view returns (uint8)",
  "function twoSigMode() view returns (bool)",
  "function cursor() view returns (uint64 lastRound, uint64 lastBatchIndex, bool started)",
  `function challengeMedian(uint64 round, ${LEAF}[] leaves)`,
  `function postRound(${ATTESTATION} att, bytes32 stateRoot, uint64 txCount, bytes anchorSig)`,
  `function verifyReceipt(${ATTESTATION} att, bytes32 stateRoot, uint64 txCount, bytes anchorSig) view returns (bool)`,
  `event RoundPosted(uint64 indexed round, bytes32 roundHash, bytes32 stateRoot, uint64 txCount, ${ATTESTATION} att, bytes anchorSig)`,
  "error BadAttestation()",
  "error BadSignature()",
  "error StaleRound()",
  "error OperatorNotBonded()",
  "error NoPqKey(address account)",
  "error NotPending(uint64 round)",
  "error RootMismatch()",
  "error HonestRound(uint64 round)",
  "error LeavesNotSorted()",
]);

/** PriceFeed.Status in declaration order. */
export const FEED_STATUS = ["none", "pending", "final", "corrected"] as const;
