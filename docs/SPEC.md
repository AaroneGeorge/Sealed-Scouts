# Sealed Scouts: shared specification (v1)

This file is the contract between the packages. Change it only together with every package that depends on the changed part.


**Inbox messages.** `payload = "SSC1" (4 bytes) | kind (1 byte) | body`. The first byte is never a ledger transaction version, so the ledger skips it.

| Kind | Name | Poster | Body |
|---|---|---|---|
| 0x01 | JOIN | scout | ledger account id (32 bytes) |
| 0x02 | REPORT | scout | round u64 · QoreSeal envelope (mode `mlkem`, purpose `sealed-scouts/report/v1:<rollupId>`, aad `round|scout`) |
| 0x03 | COMMIT | scout | round u64 · commitment (32) · ML-DSA-87 signature (4,627) |
| 0x04 | OPEN | operator | round u64 · count u8 · count × (scout20 · salt16 · n u8 · n × (feedId u16 · price u128)) |
| 0x05 | REVEAL | scout | round u64 · salt16 · n u8 · n × (feedId u16 · price u128) |

- `commitment = SHA-256("sealed-scouts/report/v1" | round u64 | scout20 | salt16 | n u8 | n × (feedId u16 | price u128))`. Big-endian.
- COMMIT signature text (QoreSign message v1, so a human with QoreX could sign it too): `sealed-scouts/commit/v1|<rollupId>|<round>|<scout qor1>|<commitment hex>`. On chain the signed bytes are `"qorechain-msg-v1|qorechain-diana|" + text` **[FACT: fest FAQ]**.
- A report counts only if REPORT and COMMIT have the same poster, both heights are in the commit window, the scout is eligible, the signature verifies, and the opened or revealed plaintext hashes to the commitment.
- Prices: unsigned integers, 8 decimals. Feeds: 1 fETH/USD, 2 fBTC/USD, 3 fUSD/USD, 4 KOCHI-ONION/INR (optional).
- Median of n: element `floor((n-1)/2)` of the sorted list. Quorum 3. In-band: within `BAND_BPS` (200) of the median. Slashable: beyond `SLASH_BPS` (1000).

**Core API (`packages/core`).**

```ts
interface InboxEntry { seq: bigint; height: bigint; poster: string; payload: Uint8Array }
interface Leaf { round: bigint; scout: `0x${string}`; salt: Uint8Array; feedIds: number[]; prices: bigint[]; commitSigHash: `0x${string}` }
interface RoundResult { round: bigint; status: "ok" | "no-quorum"; leaves: Leaf[]; medians: { feedId: number; price: bigint; count: number }[];
  reportsRoot: `0x${string}`; outliers: Leaf[]; rejected: { scout: string; reason: string }[]; openHeight: bigint; closeHeight: bigint }
function decodeMsg(payload: Uint8Array): Msg | undefined
function deriveRound(entries: InboxEntry[], round: bigint, params: RoundParams, eligible: (scout: string, round: bigint) => boolean): RoundResult
function toAttestation(r: RoundResult, batch: { index: bigint; inboxStart: bigint; inboxEnd: bigint; closeTime: bigint }): RoundAttestation
function roundHash(att: RoundAttestation): `0x${string}`   // goes into the anchor's validator_set_hash slot
```

**Chain API (`packages/chain`).**

```ts
loadAccount(role: "OPERATOR" | "SCOUT1".."SCOUT5" | "TOWER" | "ROGUE" | "ATTACKER" | "RELAYER")
native.send(account, msgs): Promise<{ txHash: string; code: number; height: bigint }>   // hybrid, one queue per account, retry on sequence mismatch
native.postToInbox(account, payloads: Uint8Array[]): same                                // one tx, n MsgPostRollupData [TEST D1]
inbox.read(rollupId, fromSeq, toSeq): Promise<InboxEntry[]>                              // wraps RDK fetchQledgerEntries, accumulator-checked
evm.withWindow(account, { targets, maxTxs, maxValue, blocks }, fn)                       // opens a scoped EVM window, runs fn, closes it
polite fetch: explicit User-Agent, spacing, backoff on 429. A failed read is an error, never a zero.
```

**Contract ABI (`contracts/`).**

```solidity
struct RoundAttestation { uint64 round; uint64 batchIndex; uint64 inboxStart; uint64 inboxEnd; uint64 closeHeight; uint64 closeTime;
                          uint16[] feedIds; uint128[] medians; uint8[] counts; bytes32 reportsRoot; uint16 reportCount; }
// roundHash = keccak256(abi.encode("sealed-scouts/round/v1", chainId, rollupId, att))
function postRound(RoundAttestation att, bytes32 stateRoot, uint64 txCount, bytes anchorSig) external;      // anyone; pqcVerify inside
function challengeMedian(uint64 round, Leaf[] leaves) external;                                              // anyone; slashes operator on mismatch
function slashOutlier(uint64 round, Leaf leaf, bytes32[] proof, bytes scoutSig) external;                    // needs the scout's own signature
function bondOperator() external payable;  function bondFor(address scout) external payable;                 // anyone may fund
function requestExit(address who, bytes pqSig) external;  function withdrawBond(address who, address to, bytes pqSig) external;
function latest(uint16 feedId) external view returns (uint128 price, uint64 round, uint64 time, uint8 status);
function readFinal(uint16 feedId, uint64 maxAge) external view returns (uint128 price, uint64 round);        // reverts if stale or not final
function verifyReceipt(RoundAttestation att, bytes32 stateRoot, uint64 txCount, bytes anchorSig) external view returns (bool);
```

