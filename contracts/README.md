# Contracts

Two contracts on the QoreChain EVM (diana testnet, chain id 9800).

- `src/PriceFeed.sol` takes price rounds from the Sealed Scouts rollup. It accepts a round only with the rollup
  creator's ML-DSA-87 anchor signature, checked by the chain's `pqcVerify` precompile. A round is Pending for a
  challenge window, then Final. During the window anyone can prove a wrong median; the contract fixes the price and
  slashes the operator bond. It also holds scout bonds and slashes a scout that reported far off, using that scout's
  own signature as the proof.
- `src/ScoutLend.sol` is a tiny demo lender. Deposit fETH, borrow fUSD up to 50% of its value. It reads only final,
  fresh prices, so a pending or stale price stops a borrow.

The byte formats are in `docs/SPEC.md` ("Contract ABI" and the "Changes" list). The TypeScript side is
`packages/core`; both are checked against the same vectors in `fixtures/`.

## Rules the contracts enforce

- **No `msg.sender` authority.** Posting, challenging and slashing are open to anyone: the data proves itself.
  Bond exits need an ML-DSA-87 signature from the bond owner's registered key. A stolen ECDSA key gets nothing.
- **Keys come from the chain.** `pqcKeyStatus` gives the current key at each call. The key must be ML-DSA-87,
  2,592 bytes, and registered with proof of possession. The key is never passed in calldata.
- **Fail closed.** The precompiles are called through typed interfaces. Where they are not active (mainnet today),
  a call returns empty data and the decode reverts.
- **Rounds only move forward.** Round number and batch index must both rise, so an old anchor cannot be replayed.
- **Court.** `challengeMedian` needs every leaf of the round, sorted by scout, matching `reportsRoot`. It recomputes
  each median (element `floor((n-1)/2)`) and count. Any difference slashes the whole operator bond: half to the
  caller, half locked forever as burned. An honest round reverts with `HonestRound` and nothing changes.
- **Outliers.** `slashOutlier` works only on a settled round. It needs the leaf, its Merkle proof, and the scout's
  COMMIT signature (`keccak256(sig) == commitSigHash`), verified against the scout's key over the QoreSign text the
  scout signed. A leaf the operator made up can never cost an honest scout its bond.
- **Reads.** `readFinal(feed, maxAge)` uses the newest settled round of the feed. While a newer round is pending it
  falls back to the one before. It reverts if there is no settled price or if it is older than `maxAge` seconds.

## Two signature modes

The round hash rides in the anchor's `validator_set_hash` slot (vsh mode). That slot has not been used on chain
before. If the chain refuses it, deploy with `SS_TWO_SIG=true`: the anchor is signed with an empty vsh and the
operator adds a second ML-DSA-87 signature over the round (`docs/SPEC.md` Changes 14). The ABI stays the same:
`anchorSig` then carries both signatures back to back. `twoSigMode()` says which mode a deployment runs.

