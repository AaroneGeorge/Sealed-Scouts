# Runbook

How to run, check and host the Sealed Scouts services. Testnet only (`qorechain-diana`, EVM chain id 9800).

Keys never go in the repository or in a container image. Scripts that send transactions read keys from environment
variables (see `.env.example`). Everything in "Check" and "Host the demo" runs with no key at all.

## Services

| Service | Needs a key | Start | Notes |
|---|---|---|---|
| Scouts (3 to 5) | yes, one per scout | `npm run scout -w @sealed-scouts/scout` | One process per scout. |
| Operator | yes | `ops/operator.sh` | Opens rounds, submits anchored batches, relays to `PriceFeed`. |
| Watchtower, observe | no | `npm run watchtower -w @sealed-scouts/watchtower -- --observe` | Replays everything, writes `feed/`, sends nothing. |
| Watchtower, active | yes (`TOWER`) | `npm run watchtower -w @sealed-scouts/watchtower -- --active` | Same, and sends challenges. |
| Read API + page | no | `npm start -w @sealed-scouts/api` | Serves `apps/web/dist`, the feed and the evidence. |

The live loop (operator, scouts, one active watchtower) runs as systemd services, so it starts at boot and restarts
after a crash. `ops/install-systemd.sh [--topup SCRIPT]` writes and enables `sealed-scouts.target`,
`sealed-scouts-operator.service`, `sealed-scouts-scout@SCOUTn.service` and `sealed-scouts-watchtower.service` (and,
with `--topup`, a 6-hourly `sealed-scouts-topup.timer`); each loads its keys from `ops/env.local.sh` and logs to
`run/<name>.log`. After that `ops/loop.sh start|stop|status` drives the services; without them it starts the same
processes detached, as before.

Other long-running processes are started detached, with logs and pids in `run/` (git-ignored):

```bash
setsid nohup npm start -w @sealed-scouts/api > run/api.log 2>&1 < /dev/null & echo $! > run/api.pid
```

## Read API settings

All optional. Paths are relative to the repo root.

| Variable | Default | What |
|---|---|---|
| `PORT`, `HOST` | `8790`, `127.0.0.1` | Where it listens. |
| `QORE_REST` | `https://api-testnet.qore.host` | The QoreChain REST endpoint it reads. |
| `FEED_DIR` | `feed` | The watchtower's output. |
| `EVIDENCE_DIR` | `packages/attacks/evidence` | Attack runs shown on the Attacks tab. |
| `DEPLOYMENTS_FILE` | `deployments/diana.json` | Rollup id and contract addresses. |
| `WEB_DIST` | `apps/web/dist` | The built page. |
| `RATE_PER_MIN` | `120` | Requests per minute per client on `/api/*`. |
| `TRUST_PROXY` | off | `1` behind a proxy that overwrites `X-Forwarded-For`. |

Routes: `GET /health`, `GET /api/feed/status.json`, `GET /api/feed/rounds/<n>.json`, `GET /api/evidence/index.json`,
`GET /api/evidence/<file>.json`, `GET /api/deployments`, and `GET /api/chain/<path>` for a fixed list of QoreChain
REST reads (`apps/api/src/whitelist.ts`). Everything else is refused. Only GET and HEAD are accepted.

## Check

```bash
npm run judge -w @sealed-scouts/api                       # our rollup, latest batch, no key
npm run judge -w @sealed-scouts/api -- --rollup vigil-1    # the same receipt checks on another rollup
curl -s http://127.0.0.1:8790/health                       # API up, feed age
```

`judge` exits 0 when every check passes, 1 when one fails, 3 when something is not live yet. Once deployments exist,
it replays the rounds around the checked batch itself, with the watchtower in observe mode, so the price-round checks
do not trust our feed. The replay is capped at 90 s. If it cannot finish, the judge prints a warning, reads the
published feed (`demoUrl` in the deployments file) and marks each price-round line "(from the published feed)".
`--feed-url` or `--feed-dir` skips the replay on purpose.

### Round timing: normal or demo

Every replayer must cut rounds at the same heights as the operator. The operator records its choice as
`"roundMode": "demo" | "normal"` in `deployments/diana.json`. The watchtower, the scouts and `judge` follow it by
default; `SS_DEMO=1` (or `0`) overrides it, and `--demo` / `--no-demo` overrides both. The hosted container passes
`--demo` to its watchtower when `roundMode` is `demo`.

## Evidence files and PROOF.md

`npm run proof -w @sealed-scouts/api` rewrites `PROOF.md` from two inputs:

