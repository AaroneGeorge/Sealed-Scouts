# Sealed Scouts: 3-minute demo video

QoreChain "Build Before Q-Day", Protocol Builders track.

The demo is not a product tour. It shows a piece of infrastructure surviving attacks. QoreChain has no price feed. This is one that still holds when quantum computers break today's keys, and the video shows people trying to break it.

- **Format:** a screen recording with a voice-over read from section 2.
- **Screen time:** about 65% the demo page, 25% short terminal cuts, 10% title cards and one diagram.
- **Terminal rule:** every terminal cut is followed straight away by the same event on the page.
- **Timing:** 3:00 in total, about 400 spoken words at about 150 a minute.

Demo page: https://sealed-scouts.tailcdec7a.ts.net. Every hash on screen is a real testnet transaction listed in [PROOF.md](../PROOF.md).

## 1. Scenes

| # | Time | On screen | Proof in view |
|---|---|---|---|
| 1. Cold open | 0:00-0:15 | **Terminal:** `npm run demo:stolen-keys` (live run, waits trimmed). The first REFUSED line appears. Cut to the page: #/attacks, the Stolen keys card. | `code 20, codespace pqc`; "9 of 9 refused" |
| 2. The gap | 0:15-0:30 | Title card: "Every lending app trusts a price." Then the front page: masthead and the fETH headline. | "Live testnet feed" |
| 3. How a round works | 0:30-1:00 | Front page, the How it works strip, one step at a time. Then click the newest final round in Recent rounds: sealed reports, the median and the anchor signature. | Report size of about 1,772 bytes; "ML-DSA-87"; status FINAL |
| 4. Break it: stolen keys | 1:00-1:20 | #/attacks, the Stolen keys card: Tried / Stopped by / Cost to attacker. Open "Show every attempt". | Refusal tx `500AD2F8…D3B35642` (code 20) and `B0F284BC…3B2AC4CE` (code 21); forged round: `BadSignature` |
| 5. Break it: lying operator | 1:20-1:42 | The Lying operator card: printed $1.00, should read $1,773.72, PriceFeed now $1,773.72. | Challenge tx `0xa206be90…320a675a` |
| 6. Break it: bad batch | 1:42-2:05 | The Bad batch card: wrong state root, fraud proof 3 blocks later, 1,000 QOR bond slashed. Short terminal cut: `curl` of the challenge tx showing `rdk_fraud_upheld`. | Bad batch `541B07F0…949953B7`; fraud proof `2E65D117…068E969B` |
| 7. Why it matters | 2:05-2:25 | #/lender: a final price is accepted, a pending one reverts. Then the Use the feed snippet. | `readFinal` reverts on a pending round |
| 8. Don't trust us | 2:25-2:50 | **Terminal:** `npm run judge` (PASS lines, exit 0). Then #/verify: press Verify on chain, tick "Change one digit first", press again. | "receipt valid", then "receipt refused" |
| 9. Close | 2:50-3:00 | Front page, the Attacks stopped box, then a title card with both links. | "15 of 15 claims proven on testnet" |

## 2. Read-aloud script

One sentence per line. [pause] is a one-second breath.

### 1. Cold open (0:00-0:15)
This attacker has stolen the keys of every price reporter in this system.
They try to post a price of one dollar.
The chain refuses it. [pause]
Here is why.

### 2. The gap (0:15-0:30)
Every lending app trusts a price.
Whoever sets that price controls the money.
On Q-Day, quantum computers break today's signatures, and price reporters are the first target.
QoreChain has no price feed yet.
Sealed Scouts is one, built for that day.

### 3. How a round works (0:30-1:00)
Scouts read prices from three exchanges.
Each scout seals its report, so no one can copy another's answer.
The sealed reports go into a rollup on QoreChain.
When the round closes, the operator opens them and takes the median, the middle price.
The result is signed with ML-DSA, a post-quantum signature.
The price contract checks that signature with the chain's own pqcVerify before it accepts the price.

