# Hosted beta staging validation

Date: 2026-10-18. **Launch decision: BLOCKED pending environment validation. Keep the beta paused.**

This is a validation plan for the reviewed implementation. No product, pricing, schema, frozen experiment or existing result files were changed. The only additions are this checklist and local staging tests. No hosting, OpenAI calls, commits or pushes were performed.

**Result: 211 tests passed, 0 failed/skipped/cancelled** in 69.3 seconds: 150 existing product/harness tests and 61 beta tests, including 11 added staging tests. All 143 snapshotted files are unchanged (including all 25 existing beta files and 103 existing output files); the `smb-v1` manifest fingerprint verifies. No production defect was exposed by these tests, so no implementation fix was made.

## Evidence and scope

- **PASS — local** means an automated assertion passed against an isolated real Postgres database and fake provider. It does not certify a hosting configuration.
- **BLOCKED — not run** is an unmet launch gate, not a passing test. Supply the missing environment evidence before release.
- **FAIL** means a tested requirement did not hold. Stop, preserve evidence and make only the smallest corrective change, then rerun affected tests and the full suite.

Local test commands, from the repository root with Node 24.15+ and dependencies installed:

```sh
node --test --test-concurrency=1 beta/tests/staging.test.mjs
node --test --test-concurrency=1 tests/*.test.mjs internal/benchmark/harness.test.mjs internal/batch/batch.test.mjs internal/diagnostics/connectivity.test.mjs internal/review/review.test.mjs beta/tests/*.test.mjs
```

The new tests create their own database, use separate worker processes and bind HTTP listeners to loopback. They accept only a synthetic model credential. External fetch is disabled; the timeout test redirects the provider adapter to a local HTTP sink. Teardown kills admissions and workers before deleting its own temporary database. No existing database or experiment is reset.

Evidence files after this run:

- `outputs/ai-bill-doctor-staging-validation-2026-10-18.json`: machine-readable results and preservation checks.
- `outputs/ai-bill-doctor-staging-tests-2026-10-18.txt`: complete test result inventory.
- `beta/tests/staging.test.mjs` and `beta/tests/fixtures/staging-worker.mjs`: added tests.
- `beta/tests/beta.test.mjs`: existing races, outages, ambiguous commits, quota, pricing and request-validation tests, rerun unchanged.

## Launch gates

Each row requires its local assertions **and** the named environment evidence. All environment checks below are currently blocked: no private staging hostname, real widget configuration, managed database or Docker runtime is available in this workspace. Provider account settings and host log configuration have not been inspected.

