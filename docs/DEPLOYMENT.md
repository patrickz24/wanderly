# Deployment (Fly.io + Neon)

Status: **prepared, not yet deployed.** The configuration is ready (`infra/fly/`, `make deploy`,
`.github/workflows/deploy.yml`). Hosting is confirmed at milestone 7, once the accounts below
exist. Anything marked **TODO(first deploy)** can only be checked against the real platform.

## 1. Why Fly.io + Neon

| Need                      | Choice                                       | Why                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run the two Docker images | **Fly.io**, region `cdg` (Paris)             | Deploys the same images as `docker compose`, health checks, release command for migrations, one-command rollback to a previous image, private networking (Flycast), scale-to-zero.        |
| Postgres 16 + pgvector    | **Neon**, AWS `aws-eu-central-1` (Frankfurt) | Managed Postgres with `pgvector` on every plan, HNSW indexes, branching (copy-on-write) for safe migrations, scale-to-zero. Neon has no Paris region; Frankfurt keeps the data in the EU. |

Alternative with more ops and fewer moving parts: a small VPS (e.g. Hetzner) running this
repository's `docker-compose.yml` behind Caddy for TLS. You get one bill and no cold starts, but
you own OS patching, backups, TLS renewal, firewalling and monitoring. If you go that way, put
Caddy in front of the `web` service and set `WANDERLY_REAL_IP_HEADER` / `WANDERLY_REAL_IP_FROM`
on the web container to Caddy's header and network (see section 3).

Possible latency improvement, not measured: `fra` (Frankfurt) instead of `cdg` would put the API
next to the Neon database. Change `primary_region` in both `infra/fly/*.fly.toml` if latency
measurements justify it.

## 2. Accounts and CLI (Patrick)

1. **Fly.io** account (https://fly.io/app/sign-up) with a payment method (there is no free tier
   for new organizations, see section 13).