### 4. Break it: stolen keys (1:00-1:20)
Attack one.
The attacker has the old keys, but not the post-quantum ones.
Every post is refused, nine out of nine.
A forged round sent straight to the contract fails the signature check and reverts.
The price does not move.

### 5. Break it: lying operator (1:20-1:42)
Attack two.
This time the operator lies, and signs a price of one dollar.
The signature is real, so the price waits as pending. [pause]
Our watchtower replays the round from public data, sees a different median, and challenges.
The contract recomputes the median and corrects the price.
The operator's bond is slashed.

### 6. Break it: bad batch (1:42-2:05)
Attack three.
A rogue submitter posts a rollup batch with a false ledger.
Three blocks later, our watchtower sends a fraud proof.
The chain rejects the batch, and takes the attacker's thousand QOR bond.
Half goes to the watchtower.
Half is burned.

### 7. Why it matters (2:05-2:25)
A lending app reads the feed.
It accepts only final, fresh prices.
While a price is pending or disputed, it reverts.
A forged price never reaches a loan.
Any QoreChain app can use this feed in three lines.

### 8. Don't trust us (2:25-2:50)
You do not have to believe us.
Clone the repo and run npm run judge.
No key and no wallet.
It reads the public chain and checks the signature with pqcVerify.
Or open the Verify tab and press Verify.
Now change one digit.
The same signature fails.

### 9. Close (2:50-3:00)
Sealed Scouts.
Fifteen of fifteen claims, proven on testnet.
Open source.
Links below.

## 3. Recording plan

### Before recording day
- The live loop runs in demo mode, so a round settles about every two minutes: `ops/loop.sh status`. Top up the scouts if needed (`npx tsx ops/fund.ts --fund SCOUT1=60,SCOUT2=60,SCOUT3=60`) and record the tx in the funds ledger.
- Check the page shows no paused-feed or sample-data banner. If one shows, do not record scenes 2, 3 and 7 until it is gone.
- Run `npm run judge` once and confirm exit 0.

### Terminal takes, recorded separately
- **Scene 1 and 4: `npm run demo:stolen-keys`**, a fresh live run. It is cheap: refused transactions move no funds. A new run writes new evidence, so commit it and run `npm run proof` afterwards.
- **Scene 6:** `curl -s https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/2E65D1173044E2AEE71D7732CF42DF540598FB4FA91F3E72C38BE1A6068E969B | jq '.tx_response.events[] | select(.type=="rdk_fraud_upheld")'`.
  - This replays the 20 Nov run's receipt. On screen and in the edit it is a recorded transaction, not a new attack.
  - A fresh bad-batch run costs a 1,000 QOR bond (500 of it burned) and can lose the race to a public network challenger.
- **Scene 5:** show the 19 Nov live run on the page. A fresh run needs the operator's lie switch for one round and slashes its 10 QOR bond. It is optional.
- **Scene 8: `npm run judge`.** Trim the wait, and keep the start and the PASS lines.

### Screen
- 1920x1080, browser at 110% zoom, light edition (the dark edition for one beat in scene 2 is fine), terminal font 18 pt.
- Show the start and the result of any slow command, and cut the wait.

### Honesty rules
- Every hash on screen is real and in PROOF.md.
- A replayed receipt is shown as a past run, with its date, never as happening now.
- If a live step fails on the day, say so, or use the matching past run from PROOF.md and name its date.
- Say "testnet" at least once.
- Known limits are in LIMITS.md: one operator in v1, testnet only, not audited.
- If a judge asks about bad-batch run 1: a public network challenger proved that fraud first, so it is not counted as ours. That shows the network's own watchers work too.

### Terms
- **Q-Day:** the day quantum computers break today's signatures.
- **ML-DSA:** a post-quantum signature.
- **ML-KEM:** a post-quantum lock.
- **Median:** the middle price.
- **pqcVerify:** the chain's own signature checker.
- **Watchtower:** anyone can run it, with no key.