| ID | Requirement and explicit pass condition | Evidence obtained | Remaining launch evidence / current gate |
|---|---|---|---|
| P1 | Durable atomic admission: four separate processes with $0.25 headroom admit exactly one $0.25 reservation; no partial writes | **PASS — local** for both $5 daily and $50 lifetime boundaries; `fsync`, `synchronous_commit`, `full_page_writes` are on | **BLOCKED**: repeat on a disposable database on the chosen managed Postgres service; save version, durability settings, final counters and assertion results |
| P2 | Shared limits: at most two active reservations; duplicate submissions reserve once; quota permits three admissions, including failed runs | **PASS — local**: separate-process concurrency test plus unchanged duplicate/quota race tests | **BLOCKED**: demonstrate two staging workers share the same database and identity configuration across a restart; third reservation rejected, duplicate not replayed |
| P3 | Database outage/uncertain commit cannot dispatch or refund; restart preserves holds and replay protection | **PASS — local**: actual Postgres stop/restart and injected commit-acknowledgement failures in existing tests | **BLOCKED**: disconnect the staging database; zero subsequent model dispatches, existing holds retained after reconnect. Verify runtime permissions and durable storage/backups |
| H1 | Canonical Host accepted; wrong Host rejected; forwarding headers cannot override Host | **PASS — local**: real TCP proxy fixture gets HTTP 403 for wrong Host; forged forwarding fields do not alter origin checks | **BLOCKED**: record canonical HTTPS origin, actual proxy peers/CIDRs and matching health-check Host; repeat through real ingress |
| H2 | Spoofed XFF cannot rotate the network quota; direct backend bypass is blocked | **PASS — local**: four fresh browser identities with forged XFF produce three admissions then HTTP 429; saved IP hashes match the socket-derived client. Existing tests cover untrusted peers, chains and IPv6 /64 | **BLOCKED**: repeat on actual ingress; prove proxy overwrites or safely appends client IP and backend is unreachable except through trusted ingress |
| T1 | A fresh real widget token for exact hostname and action `benchmark` passes server verification | **PASS — local** validation logic with synthetic Siteverify responses only | **BLOCKED**: one real widget/Siteverify success on private HTTPS staging, followed only by fake model calls |
| T2 | Wrong hostname/action, expired token, reused token and Siteverify failure cannot admit a benchmark | **PASS — local** hostname/action/age/error checks; no local claim about Cloudflare single use | **BLOCKED**: perform all real-token checks below, record safe status/reason and zero admission/dispatch deltas for each rejection |
| K1 | Operator kill reaches an active worker and prevents any next provider call | **PASS — local**: actual operator CLI kills while first fake call waits; worker aborts, one attempt only, full uncertain reservation held; new admission rejected | **BLOCKED**: repeat across staging workers and the real proxy; record stop latency, one attempt and retained reservation |
| K2 | Both environment and database switches must allow; default and final state are paused | **PASS — local**: paused initialization, failed resume with environment switch on, teardown verifies database killed | **BLOCKED**: save staging `status` with `killed: true` and deployment setting `BETA_KILL_SWITCH=1`; verify rejected benchmark and zero fake calls |
| R1 | Worker termination and timeouts cannot free an uncertain charge or retry | **PASS — local**: SIGKILL/SIGTERM after dispatch preserve running hold; actual 45-second provider timeout preserves full uncertain hold, one attempt | **BLOCKED**: terminate an actual container/host worker during a fake call; record host grace period and restart behavior. Local signal tests target a test worker, not the production server's shutdown handler |
| R2 | Recovery frees only capacity, never uncertain money; paused/all-workers-stopped/age checks enforced | **PASS — local**: actual operator commands reject premature or unacknowledged close; accepted close retains full reservation and adds audit record | **BLOCKED**: stop every staging worker and wait a real ten minutes before close. Local tests advance only their isolated row timestamp; they do not prove an operator waited |
| D1 | Docker image builds, contains only allowed runtime files, runs unprivileged and starts paused | Existing Docker allowlist inspected; **no build result** | **BLOCKED**: Docker unavailable. Capture build result/image digest, container user, runtime file inventory and paused startup/health evidence |
| O1 | Dedicated provider project, restricted server credential and provider spending controls configured | Official instructions checked; **no account configuration verified** | **BLOCKED**: owner supplies redacted settings evidence as below. Do not install a usable OpenAI key in fake staging |
| L1 | Prompts, outputs, cookies and server secrets absent from app logs, analytics and ledger content | **PASS — local**: synthetic canaries absent from captured stdout/stderr, fixture proxy logs, analytics, run and call rows on both success and hostile error paths; fixed public error response | **BLOCKED**: repeat against actual container stdout, ingress/CDN/access logs, database logs and any APM/log drains; a local fixture is not infrastructure-log proof |
| F1 | Frozen source, experiment fingerprint and all pre-existing results remain unchanged | SHA-256 preservation checks and existing harness verification recorded in evidence JSON | Release requires passing preservation check after every corrective change; never run staging tests against `smb-v1` records |

## Smallest staging sequence

### 1. Prepare one private environment, paused

Use one web service, one isolated Postgres database and the actual intended proxy/TLS configuration. Restrict ingress to reviewers using the host's network controls. Temporarily use two workers only for shared-accounting and kill-switch checks. Keep experiments and beta production accounting entirely separate.

Start with `BETA_KILL_SWITCH=1` and a newly initialized staging ledger, whose database kill flag is also true. Run the existing migration, initialization and status commands from `DEPLOYMENT.md`. Never initialize or reset an existing production ledger.

For model calls, use the existing `webServer({ config, ledger, provider: fakeProvider() })` injection in a private test launcher. Keep live-mode security and the **real default Turnstile verifier**. Do not use `demo.mjs` or the new local worker fixture as real Turnstile evidence: the former is demo mode and the latter deliberately stubs verification. Supply only a clearly synthetic OpenAI placeholder for configuration validation. Block OpenAI egress at the host; allow only the database and Cloudflare Siteverify as needed. Mount any test launcher separately from the unchanged production image; record that override in evidence.

For each active test window, confirm fake-provider injection and egress denial first, temporarily permit the isolated staging environment and database, execute the finite test, then kill again. Leave the environment paused between sessions and at the end. No paid model smoke test is part of this plan.

### 2. Build and start the image

```sh
docker build -f beta/Dockerfile -t ai-bill-doctor-beta:staging .
docker image inspect ai-bill-doctor-beta:staging --format '{{.Id}} {{.Config.User}}'
```

Supply configuration through the host secret manager at runtime; no build arguments containing secrets. First start the unchanged entrypoint with both kill switches on and synthetic model credentials. Verify `/healthz` returns 200 with the canonical Host, the existing browser flow loads, and benchmark admission is refused with zero provider attempts. Then use the mounted fake-provider launcher for active staging tests. Check streaming is not buffered, no proxy retries occur, and proxy timeouts allow the app's 150-second run deadline. Inspect the image filesystem without dumping environment values: no `.env`, experiment records, outputs, test databases or credentials; process user `node`.

### 3. Exercise the shared database and ingress

Repeat P1–P3 using disposable test databases on the same managed service, with the same runtime role and migration version as staging. Boundary test setup may seed counters **only in those disposable databases**. Save counters and admission counts; no customer content is needed. The existing local test command always creates a local cluster and does not certify a remote database.

