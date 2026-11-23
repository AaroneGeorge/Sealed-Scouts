# Submission guide: Build Before Q-Day project page

This is the copy and the checklist for the Sealed Scouts page on [build.qorechain.io](https://build.qorechain.io), the QoreChain Developer Fest site.

- **Deadline:** 2 December 2026, 23:59 UTC.
- **No submit button:** the page as it stands at the deadline is what the jury sees.
- **Checks:** run from 3 to 5 December. Judging runs from 6 to 15 December.

Every block below is ready to paste. Use the copy button at the top right of each block.

## 0. Before you start

- **Every team member** finishes registration at https://build.qorechain.io/register: all four steps (GitHub, details, X, QoreX on Testnet).
  - The project form only opens for a complete registration.
  - The QoreX step can need a little test QOR. Use the [faucet](https://dashboard.qorechain.io/faucet), or ask a teammate to send some.
- **Have the video link ready** (YouTube, Vimeo or Loom; unlisted is fine; 3 minutes or less). The form takes a link, not a file.
- **Download the cover image:** [docs/images/cover.png](images/cover.png). On GitHub, open it and use the download button. It is 1920 x 1080 PNG, about 200 KB. The rule is 16:9, at least 1200 x 675, up to 5 MB, JPG, PNG or WebP.

## 1. Create the project

Go to https://build.qorechain.io/projects/new. Name, tagline and category are enough to create it, and every field can be edited until the deadline.

### The project

**Name** (max 60)
```text
Sealed Scouts
```

**Tagline** (max 120; this one is 112)
```text
A post-quantum price oracle for QoreChain: sealed reports, ML-DSA-signed rounds and a watchtower anyone can run.
```

**Category:** choose **Protocol Builders**. It is for teams of 2 to 4: "Build a rollup or sidechain with settlement verification, monitoring and confidential data."

**Description** (max 5000)
```text
Every lending app trusts a price, and whoever sets that price controls the money. On Q-Day, quantum computers break today's signatures, and price reporters are the first target. QoreChain has no price feed yet. Sealed Scouts is one, built for that day.

Scouts read fETH, fBTC and fUSD prices and seal each report with ML-KEM-1024, so no scout can copy another. The sealed reports go into an optimistic rollup on QoreChain (sealed-scouts-1). When the round closes, the operator opens them, takes the median and signs the batch with ML-DSA-87. The round's hash rides inside the batch's anchor signature. The PriceFeed contract on QoreChain's EVM checks that signature with the chain's own pqcVerify before it accepts a price. A lending contract reads only final, fresh prices.

We attacked it on testnet three times, and every transaction is public:
- Stolen keys: an attacker with three scouts' classical keys tried to post a $1 price. The chain refused all 9 attempts, because each post also needs the scout's post-quantum signature.
- Lying operator: the operator signed a wrong median. The watchtower challenged it, PriceFeed recomputed the median from the committed reports and corrected the price, and the operator's bond was slashed.
- Bad batch: a rogue submitter posted a rollup batch with a false ledger root. Our watchtower sent the chain's fraud proof 3 blocks later, and the 1,000 QOR bond was slashed.

Scouts are paid on the rollup and withdraw to QoreChain with a Merkle proof. Anyone can check it without a key: `npm run judge` reads the public chain, verifies the settlement receipt and calls pqcVerify. 15 of 15 claims have a testnet transaction in PROOF.md.
```

**How it's made** (max 5000)
```text
TypeScript monorepo (npm workspaces) and Solidity (Foundry).
- @qorechain/rdk creates the rollup, plans and submits qledger batches with the ML-DSA-87 anchor, builds and verifies settlement receipts, builds fraud proofs and executes withdrawals.
- @qorechain/sdk and @qorechain/evm sign hybrid secp256k1 + ML-DSA-87 transactions, register PQC and KEM keys, and call the EVM through scoped windows.
- @qorechain/pqc, @qorechain/qoreseal and @qorechain/qoresign handle keys, sealing reports with ML-KEM-1024 and signing commitments.
- PriceFeed.sol and ScoutLend.sol use the pqcVerify and pqcKeyStatus precompiles. ScoutLend lends fUSD against fETH and reverts on a pending or stale price.
- The watchtower replays every round and batch from chain data, challenges a wrong median or a bad batch, and publishes a feed. The demo page (React, Vite) reads that feed.

On testnet (qorechain-diana): rollup sealed-scouts-1; PriceFeed 0x110a96a80c15b848e6eb2b2763b4edb0da8d9660 and ScoutLend 0x22f08118c899a2b970268516ff6dd1447ad6f397 on the EVM (chain 9800).

The hard part was making a wrong price fixable after the fact: the operator's signed median waits as pending until the challenge window closes, and the contract can recompute it from the committed reports.

A threat model (THREAT_MODEL.md) and the known limits (LIMITS.md) are in the repo. The tests are Vitest and forge, and they run in CI.
```

**Cover image:** choose `cover.png`, the file from step 0.

### Links

**Public GitHub repository**
```text
https://github.com/AaroneGeorge/Sealed-Scouts
```

**Video (up to 3 minutes, required):** paste the video link.

**Demo**
```text
https://sealed-scouts.tailcdec7a.ts.net
```

**Testnet addresses** (qor1 only, one per line, up to 5; the site reads the chain for these)
```text
qor1gydsf0760dumk23gzph45w5y8gltuch8zfn9qf
qor1rya9eu5y27wh39rjwwehy52nz9knelye04k9gp
qor1crqflnm8lwqm5arhzw3kww3kmvzz56vkgh2z0f
qor15kzqgl4953c7fuekjwzalw3y0hy36zhc3e6ras
qor1f5yzt3au8nkgmswey6cszhfyre573duqy60x2m
```
In order: the operator (rollup creator, sequencer, opener), the watchtower, then scouts 1, 2 and 3. The 0x contract addresses do not go in this box; they are in "How it's made".

### Kits and SDKs used

The site checks the repo's `package.json` files and marks what it finds as verified. Each kit's box lists its packages by language; hover over a checkbox to see the package name. Tick:

- [ ] **QoreChain SDK:** the first **TypeScript** box (`@qorechain/sdk`). The second **TypeScript** box in the same kit is `@qorechain/evm`; tick it too. There is no separate EVM kit.
- [ ] **RDK:** TypeScript (`@qorechain/rdk`)
- [ ] **PQC:** TypeScript (`@qorechain/pqc`)
- [ ] **QoreSeal:** TypeScript (`@qorechain/qoreseal`)
- [ ] **QoreSign:** TypeScript (`@qorechain/qoresign`)

The project page then lists 5 kits as Verified: qorechain-pqc, QoreSeal, QoreSign, RDK and QoreChain SDK.

### Network features used

The site checks the testnet addresses on chain and marks what it finds as verified. Tick these 8 and leave the rest unticked:

- [ ] Hybrid ML-DSA-87 transactions
- [ ] PQC key registration with proof of possession
- [ ] EVM window (incl. scoped)
- [ ] Solidity PQC signature check
- [ ] Solidity PQC key status
- [ ] QoreSeal and the encryption key registry
- [ ] Test tokens fUSD, fETH, fBTC
- [ ] RDK rollup

### Special awards

- **Quantum Campus:** tick only if every team member is a student.
- **AI-Native:** leave unticked.
- **Regional:** pick the country the team represents, normally where most members live. It costs nothing and enters the project for that region's award.
- **Q-Day Survivor:** not on this form. The drill ran on 18 November and needed a sign-up by 17 November.

Then press **Create**. The site takes a few seconds to check the repo and the addresses.

## 2. Add the team

Protocol Builders needs at least 2 members.

1. The project owner opens **My space** and invites each teammate by GitHub username.
2. Each teammate accepts the invite from their own **My space**.
3. Check that every member shows on the project page.

## 3. Install the GitHub App

When the repo is linked, the site offers the **QoreChain Build** GitHub App. Install it on `AaroneGeorge/Sealed-Scouts` only. Commits then appear in the live feed, and the kits are checked.

## 4. Check before the deadline

Open the public project page signed out (a private window), and check:

- [ ] Name, tagline, description and how it's made read correctly.
- [ ] Category is Protocol Builders.
- [ ] The cover shows. Without one, the site makes a plain cover.
- [ ] The video link plays and is 3:00 or less.
- [ ] The demo link opens and shows a recent round.
- [ ] The repo link works; the repo is public with the Apache-2.0 licence and a README.
- [ ] All 5 testnet addresses are listed.
- [ ] Kits and features show as **Verified**, not only Declared. If one stays Declared, check that it is really in the repo or on chain.
- [ ] Every team member shows, and each has a complete registration.
- [ ] Commits during the fest are visible in the feed.
- [ ] `npm run judge` exits 0 from a fresh clone.

Check once more on 1 December. Finalists may get a change request during judging, with 48 hours to answer.
