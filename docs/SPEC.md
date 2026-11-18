# Sealed Scouts: shared specification (v1)

This file is the contract between the packages. Change it only together with every package that depends on the changed part.


**Inbox messages.** `payload = "SSC1" (4 bytes) | kind (1 byte) | body`. The first byte is never a ledger transaction version, so the ledger skips it.

| Kind | Name | Poster | Body |
|---|---|---|---|
| 0x01 | JOIN | scout | ledger account id (32 bytes) |
| 0x02 | REPORT | scout | round u64 · QoreSeal envelope (mode `mlkem`, purpose `sealed-scouts/report/v1|<rollupId>`, aad `round|scout`) |
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

