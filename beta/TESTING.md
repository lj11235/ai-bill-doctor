# Local verification

Verified on 2026-10-18 using Node 24.19.0, temporary local Postgres 18.4 and fake model/Turnstile responses. No paid API calls, deployment, commit or push.

## Automated suites

**200 tests passed; 0 failed, skipped or cancelled.** This includes 50 beta tests and all 150 existing product, experiment harness, controlled batch, connectivity diagnostic and review-import tests.

```sh
node --test --test-concurrency=1 tests/*.test.mjs internal/benchmark/harness.test.mjs internal/batch/batch.test.mjs internal/diagnostics/connectivity.test.mjs internal/review/review.test.mjs beta/tests/*.test.mjs
```

The beta tests use a real Postgres cluster with concurrent transactions, not an in-memory database imitation. External fetch is disabled. HTTP tests reach localhost only. Each test cluster is isolated and removed at teardown.

| Area | Verified behavior |
|---|---|
| Daily/lifetime budget races | Ten simultaneous attempts with one reservation of headroom admit exactly one |
| Shared concurrency | Twelve attempts admit exactly two; uncertain holds still occupy capacity |
| Per-benchmark ceiling | Above $0.25 rejected; failed insert rolls back the entire admission |
| Duplicate submissions | Eight racing submissions reserve once; changed identity/body conflicts; replay after settlement remains blocked |
| Visitor/network quota | Three admitted runs exhaust quota even if stopped at zero cost; changing browser identity on the same network does not bypass it |
| IP trust/throttle | Forged forwarding headers ignored unless peer is trusted; broad `/0` trust rejected; IPv6 addresses grouped by /64; 30/minute atomic throttle |
| Known settlement | Actual sample costs retained; simultaneous settlement cannot double refund |
| Ambiguous commits | Reservation acknowledgement loss dispatches nothing; usage/settlement acknowledgement loss cannot release unknown charges twice |
| Crashes | Separate child worker exits after durable dispatch; replacement worker cannot replay or release that run |
| Timeouts/disconnects | One attempt, no retry, full reservation retained |
| Database outage | Stopping/restarting Postgres blocks operations and preserves accounting; watchdog failure aborts an active simulated call |
| Kill switch | Stops the next call and aborts a provider wait; manual close requires pause and an aged run |
| Pricing/settings changes | Wrong cost, excess usage, invalid counts, unsupported pricing/settings and missing usage stop and retain reservations; live approval expires closed |
| UTC rollover | Old active reservations consume today's headroom; yesterday's run cannot dispatch new calls |
| Browser/API privacy | No user API-key field; credentials redacted from output/errors; private files unserved; analytics reject prompts/unknown fields and fabricated server events |
| Model/human review | Astra → Sol → Luna and Sol → Luna order; identical reasoning/settings; incomplete samples excluded; accept/reject gates savings |
| Turnstile | Server validates success, hostname, action, age and size; network error does not retry |

## Browser verification

Headless Chrome exercised the actual local demo at **1360 × 960** and **390 × 844**:

- Landing → load sample → input → analysis progress → comparison → accept → estimated monthly/yearly savings → pricing-interest CTA.
- Phone run also rejected Sol and reviewed Luna before accepting.
- Exactly one benchmark request per flow; no browser errors or horizontal overflow.
- No password/API-key input; analytics payloads contained no request/output content.
- External page requests were blocked. No live Turnstile challenge or model API was contacted.

## Frozen evidence

All **50 snapshotted locked source/record files** are byte-for-byte unchanged. The existing harness verifies this experiment fingerprint:

```text
a23797b9ab0c372ce014b64a0eda22c1751da4726f129486f4ef9f2e6dcfdd70
```

No fixture, ground truth, rubric, review decision, recorded response or pricing source was edited. New beta code reuses the frozen request/pricing modules and lives outside the locked source set.

## Remaining verification before launch

- Hosted HTTPS/proxy routing, the real Turnstile widget and production secret configuration.
- Managed Postgres permissions, durable commits, backups and incident recovery.
- Docker image build, if choosing Docker; Docker was unavailable locally.
- One explicitly authorized paid smoke test after review. Mock tests establish accounting behavior, not live model access, latency or answer quality.
- Published pricing/settings on launch day, plus provider project spending controls. A provider invoice can include delayed or unexpected charges; application reservations cannot enforce a provider-side instantaneous billing stop.
