# Private Render staging — setup instructions

Prepared 2026-10-18. **Nothing has been deployed or provisioned by this work. No hosted check has passed yet.** Use branch `beta`; keep `main` and the frozen experiment untouched. These instructions supersede the activation steps in `DEPLOYMENT.md` for this staging phase.

## What is prepared

- `staging.mjs` wraps the reviewed server with the existing fake provider and live-mode browser/Turnstile security. It rejects any nonempty `OPENAI_API_KEY`, refuses an environment kill switch other than `1`, and refuses an unpaused database.
- Outbound JavaScript fetch is limited to Cloudflare's exact Siteverify endpoint, with redirects rejected. There are no model network calls. This is an application guard, not a claim about a host firewall.
- Only `serve`, `migrate`, `initialize`, `status` and `kill` are available. There is no staging resume command. Initial staging cannot admit benchmarks, even if pricing approval is supplied.
- The reviewed product, ledger, migrations, pricing and experiment files are unchanged. `staging.environment.example` contains empty secret fields only.

**Initial topology:** Render Private Service → Render Postgres over the private network. No public web service, custom-domain route, Tunnel route, deployment hook or automatic deploy is created in this phase. Private services have no public `onrender.com` address. A paused application alone is not an access boundary. [Render Private Services](https://render.com/docs/private-services).

## 1. Accounts and permissions

1. Sign in to GitHub as the repository owner and to Render. Grant Render access only to `lj11235/ai-bill-doctor`. Select the `beta` branch explicitly.
2. Create a Render project named `ai-bill-doctor`, with a separate `staging` environment. Use the same region for web compute and database. Keep unrelated services out of this staging environment.
3. Sign in to Cloudflare with permission to manage Turnstile. Choose a reviewer-controlled future hostname such as `staging.your-domain.example`. Replace that example consistently below; do not publish a DNS route yet.
4. Enable MFA for operator accounts. Save database/Turnstile/identity secrets in Render's secret settings or a password manager. Never put them in Git, deploy commands, issue comments or evidence files.
5. **Do not create, copy, configure or inherit an OpenAI API key.** Check shared environment groups as well as service settings. This phase needs no OpenAI account credentials or spending-limit changes.

Creating Render services can incur infrastructure charges. This document prepares the settings; account provisioning and deployment remain separate operator actions. Choose the smallest paid compute/database options offered at setup time. Do not use an expiring free database for a budget ledger.

## 2. Managed Postgres

In Render, choose **New → Postgres**:

| Setting | Value |
|---|---|
| Name | `ai-bill-doctor-staging-db` |
| Database name | `abd_staging` |
| PostgreSQL version | 18, or an explicitly supported version 15+ |
| Region | Same as the Private Service |
| Plan/storage | Smallest suitable paid plan; 1 GB initial storage if offered |
| Public/external access | Remove **all** external IP allow rules; verify external access is disabled |
| Backups | Confirm paid-plan recovery/export availability and retention in the dashboard |

Use the **Internal Database URL** in `DATABASE_URL`, copied directly into Render secret settings. Do not use the external URL or disable certificate verification to get a connection working. Render's internal network is the intended boundary here; do not claim that an unmodified internal connection URL provides certificate-verified TLS. If policy requires that, resolve the provider CA configuration before proceeding. [Render Postgres setup, connections and external-access controls](https://render.com/docs/postgresql-creating-connecting).

All deployments and workers for this staging service must use this one ledger and the same identity secret. Never point staging at a production ledger or `smb-v1` records. Run destructive boundary tests only in additional, clearly disposable databases; never reset this ledger to regain allowance.

## 3. Turnstile widget

In Cloudflare, open **Turnstile → Add widget**:

- Name: `AI Bill Doctor private staging`.
- Widget type: Managed.
- Allowed hostname: the exact future staging hostname, without scheme or path. Do not enable all hostnames or add production/localhost exceptions.
- Pre-clearance: disabled.
- Copy the public site key to `TURNSTILE_SITE_KEY` and the secret to `TURNSTILE_SECRET_KEY` in Render.

The existing browser sets action `benchmark`; the server checks that action, exact hostname and freshness. Do not replace this verifier with dummy success responses on the hosted service. No real widget/token test has run yet; a private service without browser ingress cannot demonstrate that it works. [Widget management](https://developers.cloudflare.com/turnstile/get-started/widget-management/), [server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## 4. Private Service settings

Choose **New → Private Service**, not Web Service. Configure everything before the first deploy:

| Setting | Value |
|---|---|
| Name | `ai-bill-doctor-staging` |
| Repository / branch | `lj11235/ai-bill-doctor` / **`beta`** |
| Runtime | Node |
| Root directory | Leave empty (repository root) |
| Region | Same as Postgres |
| Instance count | 1 initially; no autoscaling |
| Build command | `npm --prefix beta ci --omit=dev --ignore-scripts --no-audit --no-fund` |
| First-deploy pre-deploy command | `node beta/staging.mjs migrate && node beta/staging.mjs initialize` |
| Start command | `node beta/staging.mjs serve` |
| Auto deploy | **Off** |
| Public ingress / custom domains | None |

The one-time initialization deliberately fails if rerun against an initialized ledger. After the first successful private deploy, remove `initialize` from the pre-deploy command; use only `node beta/staging.mjs migrate` on later deploys. Do not change data to make initialization run twice. Native Node startup avoids depending on the unverified Docker image. [Render branch/deploy configuration](https://render.com/docs/blueprint-spec).

### Environment variables

| Name | Exact setting / source |
|---|---|
| `NODE_VERSION` | `24.19.0` |
| `NODE_ENV` | `production` |
| `STAGING_ONLY` | `1` |
| `BETA_MODE` | `live` (security semantics; provider is still fake) |
| `BETA_KILL_SWITCH` | **`1`**, unchanged throughout initial staging |
| `PUBLIC_ORIGIN` | `https://` plus the chosen staging hostname; no trailing slash |
| `PORT` | `10000` |
| `DATABASE_URL` | Staging **internal** Postgres URL, secret |
| `IDENTITY_SECRET` | Generate at least 48 random characters in a password manager; keep stable across deploys |
| `TURNSTILE_SITE_KEY` | Real staging widget public site key |
| `TURNSTILE_SECRET_KEY` | Real staging widget secret, server-only |
| `TRUSTED_PROXY_CIDRS` | Empty for initial private staging |
| `PRICING_APPROVED_HASH` | Unset/empty |
| `PRICING_APPROVED_UNTIL` | Unset/empty |
| `OPENAI_API_KEY` | **Absent**, including inherited environment groups |

Do not use `npm start`, the root `server.mjs`, `beta/server.mjs` or `beta/demo.mjs` as the start command for this service. Do not configure automatic retries, cron benchmarks, payment services, public deploy hooks or preview environments.

### Database permissions before any active testing

The initial private deploy can use the Render-generated owner connection to migrate and initialize. Before admitting any benchmarks in a later phase, separate the runtime role from the migration/operator role. From a private administrative SQL session, with the database name above:

```sql
CREATE ROLE abd_staging_runtime LOGIN;
-- Set its password with the interactive psql \password command, not a SQL literal.
GRANT CONNECT ON DATABASE abd_staging TO abd_staging_runtime;
GRANT USAGE ON SCHEMA public TO abd_staging_runtime;
GRANT SELECT, INSERT, UPDATE ON
  beta_control, beta_days, beta_runs, beta_calls, beta_throttle, beta_events,
  beta_operator_audit TO abd_staging_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO abd_staging_runtime;
```

Use `\password abd_staging_runtime`, then store that role's internal URL as the service's `DATABASE_URL`. Keep the owner connection in an operator-only secret. Run future migrations in a private operator session with the owner URL injected, and remove the service pre-deploy migration command after switching to the restricted runtime role. Do not grant runtime ownership, CREATE, DROP, TRUNCATE or broad DELETE privileges. Verify the actual grants before checking off the database gate; these commands have not been applied to a hosted database.

## 5. Initial hosted checks, with kill switch still on

Use the Private Service's **Shell** or SSH session, from the repository directory. Render supports shell/SSH for Private Services. [Shell access](https://render.com/docs/ssh).

```sh
node beta/staging.mjs status
node beta/staging.mjs kill
node beta/staging.mjs status
```

Expected: database `killed: true`; no active runs and zero accounted spend for a fresh staging ledger. If it already has records, preserve them and investigate instead of resetting it. Verify the dashboard still shows `BETA_KILL_SWITCH=1`.

Check canonical Host health from inside the service without printing secrets:

```sh
node --input-type=module <<'NODE'
const host = new URL(process.env.PUBLIC_ORIGIN).host;
const url = `http://127.0.0.1:${process.env.PORT}/healthz`;
for (const candidate of [host, 'wrong.invalid']) {
  const response = await fetch(url, {headers:{Host:candidate}});
  console.log(candidate === host ? 'canonical-host' : 'wrong-host', response.status);
}
NODE
```

Expected: 200 then 403. Save only statuses, commit SHA, service ID and UTC timestamp. Dashboard deployment success, an open port or a local test result is not enough to certify these checks. Confirm the service has no public URL, the database external allow list is empty, and no `OPENAI_API_KEY` variable is present. Do not dump the environment or connection URL.

## 6. Reverse proxy and later reviewer browser access

**Initial setting is exactly `TRUSTED_PROXY_CIDRS=`.** The app uses the connecting socket IP and ignores user-supplied forwarding claims. All requests must carry `Host` equal to the hostname in `PUBLIC_ORIGIN`. Do not invent Render proxy CIDRs, trust all private networks, use `/0`, or trust an arbitrary hop count.

The real browser/Turnstile and ingress tests remain blocked until a separate reviewer-access configuration is approved. A low-cost route is a Cloudflare Tunnel connector on Render's private network plus Cloudflare Access restricted to named reviewers. Keep the Render application a Private Service, so there is no alternate public origin.

Prepare this later route in this order; **do not enable it in initial staging**:

1. Create the Access application for the exact staging hostname first; allow only explicit reviewer emails/identity group, with no Everyone or Bypass policy.
2. Configure the Tunnel connector to the Private Service's internal hostname and port `10000`. Set its HTTP Host Header to the canonical staging hostname. Require Access JWT validation (`Protect with Access`) with the exact team and application audience.
3. Verify unauthenticated and unauthorized reviewers cannot reach the origin before permitting reviewer sessions. Keep the kill switch on.
4. Identify the actual direct proxy peer addresses and how the complete XFF chain is formed. Trust only the connector/ingress peers whose isolation and header behavior are verified. If Render cannot provide stable narrowly scoped peers, leave the CIDR setting empty and the real-client quota gate blocked; resolve this in a separate reviewed proxy configuration.
5. Test forged XFF, `Forwarded`, `X-Forwarded-Host`, canonical/wrong Host, and direct-origin bypass through this exact route. Record evidence before considering client-IP attribution verified.

Cloudflare supports Host rewriting and Access JWT enforcement at the connector. These capabilities have not been configured or tested for this project. [Tunnel origin settings](https://developers.cloudflare.com/tunnel/reference/origin-parameters/). The additional Access control protects staging infrastructure; it adds no product account system.

## 7. Automated versus manual validation

Use `STAGING-CHECKLIST.md` gate IDs. The previous 211-test result is local evidence only. The new launcher adds six local tests. The normal test suite always creates disposable **local** Postgres clusters; pointing its shell at Render does not turn it into a managed-database test.

| Check | Can be scripted | Actual-host manual work / restriction |
|---|---|---|
| Source SHA, migrations, status, paused rejection, Host handling | Yes, from private shell; no benchmark admission needed | Verify exact service, branch, secrets and no public route |
| Database durability settings, runtime grants, restart persistence | Yes, read-only SQL/status probes | Confirm managed storage, backup/recovery, role ownership and external-access block |
| Atomic budget/quota/idempotency races | Yes, on separately approved disposable managed test databases using the existing ledger | Do not run destructive test fixtures on the staging ledger; active tests are deferred in this paused-only phase |
| Proxy spoofing / direct-origin bypass | Yes after an approved reviewer route exists | Establish genuine trusted peers/header rewriting; verify unauthenticated access is denied |
| Real Turnstile hostname/action, expiry, single use | Verification assertions can be scripted without model calls | Real browser challenge and allowed hostname needed; token reuse uses a new submission UUID; wait over 300 seconds for expiry; never save tokens |
| Active kill, timeout, termination, recovery | Yes with controlled fake calls after later approval | Initial launcher cannot unpause. Host termination and proof all old workers stopped require operator action; preserve full uncertain reservations |
| Docker build/start | Yes on a machine with Docker | No Docker result exists; native Render startup does not certify the Docker image |
| Logs and secrets | Synthetic canary matching can be scripted | Inspect actual container, proxy/CDN, DB, APM and log-drain settings and retention; no body/header/SQL-parameter logging |

For every hosted probe, record `gate | UTC time | commit | service/database ID | command | expected | observed | PASS/FAIL | redacted evidence`. If it was not executed on the hosted environment, mark **NOT RUN/BLOCKED**. Keep all current hosted gates blocked until that evidence exists.

## Stop point

This phase ends with the `beta` branch pushed and these instructions ready. No services, widgets, public routes or live keys are created by the preparation work. When private deployment is separately approved, stop again after the initial paused checks. Full benchmark execution and temporary fake-provider admissions require a later explicit validation phase; this launcher deliberately cannot enable them.