## Build and test

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd contracts
forge build
forge test                      # 55 tests: unit, vectors, fuzz, invariants (about 40 s)
forge test --mc GasTest -vv     # prints the gas table below
forge test --gas-report
```

forge-std v1.11.0 is vendored in `lib/forge-std` (no git submodules). solc 0.8.24, optimizer 200 runs,
`evm_version = cancun` (PUSH0, MCOPY and TSTORE all answered on diana's `eth_call` on 19 Nov).

Tests use a mock at `0x…0a01` / `0x…0a02` (`test/utils/MockPqc.sol`). It accepts two kinds of signature: mock keys
derived from a seed, and the exact (key, signature, message) triples of the real ML-DSA-87 vectors. It burns what
the real precompile charges (25,000 + 8 per input byte; 2,500), so gas numbers are close to the chain's.

| Test file | What it covers |
|---|---|
| `PriceFeed.t.sol` | valid anchor accepted; one changed bit refused; wrong key refused; no precompile fails closed; unproven key refused; replay refused; bad attestations; wrong median challenged and slashed; honest round cannot be challenged; leaves must match the root; window closes; outlier slashed with its own signature; in-band scout not slashable; forged leaf cannot slash a scout; two-signature mode |
| `Bonds.t.sol` | anyone can fund a bond; exit and withdraw by ML-DSA-87 signature only; signature works once; exiting operator stops posting but stays slashable |
| `ScoutLend.t.sol` | borrow at a final fresh price; pending, stale or missing price refuses a borrow; LTV; withdraw; liquidation; a court-corrected lie never reaches the lender |
| `Vectors.t.sol` | `fixtures/vectors/*.json` from packages/core: round hash, anchor bytes with real signatures, Merkle, median and band rule, commit text; `fixtures/rounds` 01 and 02 end to end, with the real COMMIT signature from the inbox entry |
| `Fuzz.t.sol` | median against a reference sort; court median skips foreign leaves; for any prices the true round is unchallengeable and any changed median is slashed; outlier boundary |
| `Invariants.t.sol` | bond accounting is conserved; final prices never change; no slash without proof |

## Gas (diana prices, from `forge test --mc GasTest -vv`)

Whole-transaction gas, including the 21,000 base and the calldata. Steady state: round 2, three feeds, four scouts.

| Call | Calldata | Gas |
|---|---|---|
| `postRound` (vsh mode) | 5,540 B | 488,111 |
| `postRound` (two-signature mode) | 10,180 B | 722,222 |
| `challengeMedian` (4 leaves) | 2,020 B | 175,820 |
| `slashOutlier` | 5,348 B | 415,422 |

Where `postRound` gas goes: about 100k calldata and base, 103k signature check (`pqcVerify` is 25,000 + 8 per byte
of a 7.5 KB input), 24k key read, 190k storage for the round, 50k for the event that carries the signature. The key
is read from the chain, not sent, which saves 2.6 KB of calldata. Signatures are emitted, never stored. At about
112 gwei a round costs about 0.055 QOR. The first round of a new feed costs about 70k more (new feed heads).

## ABI for the TypeScript packages

`out-abi/PriceFeed.json` and `out-abi/ScoutLend.json` hold `{ contractName, abi, bytecode }` and are committed.
Regenerate after any change to `src/`:

```bash
./script/export-abi.sh
```

## Deploy (not done yet)

Deploying needs an **unscoped** EVM window for the deployer: a window with `allowed_targets` or `native_only`
refuses contract creation. Open it with the chain helper (`packages/chain`, `evm.withWindow`), deploy, close it.
Later sessions can scope windows to the two contract addresses.

The deploy script reads `deployments/diana.json` (written by the operator launch) for `rollupId`, `operatorEvm`,
`chainId` and `evmChainId`. It refuses a file made for another chain. It writes **only** the `contracts` key
(`{ "PriceFeed": "0x…", "ScoutLend": "0x…" }`) and keeps every other key.

| Env var | Default | Meaning |
|---|---|---|
| `SS_OPERATOR` | `operatorEvm` from the file | rollup creator's EVM address |
| `SS_ROLLUP_ID` | `rollupId` from the file | at most 31 bytes |
| `SS_NATIVE_CHAIN_ID` | `chainId` from the file, else `qorechain-diana` | signed into anchors and messages |
| `SS_TWO_SIG` | `false` | two-signature mode |
| `SS_CHALLENGE_WINDOW` | `120` | seconds a round stays pending |
| `SS_EXIT_DELAY` | `300` | seconds from exit request to withdrawal (at least 2 windows) |
| `SS_MIN_OPERATOR_BOND` | `10e18` | wei of QOR the operator must hold to post |
| `SS_FETH`, `SS_FUSD` | fest tokens on diana | `0x0229…1c28` (18 decimals), `0x9714…63CA` (6 decimals) |
| `SS_LTV_BPS`, `SS_LIQ_BPS` | `5000`, `8000` | borrow limit, liquidation threshold |
| `SS_MAX_PRICE_AGE` | `900` | seconds a price stays usable for ScoutLend |
| `SS_DEPLOYMENTS_FILE` | `../deployments/diana.json` | where addresses are written |

With a window open, from `contracts/` (the deployer key comes from the secret store, never from a file):

```bash
forge script script/Deploy.s.sol --rpc-url https://evm-testnet.qore.host --broadcast \
  --private-key "$SS_DEPLOYER_EVM_KEY" --gas-estimate-multiplier 110
```

Or from TypeScript inside `evm.withWindow`: deploy `out-abi/*.json` `bytecode` with viem using the same constructor
arguments (see `script/Deploy.s.sol`), then write `contracts` with `mergeDeployment`.

After the deploy: fund the operator bond (`bondOperator`, at least `SS_MIN_OPERATOR_BOND`), fund scout bonds
(`bondFor`), and supply fUSD to ScoutLend (`supply`). Check `verifyReceipt` on one real round with `cast call`
before the loop starts posting.

## Known limits

- The court can only judge leaves it is given. If the operator posts a `reportsRoot` whose leaves nobody can rebuild,
  no one can challenge the round. Replaying the inbox shows it (the watchtower flags it), but it is not slashed in v1
  (LIMITS.md L4 and L5).
- An honest scout can lose its bond to a lying median that nobody challenged within the window (the trust assumption
  is one honest watchtower online). The invariant test models exactly this case.
- A scout that asks to exit before a round is posted could withdraw before that round settles. Off-chain derivation
  should treat a scout with a pending exit as not eligible.
- Economics are toy numbers: every slash takes the whole bond.
