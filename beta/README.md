# AI Bill Doctor — anonymous beta

The approved request → comparison → human decision → savings flow, served by a small Node service with Postgres spending controls. No signup, customer API key or payment. All new beta files live here; the frozen app sources and `smb-v1` records remain unchanged.

## Try locally without paid calls

Use Node 24.15 or newer and npm. From the repository root:

```sh
npm --prefix beta ci
npm --prefix beta run demo
```

Open **http://127.0.0.1:5174**. Load the sample, run it, review the first output, accept/reject, enter a monthly bill and see the savings estimate. The demo labels all simulated outputs and costs. It uses an isolated local Postgres and ignores live API/database environment variables. No OpenAI or Turnstile request is made.

The development-only Postgres package includes native binaries. Allow its installation script to restore library symlinks. Run as an ordinary user. No separate database installation is needed. Production installs omit this dependency.

Demo accounting persists under the ignored `.cache/beta-demo/` folder, including the three-admission daily limit. Restarting does not reset it. For more automated runs, use the test suite, which creates and removes its own isolated database. `DEMO_PORT=5175 npm --prefix beta run demo` changes the demo web port.

## Tests

```sh
npm --prefix beta test
node --test tests/*.test.mjs internal/benchmark/harness.test.mjs internal/batch/batch.test.mjs internal/diagnostics/connectivity.test.mjs internal/review/review.test.mjs
```

The beta suite uses **real local Postgres transactions and fake providers**. External fetch is disabled. It covers multi-worker admission races, daily/lifetime ceilings, idempotency, quotas, crashes, timeouts, database restart, kill switches, privacy and the human review flow. It never touches `smb-v1` records. See [TESTING.md](TESTING.md) for the recorded verification and boundaries.

## Production shape

One Node 24 web service, one persistent Postgres 15+ database, a Turnstile widget and a dedicated OpenAI project. No queue, Redis, background runner, accounts, SDK, gateway or payment system. Requests execute sequential model calls within the admitted HTTP request. Across all workers, Postgres allows at most two active benchmarks.

| Guardrail | Limit |
|---|---:|
| Conservative reservation per benchmark | $0.25 maximum |
| Global budget per UTC day | $5 |
| Cumulative beta budget, across deployments | $50 |
| Active benchmarks, including uncertain holds | 2 |
| Admitted benchmarks per signed anonymous visitor/day | 3 |
| Additional network/day backstop | 3 |
| API requests per network/minute | 30 |
| Automatic model retries | 0 |

Money uses integer nano-dollars. The server computes plans from the frozen model settings; clients cannot set prices, caps, models outside the ladder or arbitrary provider URLs. Each model gets the same instructions, request, medium reasoning and 2,048 total output-token limit. Astra → Sol → Luna review order is preserved. An incomplete answer never supports a savings recommendation.

## Privacy and analytics

Prompts and outputs exist in browser/server memory during a request and are sent to OpenAI when live. They are not written to our database or application logs. Provider retention still applies; `store:false` does not mean zero provider retention. Refreshing loses results. Only the submission UUID is in session storage; the visitor identity is a signed HttpOnly cookie.

Persistent accounting stores run IDs, keyed visitor/network/request hashes, model IDs, call states and costs. Analytics stores only daily pseudonymous visitor IDs, seven event names and optional run/candidate references. No content, email, raw IP, browser fingerprint, monthly bill, credential or provider error body is stored in analytics. The $29/month button records interest only; it collects no payment or contact details.

Signed cookies and a network backstop reduce abuse; an anonymous service cannot identify one person across different devices, networks and cleared cookies. Shared networks can hit the same limit. Global budgets remain the final control. Host/proxy access logs have their own retention and must be configured separately.

## Files and operations

- [Environment template](environment.example)
- [Deployment instructions and remaining setup](DEPLOYMENT.md)
- [Budget, shutdown and recovery guide](OPERATIONS.md)
- [Database schema](migrations/001_accounting.sql)
- [Verification record](TESTING.md)

Live mode starts paused. Deployment, activation and a paid smoke test require review; none are performed by the demo, migrations or tests.