Through actual HTTPS ingress, test canonical and wrong Host; XFF containing a forged single IP, comma-separated spoofed chain, malformed IP and overlong header; conflicting `Forwarded` and `X-Forwarded-Host`. A hostile client header must not determine network identity. An ingress that replaces malformed headers can safely accept the request; the requirement is correct client identity and unchanged quota. Verify direct backend access is blocked. Use fresh signed sessions from the same client network for the fourth-admission check so it tests network quota, not just the cookie quota.

### 4. Verify real Turnstile behavior

Use a real staging widget restricted to reviewer-controlled HTTPS hostnames. Tokens stay in transient browser/server memory: never place tokens or the secret key in evidence or command history. Record only time, expected check, safe HTTP/error category and admission/dispatch deltas.

1. Fresh token, correct hostname, action `benchmark`: one benchmark admitted, fake calls only.
2. Reuse that consumed token with a **new submission UUID**: HTTP 403 `verification`, zero admissions/calls. Reusing the UUID would test idempotency instead of token reuse.
3. Generate a fresh unused token, wait more than 300 seconds, submit that original token: same rejection. Do not allow automatic widget refresh to substitute a new token.
4. Issue a token with a different action using an isolated test page: reject. Do not change the product page.
5. Issue a token from a second reviewer-controlled hostname temporarily allowed by the staging widget, then submit to the canonical backend: reject on hostname. Remove the extra hostname afterward.
6. Block Siteverify egress temporarily: fail closed, zero model attempts, no automatic retry. Restore the rule while the beta remains paused.

Cloudflare documents 300-second expiry, single-use validation and `timeout-or-duplicate` for reused/expired tokens. The app additionally checks exact hostname/action. Dummy testing keys cannot establish these real-widget properties. [Official Siteverify documentation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

### 5. Exercise shutdown and recovery

Use a fake provider that can wait without returning. During its first dispatched call, run the existing operator `kill` command from a separate process. Record that no candidate call follows, the browser gets a safe failure and the reservation remains fully accounted. Repeat with a host/container termination and a provider timeout. Disconnect the database during a call and check that recovery does not retry or release the hold.

For recovery, kill admissions, set the environment switch to `1`, stop **all** workers and wait at least ten minutes since the last run update. Run:

```sh
node beta/operator.mjs status
node beta/operator.mjs close-uncertain RUN_UUID --all-workers-stopped
node beta/operator.mjs status
```

Pass only if full reserved dollars stay consumed, capacity is freed, an audit entry exists and the old submission cannot run again. Never refund based on elapsed time. Record actual host shutdown behavior: the production entrypoint allows up to five seconds before exit. Calls already dispatched may still incur a charge; kill-switch polling is approximately once per second plus database/network latency, not an instantaneous cancellation guarantee.

### 6. Check provider controls and all log destinations

The owner must inspect the dedicated OpenAI project in the dashboard without making model calls. Record only project identifier, credential identifier/permissions (never its value), hard-limit setting, alerts and date. Verify a server-only project credential, the needed endpoint/model access, conservative RPM/TPM limits, no unrelated workloads, and a monthly hard limit no higher than $50 with earlier alerts. Disable automatic credit top-ups if applicable. Keep the real key out of fake staging and put it in production secrets only after separate activation approval.

A notification-only budget is not a hard limit. Current documentation describes the project setting **Enforce a hard limit** and warns that enforcement can lag. The provider monthly cap does not replace this application's $5/day and cumulative $50 ledger limits. If the account cannot enable the intended control, leave this gate blocked for explicit review. No credential validity or live model-access claim can be made from dashboard inspection alone. [Official spend-limit configuration](https://developers.openai.com/api/docs/guides/spend-limits).

Submit unique synthetic prompt, output and secret canaries on success, validation failure, provider error, timeout and worker termination paths. Search every actual destination: container stdout/stderr, edge/proxy/CDN/access and error logs, database query/error/audit logs, exception reporting, APM and log drains. Check build logs/image history separately. Verify request/response bodies, cookie/authorization headers, environment dumps and SQL parameter logging are disabled. Store only destination names, time ranges, tested paths and zero-match counts; do not paste raw logs containing real secrets. Record any infrastructure IP/access-log retention separately. Missing access to a log destination leaves L1 blocked.

### 7. Close the review window

Run `node beta/operator.mjs kill`, set `BETA_KILL_SWITCH=1`, stop test workers and verify final status with full uncertain holds intact. Preserve redacted evidence. Run the full regression suite and fingerprint checks after any test-driven fix. Public deployment, real provider calls, committing and pushing each remain outside this work.

## Evidence to fill in during private staging

For every blocked gate, record: `gate ID | PASS/FAIL | UTC time | image/source digest | environment | exact probe | expected result | observed result | redacted evidence location | reviewer`.

Do not mark a gate PASS from a configuration intention, a fake Siteverify response, a local proxy fixture or a code review alone. Release remains blocked until the required environment evidence is attached and the owner separately approves launch.
