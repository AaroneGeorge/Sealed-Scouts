# Limits

What Sealed Scouts does not do, or does only in part. Read this with [THREAT_MODEL.md](THREAT_MODEL.md).
Anything not yet on the testnet is design, and [PROOF.md](PROOF.md) lists what has a transaction behind it.

## L1. Testnet only

`pqcVerify` and `pqcKeyStatus` are not active on mainnet. The contracts fail closed there: a call reverts instead of
accepting a signature. There is nothing to fix on our side. It depends on the chain enabling the precompiles.

## L2. The chain's fraud proof covers the ledger, not prices

A new optimistic rollup on QoreChain must use the fixed `qledger-v1` ledger, and the chain re-runs only that ledger
in a fraud proof. A wrong price is not a ledger fault. Price faults are judged by our EVM court (`PriceFeed`), which
recomputes the median. The two systems are tied only by the anchor signature, which covers the round hash.

## L3. One opener can read reports early

Reports are sealed to one key, the operator's. That key holder can read them before the round closes and could leak
them to a colluding scout. A stretch fix is to seal each report twice (operator key, then watchtower key), so no
single holder can open it. The size was checked: 3,536 bytes, which fits in one inbox post (limit 6,144 bytes).
It is not built in v1.

## L4. The EVM cannot see a left-out report

The EVM cannot read the rollup's inbox. It cannot tell whether the operator left a valid report out of a round.
Leaving one out is visible to anyone who replays the chain, the scout can reveal its own report, and the watchtower
flags the skip. The skip is counted in public. It is not slashed in v1.

## L5. A forged leaf is caught but not slashed

A forged leaf is a report nobody posted. Replay catches it, but v1 does not slash for it. An honest scout still
cannot be hurt by it: slashing a scout needs that scout's own ML-DSA-87 signature. A stretch fix is a
`demandSignature` game that makes the operator produce the scout's signature or lose its bond.

## L6. One party plays most roles

In v1 the operator is also the creator, sequencer, opener and relayer. That is one party. Watchtowers are
independent by design (anyone can run one), but the ones in the demo are run by us.

## L7. Finality takes time

Round finality on the EVM is 120 seconds in the demo configuration. Batch finality on the chain is 1 hour on
testnet (7 days by default on mainnet). A price is `Final` after its challenge window, and a withdrawal needs the
batch to finalise first.

## L8. Bonds and rewards are in two places

Scout bonds sit in the EVM contract. Rewards sit on the rollup ledger. A scout has to manage both. The economics
are toy numbers, chosen for a demo. They are not tuned to any real market.

## L9. Not audited

No third party has reviewed the contracts or the code. Do not use it with real funds. See [SECURITY.md](SECURITY.md).

## Real or simulated

| Item | Real or simulated |
|---|---|
| Rollup, batches, anchors, receipts, fraud proof, bond slash, withdrawal | Real testnet transactions (as they are produced; see PROOF.md for what exists now). |
| Sealed reports, KEM key registration, opening | Real. |
| `PriceFeed` and `ScoutLend`, court slash | Real contracts on the testnet EVM. |
| Price data for ETH, BTC and a USD stable coin | Real public exchange APIs. |
| fETH, fBTC, fUSD | Test tokens from the fest. No market. We map real ETH, BTC and USDC prices onto them. |
| Scouts | Our own bots (3 to 5). Anyone could run one. |
| Attacker with stolen ECDSA keys | Our script, using the real classical keys of our own test scouts. The refusals are real chain responses. |
| "Same attack on a classical oracle" comparison | **Simulated** on a local chain. Labelled as simulated on screen. |
| Kochi onion feed (optional) | Real government open data, updated daily. |
