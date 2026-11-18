# Security

Sealed Scouts is hackathon software for the QoreChain testnet. This file says how to report a problem and what to
expect from the code.

## Reporting a problem

- **Not sensitive** (a bug, a wrong claim in the docs, a missing check): open a GitHub issue on
  [AaroneGeorge/Sealed-Scouts](https://github.com/AaroneGeorge/Sealed-Scouts/issues).
- **Sensitive** (a way to forge a price, steal a bond or break report secrecy): use GitHub's private vulnerability
  reporting on the same repository (Security tab, "Report a vulnerability"). Please do not post details in a
  public issue before we have had a chance to look.

Please include the steps to repeat the problem, the round or transaction involved if there is one, and what you
expected to happen.

## Scope

- **Testnet only.** The project runs on QoreChain testnet `qorechain-diana` (EVM chain id 9800). The precompiles it
  relies on are not active on mainnet, and the contracts fail closed there.
- **The contracts are not audited.** Never use them, or any key from this project, with real funds.
- In scope: `contracts/`, `packages/`, `apps/` and the way the project uses QoreChain's rollup module and
  precompiles.
- Out of scope: QoreChain itself, public exchange APIs, the value of test tokens, and collusion of a majority of
  scouts (see [THREAT_MODEL.md](THREAT_MODEL.md)).

## Key handling

- Keys live outside the repository. Scripts read them from environment variables.
- `.env` and `.env.*` files are git-ignored. Only `.env.example` ships, and it holds public testnet endpoint addresses and no keys.
- Tests make throwaway keys in memory. No fixture file holds a private key.
- If you find a real key, token or private address in this repository, report it as sensitive (above).

## The demo API proxy is read-only

The demo page talks to a small proxy (`apps/api`). It:

- accepts `GET` and `HEAD` only; anything else gets `405`;
- forwards only a fixed list of QoreChain REST reads (rollup, batch, anchor, inbox, post-quantum key and
  transaction lookups) and refuses every other path and unknown query key;
- is rate limited and caches answers for a short time;
- holds no keys and sends no transactions.

If you find a way to make it fetch something else, or to write anything, that is a security report.

## Known limits

Open limits are listed in [LIMITS.md](LIMITS.md). What each attack faces, and what is left, is in
[THREAT_MODEL.md](THREAT_MODEL.md). Evidence for each claim, as it exists on chain, is in [PROOF.md](PROOF.md).
