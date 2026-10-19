# Deployment — after review

Nothing has been publicly deployed. All local verification uses fake model calls. Keep the service paused until the setup below is complete and the owner approves activation.

## Smallest practical host

Use one always-on Node web service and paid managed Postgres in the same region. Render is one simple option: its published small-service example is roughly **$13/month for web + database compute**, before storage, bandwidth, tax or domain costs. Budget around **$15–20/month for infrastructure**, plus model spend, limited by this app to $5/day and $50 across the beta. Turnstile's Free plan supports this use. Confirm checkout prices before purchasing. [Render cost example](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses), [compute plans](https://render.com/docs/compute-plans), [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/).

Use a persistent paid database: an expiring free database must not become a way to reset the lifetime budget. Keep the same database on every deployment. Do not create a fresh database for each release or connect a preview deployment to the live database.

## Exact remaining manual setup

1. **Review this implementation.** Approve hosting separately; this work has not authorized a deployment or paid test. Decide the beta hostname and privacy contact.
2. **Provision Postgres 15+** with durable storage and backups. Use a database reserved for this beta. Store its connection URL in the host's secret manager. Use private networking or certificate-verified TLS for remote connections. Never disable certificate checks. Record how to restore the ledger without discarding later spending (see recovery guide).
3. **Create a dedicated OpenAI API project and service key.** Restrict it to the required Responses endpoint/models where the provider supports these permissions. Enable a project monthly hard limit of no more than $50, earlier spend alerts and conservative model RPM/TPM settings. Keep it separate from development and other products. Disable automatic prepaid top-ups where applicable. Confirm this is public Standard pricing without regional/custom rates. OpenAI says hard-limit enforcement is not instantaneous; it is defense in depth, not the admission gate. [Official spend-limit guidance](https://developers.openai.com/api/docs/guides/spend-limits).
4. **Create a managed Turnstile widget** restricted to the exact beta hostname. Save its public site key and server secret separately. The app checks hostname, action `benchmark`, freshness and successful server-side verification. Configure no pre-clearance requirement. Tokens are single-use and expire after five minutes. [Server verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
5. **Configure the web service and secrets.** Use Node 24.15+, repository root as the source directory, build `npm --prefix beta ci --omit=dev --ignore-scripts`, start `node beta/server.mjs`. Fill the names in `beta/environment.example` in the secret manager. `PUBLIC_ORIGIN` must be the exact HTTPS origin, with no trailing slash. Keep `BETA_KILL_SWITCH=1`. Generate `IDENTITY_SECRET` once using a password manager or `node beta/operator.mjs generate-identity-secret`; store it securely, never in source control. Keep this secret identical across replicas and deployments. Do not print secret environment variables or enable HTTP body/authorization logging.
6. **Verify the ingress proxy trust boundary.** Set `TRUSTED_PROXY_CIDRS` to only the actual proxy peers guaranteed by the host. The proxy must overwrite or safely append `X-Forwarded-For`. Block direct access that bypasses it. Do not trust all addresses or an arbitrary number of hops. An empty value safely ignores forwarded headers but may group all visitors behind the host's proxy into one network quota. Confirm the host's actual routing before opening the beta; do not guess CIDRs. Use one canonical hostname, preserve its Host header, allow streaming responses for at least 180 seconds, and disable response buffering/retries on `/api/benchmark`. Configure host health checks with the same Host header at `/healthz`.
7. **Run migrations and initialize once** in a private operator shell with the same secrets as the service. From the repository root:

   ```sh
   node beta/operator.mjs migrate
   node beta/operator.mjs initialize
   node beta/operator.mjs status
   ```

   Migrations are transactional and idempotent. Initialization binds the ledger to its mode, identity secret and pricing hash, and leaves it paused. Repeated initialization is rejected. Later deployments run only `migrate`, never a reset. Prefer a separate migration/operator database role; the runtime needs SELECT/INSERT/UPDATE on the beta tables and usage on the audit sequence, with no permission to drop/truncate financial tables. Pruning also requires DELETE on event/throttle tables only.
8. **Recheck official prices and settings before activation.** The existing metadata was rechecked for this beta on 2026-10-18 without changing the frozen file. Verify it again on launch day. Print `node beta/operator.mjs pricing-hash`; set `PRICING_APPROVED_HASH` to that hash and `PRICING_APPROVED_UNTIL` to a UTC ISO timestamp no more than seven days ahead. Both expire closed. If rates or settings differ, leave paused and implement a separately reviewed beta-only change. Never edit the locked experiment to enable the service. [Pricing](https://developers.openai.com/api/docs/pricing), [cache-write calculation](https://developers.openai.com/api/docs/guides/prompt-caching).
9. **Verify staging without model spending.** Run the local demo/tests and confirm the production domain/TLS, Turnstile, proxy address handling, streaming and health checks while admissions remain paused. Do not use production keys with public fake-provider demos. Confirm the host does not log request bodies, cookie/authorization headers or exception objects. Check backup and restore procedures. Add the final privacy/contact copy appropriate to the operator before accepting customer content.
10. **After explicit owner approval, activate deliberately.** Set `BETA_KILL_SWITCH=0`, restart all replicas with identical configuration, then run `node beta/operator.mjs resume --reviewed-config`. Both switches must allow dispatch. A live smoke benchmark is a separate paid action; obtain approval and use one synthetic request. Keep daily status checks and a weekly pricing review. No automatic paid health check is included.

If using a private `.env.local`, Node can load it with `node --env-file=beta/.env.local beta/operator.mjs status` (and similarly for other commands). The file is ignored. Do not put secrets on a command line or in shell history.

## Optional Docker packaging

From the repository root:

```sh
docker build -f beta/Dockerfile -t ai-bill-doctor-beta .
```

The Docker-specific ignore file allowlists only runtime files. Experiments, outputs, keys, local databases and tests are excluded. The image runs as an unprivileged user. Supply secrets only at runtime. The image has no embedded Postgres; connect the managed database. Image build/deployment has not been tested here because Docker is not installed.

## Launch limits to understand

- The application enforces admission against conservative reservations, not a provider invoice. It assumes published rates and the bounded text request settings remain valid. Unknown usage, price tier, returned model or usage exceeding the bound stops the benchmark, holds the reservation and pauses further admissions where detectable. Silent provider price changes cannot be detected from token counts alone; the expiring price approval reduces that exposure.
- Use one dedicated provider project and one shared ledger. Spending outside this service, restoring an old ledger without reconciliation, an administrator editing budget rows, or a compromised host can defeat application accounting.
- A disconnect or timeout can still incur a provider charge. Uncertain runs occupy their reservation and slot until explicit recovery. Two unresolved runs pause effective capacity. This is intentional for a small beta.
- Neither a kill switch nor a provider cap can undo an already dispatched request. Maximum two active runs limits exposure; provider-side enforcement may lag.
- Provider identity/reasoning/pricing parsing reuses the approved engine. Tests establish accounting behavior with simulated responses; they do not certify live provider availability or answer quality.