2. **flyctl** (https://docs.fly.io/flyctl/install):
   - Windows: `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`
   - macOS: `brew install flyctl`; Linux: `curl -L https://fly.io/install.sh | sh`
   - then `fly auth login`.
3. **Neon** account (https://neon.com). The console is enough; the CLI (`neon`) is optional.
4. **Anthropic** and **Langfuse Cloud (EU)** keys (milestone 3).
5. **GitHub**: environment `production` (Settings → Environments) with a required reviewer and
   "Deployment branches: main only", for the manual deploy workflow (section 9).

## 3. Topology on Fly.io

```
browser ──HTTPS──▶ Fly edge proxy ──HTTP──▶ wanderly-web (nginx :8080, public)
                                                │  /api, /health, /ready
                                                ▼  http://wanderly-api.flycast:80 (private)
                                  Fly proxy ──▶ wanderly-api (Fastify :3000, no public IP)
                                                │  TLS
                                                ▼
                                  Neon Postgres 16 + pgvector (Frankfurt)
```

- **Two apps, two images**, the same ones as `docker compose`: `infra/fly/web.fly.toml` and
  `infra/fly/api.fly.toml`. A single app would need a third image bundling nginx and Node under a
  process supervisor; two apps keep the images identical across environments.
- **Flycast, not `.internal`.** The API has no public IP and only a private Flycast IPv6.
  Flycast goes through the Fly proxy, so the API can scale to zero and be woken by the web app;
  `.internal` addresses bypass the proxy (no auto-start) and change when Machines are replaced,
  which would break nginx's upstream (resolved once at startup). The Flycast address is stable.
- **Client IPs.** The Fly proxy sets `Fly-Client-IP`, and the right-most `X-Forwarded-For`
  entry it sends is the app's own IP (Fly docs, request headers), so trusting `X-Forwarded-For` by private ranges would
  return the app's IP for every visitor. Instead nginx is the trust boundary: it takes the client
  address from `Fly-Client-IP` only when the TCP peer is the Fly proxy (`WANDERLY_REAL_IP_FROM`,
  172.16.0.0/16, a community-reported range), then **overwrites** `X-Forwarded-For` with that
  single address. The API trusts private hops only (`TRUST_PROXY=uniquelocal`: 10/8, 172.16/12,
  192.168/16, fc00::/7, which covers the Fly proxy and the fdaa:: 6PN network), so Fastify's
  `request.ip` is the visitor. No API code change is needed if the Flycast hop preserves the
  header; this is verified in section 6. The same chain was tested locally with compose by
  simulating the edge (spoofed `X-Forwarded-For`, `X-Real-IP` and `Fly-Client-IP` from an
  untrusted peer are ignored; `Fly-Client-IP` from a trusted peer reaches the API).
- **One Machine per app** (`--ha=false` in `make deploy`): the API rate limiter is in memory and
  is only correct for a single instance (multi-instance needs Redis, see the roadmap).

## 4. One-time setup

App names are global on Fly.io. If `wanderly-api` or `wanderly-web` is taken, pick other names
and update: `app` in both config files, `WANDERLY_API_UPSTREAM` in `web.fly.toml`
(`<api-app>.flycast:80`) and `CORS_ORIGINS` in `api.fly.toml` (`https://<web-app>.fly.dev`).

```bash
# Apps (empty, no Machines yet)
fly apps create wanderly-api
fly apps create wanderly-web

# Private Flycast address for the API (and nothing public)
fly ips allocate-v6 --private -a wanderly-api
fly ips list -a wanderly-api          # expect a single private v6 address
```

Neon (console): create a project with **Postgres 16** in **AWS Europe (Frankfurt)**, database
`wanderly`. Copy the **direct** connection string (host without `-pooler`): migrations take a
session-level advisory lock, which Neon's pooler (PgBouncer, transaction mode) does not support,
and the API's pool (10 connections) is far below the direct connection limit. Keep
`sslmode=require` in the URL. The `vector` extension is created by the first migration.

API secrets, read from a file so that they never land in the shell history (`.env.*` files are
gitignored; delete the file afterwards):

```bash
# .env.production (local only)
DATABASE_URL=postgresql://...neon.tech/wanderly?sslmode=require
SESSION_SECRET=<node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))">
ANTHROPIC_API_KEY=            # milestone 3
LANGFUSE_PUBLIC_KEY=          # milestone 3, both Langfuse keys or neither
LANGFUSE_SECRET_KEY=

fly secrets import --stage -a wanderly-api < .env.production
```

Only list variables that have a value; later milestones add theirs with the same command.

GitHub deploy tokens (one per app, least privilege; the default expiry is 20 years, so set one):

```bash
fly tokens create deploy -a wanderly-api --expiry 8760h   # → secret FLY_API_TOKEN_API
fly tokens create deploy -a wanderly-web --expiry 8760h   # → secret FLY_API_TOKEN_WEB
```

Store both as **environment secrets** of the GitHub `production` environment.

## 5. Configuration reference

| Variable                                                                  | App | Set in                                          | Value                                            |
| ------------------------------------------------------------------------- | --- | ----------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`                                                            | api | `fly secrets`                                   | Neon direct connection string, `sslmode=require` |
| `SESSION_SECRET`                                                          | api | `fly secrets`                                   | ≥ 32 random characters                           |
| `ANTHROPIC_API_KEY`                                                       | api | `fly secrets`                                   | milestone 3                                      |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`                              | api | `fly secrets`                                   | milestone 3, both or neither                     |
| `NODE_ENV=production`                                                     | api | `api.fly.toml` `[env]` (also the image default) | Secure cookies, JSON logs                        |
| `LOG_LEVEL=info`                                                          | api | `api.fly.toml`                                  |                                                  |
| `CORS_ORIGINS`                                                            | api | `api.fly.toml`                                  | `https://wanderly-web.fly.dev` (+ custom domain) |
| `TRUST_PROXY=uniquelocal`                                                 | api | `api.fly.toml`                                  | see section 3                                    |
| `LANGFUSE_BASE_URL`                                                       | api | `api.fly.toml`                                  | `https://cloud.langfuse.com` (EU)                |
| `HOST`, `PORT`, `EMBEDDING_CACHE_DIR`                                     | api | image defaults                                  | `0.0.0.0`, `3000`, `/app/.cache/models`          |
| `LLM_*`, `AGENT_*`, `DAILY_BUDGET_USD`, `RATE_LIMIT_*`, `EMBEDDING_MODEL` | api | defaults in `services/api/src/config.ts`        | override in `[env]` if needed                    |
| `WANDERLY_API_UPSTREAM`                                                   | web | `web.fly.toml`                                  | `wanderly-api.flycast:80`                        |
| `WANDERLY_REAL_IP_HEADER`, `WANDERLY_REAL_IP_FROM`                        | web | `web.fly.toml`                                  | `Fly-Client-IP`, `172.16.0.0/16`                 |
| `VITE_API_BASE_URL`                                                       | web | Docker build arg                                | empty: same origin (recommended)                 |
| `FLY_API_TOKEN_API`, `FLY_API_TOKEN_WEB`                                  | CI  | GitHub environment `production`                 | `fly tokens create deploy`                       |

Secrets override `[env]` values with the same name. `fly secrets list -a wanderly-api` shows
names and digests, never values.

## 6. First deploy

From the repository root, after section 4:

```bash
make deploy-api     # builds on Fly's remote builder, runs the migrations, starts 1 Machine
fly checks list -a wanderly-api     # health (/health) and ready (/ready) passing
fly ips list -a wanderly-api        # still only the private v6: no public IP
make deploy-web     # allocates the public IPs (shared IPv4 + IPv6) on its first deploy
curl -fsS https://wanderly-web.fly.dev/health
curl -fsS https://wanderly-web.fly.dev/ready
```

`make deploy` does both, API first (the web app's nginx resolves `wanderly-api.flycast` at
startup, and the API's release command migrates the schema before new code runs).

**Verify client IPs** (TODO(first deploy)):

```bash
curl -s -o /dev/null -H 'Fly-Client-IP: 203.0.113.9' -H 'X-Forwarded-For: 203.0.113.9' \
  https://wanderly-web.fly.dev/api/ip-check
fly logs -a wanderly-web --no-tail | tail   # first field of the access log line = your public IP
fly logs -a wanderly-api --no-tail | tail   # "incoming request" remoteAddress = your public IP
```

- nginx shows a 172.x address: the Fly proxy connects from outside 172.16.0.0/16. Set
  `WANDERLY_REAL_IP_FROM` to the observed range and redeploy the web app.
- 203.0.113.9 appears anywhere: a forged header was trusted. Do not go live; fix first.
- The API shows a private (172.x or fdaa:) address: the Flycast hop rewrote `X-Forwarded-For`.
  The API then needs to read the address from the trusted nginx hop (code change in
  `services/api`, owner: API).

## 7. Migrations

- Every API deploy runs the `release_command` of `api.fly.toml` (node-pg-migrate `up`, the same
  command as the compose `migrate` service) in a temporary Machine with the new image and the
  app's secrets. A failure aborts the deploy before any Machine is updated.
- Migrations are forward-only in production. Write them expand/contract (add, backfill, switch
  code, remove later) so that the previous release still runs against the new schema; that is
  what makes the image rollback of section 11 safe.
- Before a risky migration, create a Neon branch (section 12) as a cheap restore point.
- Manual run from a workstation, if ever needed: `DATABASE_URL='<neon direct url>' make migrate`
  (a `DATABASE_URL` given on the command line takes precedence over `.env`).

## 8. Seeding the corpus in production

TODO(milestone 2): the ingestion CLI does not exist yet (`make seed` is a placeholder). The
corpus (`data/corpus`) is not in the API image (`.dockerignore`), so ingestion is meant to run
from a workstation against Neon, embeddings computed locally on CPU:

```bash
DATABASE_URL='<neon direct url>' make seed
```

It must use the same `EMBEDDING_MODEL` as the API (vectors are only comparable within one
model). Re-running it must be idempotent (documents carry a checksum).

## 9. Routine deploys

- **Local**: `make deploy` (or `make deploy-api` / `make deploy-web`). It fails with an explicit
  message when flyctl is missing, not authenticated, or an app does not exist.
- **GitHub Actions**: Actions → Deploy → Run workflow (`all`, `api` or `web`). Manual only by
  design. The workflow refuses to run unless the ref is `main` and the `CI` workflow succeeded for
  that exact commit; each app deploys with its own app-scoped token; the `production`
  environment adds the reviewer gate. It runs the same `make deploy-*` targets as a local deploy.

## 10. Custom domain (optional)

```bash
fly certs add wanderly.example.com -a wanderly-web    # prints the DNS records to create
fly certs show wanderly.example.com -a wanderly-web   # wait until the certificate is issued
```

Then add `https://wanderly.example.com` to `CORS_ORIGINS` in `api.fly.toml` and run
`make deploy-api`.

## 11. Rollback

```bash
fly releases -a wanderly-api --image      # previous releases and their image references
fly deploy --config infra/fly/api.fly.toml --ha=false --no-public-ips \
  --image registry.fly.io/wanderly-api:<previous-deployment-label>
```

Same for the web app with `infra/fly/web.fly.toml` (without `--no-public-ips`). The release
command runs again on rollback; it is a no-op because no new migration exists in the older
image. Rolling the **data** back is a separate decision: restore from Neon (section 12).

## 12. Database: branching, backups, restore

- A Neon branch is a copy-on-write clone (instant, no load on the parent). Before a risky
  migration: create one in the console, or `neon branches create --name pre-migration-<date>`.
- History window (point-in-time restore): **6 hours by default on the Free plan**, 1 day by
  default on paid plans, up to 7 days on Launch (Neon docs, 2026-10-10). Neon's pricing page also
  states that instant restore is not available on Free: upgrade before relying on restores.
- Restore to a point in time: `neon branches restore main ^self@<timestamp> --preserve-under-name main-before-restore`,
  or create a branch from a timestamp in the console and repoint `DATABASE_URL`.
- Logical backup at any time: `pg_dump "<direct url>" > wanderly.sql` (direct URL, not pooled).
- Corpus tables are rebuildable from `data/corpus` (section 8); conversations, runs and feedback
  are not, and are kept 30 days (see SECURITY.md).

## 13. Scale-to-zero and costs

Both apps use `auto_stop_machines = "stop"`, `auto_start_machines = true`,
`min_machines_running = 0`, and Neon's free compute always scales to zero after 5 minutes.

- **Cost**: a stopped Machine bills only its root filesystem; the database compute is suspended.
  An idle demo costs close to nothing beyond storage.
- **Latency**: the first request after a quiet period waits for a cold start of the web Machine,
  then of the API Machine (woken through Flycast), then of the Neon compute. These have not been
  measured; TODO(first deploy): measure with `curl -w '%{time_total}'` after 15 minutes idle.
  Milestone 2 adds the embedding model load to the API's cold start (TODO: measure, and consider
  baking the model into the image so that it is never downloaded at startup).
- **Before an interview or a live demo**: set `min_machines_running = 1` in both config files (or
  `fly scale count 1` and disable auto-stop) and redeploy, then revert. Note that the API's
  `/ready` check queries Neon every 60 s while the API runs, so an always-on API also keeps Neon
  awake and consumes compute hours continuously.

Prices as published on the providers' pages, read on **2026-10-10** (check again before
deciding; nothing below was measured on a real bill):

- Fly.io (https://fly.io/docs/about/pricing/): shared-cpu-1x **256 MB $2.19/month**, **512 MB
  $3.69/month**, 1 GB $6.70/month (30 days, running 24/7) in the cheapest regions (`iad`, `ewr`);
  Paris (`cdg`) applies a 1.134615385× regional multiplier, i.e. about $2.48 and $4.19 per month
  (computed). Stopped Machines: $0.15/GB/month of root filesystem. Shared IPv4 and IPv6: no
  charge; a dedicated IPv4 is $2/month (not needed). Outbound data transfer from Europe:
  $0.02/GB. No free tier for new organizations; a free trial of up to 2 hours of Machine runtime
  or 7 days.
- Neon (https://neon.com/pricing): Free plan with 100 CU-hours per project, 1 GB storage per
  project, scale-to-zero after 5 minutes (cannot be disabled), 6-hour history window, 5 GB
  egress per project. Launch plan: $0.106/CU-hour and $0.35/GB-month, no monthly minimum,
  invoices under $0.50 not collected.
- Upper bound for this setup if both Machines ran 24/7 in `cdg`: about $4.19 + $2.48 =
  **$6.67/month** for compute (computed from the figures above), before storage, transfer and
  the database. With scale-to-zero the real figure depends on traffic.
- LLM usage is capped separately by `DAILY_BUDGET_USD` (API) and the monthly spend limit set in
  the Anthropic console.

## 14. Monitoring

- **Fly.io**: `fly status`, `fly checks list`, `fly logs -a <app>`; metrics in the dashboard's
  Metrics tab and the managed Grafana at https://fly-metrics.net (memory, CPU, HTTP responses,
  `fly_instance_exit_oom` for out-of-memory kills).
- **Langfuse Cloud (EU)**: https://cloud.langfuse.com, traces, costs and user feedback scores
  (milestone 3).
- **Neon**: console → Monitoring (compute, connections, storage).
- **Readiness**: `curl https://wanderly-web.fly.dev/ready` reports the database and migration
  checks (`pass` / `fail`).

## 15. Teardown

```bash
fly apps destroy wanderly-web
fly apps destroy wanderly-api
```

Then delete the Neon project (console → Settings → Delete project), revoke the deploy tokens
(`fly tokens list` / `fly tokens revoke <id>`), delete the GitHub `production` environment
secrets, and rotate any key that was ever stored in them. Destroying apps and the Neon project is
irreversible: export what you want to keep first (`pg_dump`, section 12).
