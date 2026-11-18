# Sealed Scouts

**Prices that a quantum attacker can't forge and a lazy reporter can't copy.**

Sealed Scouts is a post-quantum price-oracle rollup for [QoreChain](https://qorechain.io), built for the
Build Before Q-Day fest (Protocol Builders track).

QoreChain has no price oracle yet, so no lending, stablecoin or DCA app on it can read a fair price. Oracles are
also the best Q-Day target: whoever forges the reporters' signatures can drain every app that trusts the feed.

## How it works (plan)

1. **Bonded scouts** report prices each round (fETH, fBTC, fUSD from public exchange APIs, plus one real-world feed).
2. **Sealed reports.** Each report is sealed with ML-KEM-1024 until the round closes, so scouts can't copy each
   other's answers.
3. **Rollup.** A rollup takes the median, signs each batch with ML-DSA-87 and settles it on QoreChain with a
   settlement receipt.
4. **Watchtower.** An independent watcher re-runs every batch from its data, challenges a wrong median and slashes
   scouts whose reports fall far outside the band.
5. **Withdrawals.** Scouts withdraw their bond and rewards back to QoreChain.
6. **Consumer.** A small demo lending contract on the EVM side accepts a price only with a valid receipt, checked
   through the `pqcVerify` precompile.

## Status

Work in progress during the fest (4 Nov to 2 Dec 2026). Network: QoreChain testnet `qorechain-diana`
(EVM chain id 9800).

## License

Apache-2.0. See [LICENSE](LICENSE).