- `evidence/claims.json`: one entry per claim id (ids are listed in `apps/api/scripts/proof.ts`, `CLAIMS`).

  ```json
  { "claims": { "rollup-created": { "tx": "A1B2…", "layer": "native", "note": "height 10512345" } } }
  ```

  `tx` is a transaction hash. `layer` is `native` (a QoreChain transaction, linked to the public REST endpoint) or
  `evm` (checked with `eth_getTransactionReceipt`). `note` is optional text, for example a read to repeat.
- Attack runs written by `packages/attacks` to `packages/attacks/evidence/<name>.json`. Only live runs count; dry runs
  (`*.dry-run.json`) are local and git-ignored.

A claim with no evidence stays "pending". Never put a hash in by hand that you have not checked on chain.

## Sample data for the page

```bash
npm run fixtures -w @sealed-scouts/api   # replays the watchtower's simulated demo history into apps/api/fixtures/feed
npm run dev -w @sealed-scouts/api        # API on :8790 with the sample feed and sample evidence
npm run dev -w @sealed-scouts/web        # page on :5173, /api proxied to :8790
```

The sample feed runs on the rollup id `sealed-scouts-sim`; the page shows a "sample data" banner for it.

## Host the demo

The public demo runs as one Docker container on a [Dokku](https://dokku.com) host: the read API, the built page and a
watchtower in observe mode. It holds no keys. The app is called `sealed-scouts`; the demo address is in the README
once it is public.

### First time

1. Check the image builds, locally:

   ```bash
   apps/api/scripts/deploy-host.sh --dry-run
   ```

2. On the Dokku host, create the app (private at first) and build it from a Dockerfile:

   ```bash
   dokku apps:create sealed-scouts
   dokku builder:set sealed-scouts selected dockerfile
   dokku ports:set sealed-scouts http:80:5000
   ```

3. Deploy from the working tree, then watch it start:

   ```bash
   apps/api/scripts/deploy-host.sh                 # DOKKU_CMD="ssh dokku@host" for a remote host
   dokku ps:report sealed-scouts
   dokku logs sealed-scouts --tail
   ```

4. Check it before it is public: open the address, press Verify on chain, read `/health`.
5. Make it public through the host's HTTPS front end. Check it from a phone on mobile data before sharing the link.

### Every update

```bash
npm run build -w @sealed-scouts/web && npm test     # check first
apps/api/scripts/deploy-host.sh                     # build and roll out
curl -s https://<demo address>/health
```

Roll back with `dokku ps:rollback sealed-scouts` (or redeploy the previous tree). Take it offline with
`dokku ps:stop sealed-scouts`.

### Feed inside the container

By default (`RUN_WATCHTOWER=1`) the container runs `packages/watchtower` in observe mode against
`deployments/diana.json` and writes the feed to `/tmp/feed`. Before the rollup exists there is no deployments file:
the watchtower does not start, and the API serves the bundled sample feed and sample evidence
(`apps/api/fixtures`), which the page labels as sample data. Redeploy once `deployments/diana.json` exists to switch
to the live feed. The Verify tab reads the real chain either way.

Keep the feed on persistent storage, so a restart or a redeploy does not start the replay from round 0: on start the
watchtower takes back the rounds it already settled from the round files in its feed folder (`--no-restore` turns
that off) and re-reads only the rest from the chain.

```bash
dokku storage:ensure-directory --chown false sealed-scouts-feed
sudo chown 1000:1000 /var/lib/dokku/data/storage/sealed-scouts-feed       # the image runs as node (uid 1000)
dokku storage:mount sealed-scouts /var/lib/dokku/data/storage/sealed-scouts-feed:/app/feed-data
dokku config:set sealed-scouts FEED_DIR=/app/feed-data
```

A fresh folder can be seeded with a copy of another watchtower's `feed/` first. `RUN_WATCHTOWER=0` serves the folder
as it is, with no watchtower in the container.

### Deploy script

`apps/api/scripts/deploy-host.sh [--dry-run] [APP]` packs the working tree without `.git`, `node_modules`, `.env*`,
`feed/`, `run/`, build output or `ops/env.local.sh`, puts `apps/api/Dockerfile` at the root, refuses if an env file
or anything that looks like a key is inside, and sends it to `dokku git:from-archive` (`DOKKU_CMD`, default
`sudo -n dokku`, picks how Dokku is reached). `--dry-run` builds the image with local Docker and deploys nothing.

## Stop

```bash
kill "$(cat run/api.pid)"                                      # a local API started as above
dokku ps:stop sealed-scouts                                    # the hosted demo
```

Never stop services with a broad `pkill -f` pattern: it can match other processes on the server.