- Anchor bytes (exact, from RDK `anchorSignBytesV2`): `"qorechain-multilayer-anchor-v2" | u64(len) chainId | u64(len) layerId | u64 batchIndex | u64(32) stateRoot | u64(len) vsh | u64 txCount | u64(0)`. All big-endian. 180 bytes with a 32-byte `vsh`.
- Leaf hash: `keccak256(abi.encode(round, scout, salt, feedIds, prices, commitSigHash))`. Tree: leaves sorted by scout address, keccak pairs.
- Precompile addresses in lowercase: `0x…0a01`, `0x…0a02`. Use typed interface calls so empty return data reverts.

**Files other tracks read.** `deployments/diana.json` (rollup id, creator, contract addresses, params, genesis height). `feed/status.json` and `feed/rounds/<round>.json` (written by the watchtower, read by the web app).


## Changes

Additive clarifications. Each one pins down a detail the text above left open; none changes a layout above.

**2026-11-19 (Track A, core v0.1).**

1. `roundHash` takes the domain it hashes: `roundHash(att, { chainId, rollupId })`. In `abi.encode` the types are
   `(string "sealed-scouts/round/v1", uint256 chainId, string rollupId, RoundAttestation att)`. `chainId` is the EVM
   chain id (`block.chainid`, 9800 on testnet), not the Cosmos chain id. `rollupId` is the rollup id string.
2. Leaf hash encodes six values, not one struct: `keccak256(abi.encode(uint64 round, address scout, bytes16 salt,
   uint16[] feedIds, uint128[] prices, bytes32 commitSigHash))`. `commitSigHash = keccak256(COMMIT signature bytes)`.
3. Merkle tree: leaves sorted by scout address ascending; parent = `keccak256(min(a,b) ‖ max(a,b))` (OpenZeppelin
   `MerkleProof.verify` works); an odd last node moves up unchanged; one leaf: root = its hash; no leaves: root = 0.
4. COMMIT text: `<round>` is decimal; `<commitment hex>` is 64 lowercase hex characters without `0x`. Signed bytes are
   QoreSign `messagePqSignBytes(chainId, text)`, `chainId` = Cosmos chain id (`qorechain-diana`).
5. REPORT plaintext (sealed inside the envelope) is `salt16 · n u8 · n × (feedId u16 · price u128)`, the same layout
   as a REVEAL body. QoreSeal aad is the UTF-8 string `<round>|<scout qor1>`. Helpers: `encodeReportPlaintext`,
   `reportPurpose(rollupId)`, `reportAad(round, scout)`.
6. `scout20` is the 20 bytes behind the poster's `qor1` bech32 address. `decodeMsg` returns `undefined` for any payload
   that is not a well-formed message, including SSC1 payloads of the wrong length or an unknown kind.
7. Windows, all half-open `[from, to)`, with `start = genesis + round × ROUND_BLOCKS`:
   commit `[start, start+180)`, OPEN `[start+180, start+220)`, REVEAL `[start+180, start+260)` (a scout may reveal as
   soon as the commit window closes). `RoundResult.openHeight = start`; `closeHeight = start + 180` (first block after
   the commit window; also `RoundAttestation.closeHeight`).
8. `RoundParams` = timing (`genesisHeight, roundBlocks, commitBlocks, openBlocks, revealBlocks`), rules
   (`quorum, bandBps, slashBps`), `chainId` (Cosmos), `rollupId`, `operator` (qor1 allowed to post OPEN) and
   `pqKeyOf(scout qor1) → ML-DSA-87 public key | undefined`. `eligible` is called with the poster's qor1 and the round.
9. deriveRound rule order per poster (first failure is the reason): more than one COMMIT `duplicate-commit`; more than
   one REPORT `duplicate-report`; `missing-commit`; `missing-report`; either outside the commit window
   `outside-commit-window`; `bad-address`; `not-eligible`; `no-pq-key`; `bad-signature`; no opening (OPEN from the
   operator in the open window, then the scout's own REVEAL) that hashes to the commitment: `opening-mismatch` if one
   was offered, else `reveal-outside-window` if the scout revealed late, else `not-opened`; feedIds not strictly
   ascending, empty, or a zero price `bad-prices`. An OPEN from anyone but the operator is listed as
   `open-not-operator`, one outside the open window as `open-outside-window`; both are ignored. Only messages whose
   round field equals the round are considered. Entries are processed in `seq` order.
10. Quorum is per feed: a feed gets a median only with at least `quorum` reports. `status` is `ok` if at least one feed
    has a median, else `no-quorum` (medians, outliers and inBand are then empty; leaves and reportsRoot stay).
    Outlier: beyond SLASH_BPS on any feed with a median (`|p−m|·10000 > bps·m`). In band: within BAND_BPS
    (`|p−m|·10000 ≤ bps·m`) on every feed with a median it reports.
11. `RoundResult` gains two fields: `inBand: Leaf[]` (reward list) and `skippedByOpener: string[]` (qor1 of scouts that
    counted only through their own REVEAL, the public record of the operator's skips, limit L4).
12. Test vectors for Solidity live in `fixtures/vectors/*.json`; fixture rounds in `fixtures/rounds/*.json` with
    TEST-ONLY keys in `fixtures/scouts.json`. Regenerate with `npm run vectors|fixtures -w @sealed-scouts/core`.

**2026-11-19 (coordinator).**

12. REPORT seal purpose is `sealed-scouts/report/v1:<rollupId>` (colon). QoreSeal 0.1.0 accepts only
    `[A-Za-z0-9._:/-]{1,128}` in a purpose, so `|` is refused. The aad is unchanged.
13. `roundHash` domain is final as in item 1: `chainId` is the EVM chain id as `uint256` (`block.chainid`), not the
    native chain id string. Contracts and TypeScript both follow this; the vectors in `fixtures/vectors/` are the reference.
