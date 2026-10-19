# Beta operator guide

Run these commands in a private operator shell with server configuration injected by the host. From the repository root, use `node beta/operator.mjs COMMAND`. They never call OpenAI. There are no public operator routes.

## Status and budget accounting

```sh
node beta/operator.mjs status
node beta/operator.mjs analytics
```

Status shows the global kill flag, today's UTC day, daily/lifetime accounted dollars and active run IDs/states. Accounted dollars include measured known charges **plus full unresolved reservations**. They are not an exact provider invoice. A previous day's unresolved reservation is carried into today's admission calculation; midnight never frees it. Admission counts every accepted benchmark, including those that fail or are cancelled.

`analytics` gives daily event counts only. Landing/pricing events deduplicate per daily pseudonymous visitor; candidate events deduplicate per visitor/run/candidate/action. A founder can reject and later revisit/accept the same candidate, so both actions may appear. These are funnel signals, not independent quality-evaluation statistics.

### How accounting works

1. Validate JSON/model/size/settings, signed visitor, CSRF, same origin, IP throttle and Turnstile.
2. Lock the single `beta_control` row on a dedicated Postgres transaction connection. Verify config and kill flags, unique submission ID, visitor/network quota, two-run limit and $5/$50 budgets. Add the entire conservative plan reservation and planned calls; commit.
3. Before each of at most three sequential calls, lock/check again and persist `dispatched`; commit must be acknowledged before network dispatch. An ambiguous commit blocks the call. No model call occurs inside the database transaction.
4. Record verified usage-derived cost as `known`. Persist settlement before returning final results. Release only the unspent portion of a wholly known attempt; unstarted calls are safe to release. Incomplete outputs with valid usage have known cost but cannot support a recommendation.
5. On timeout, network loss, worker death, ambiguous usage checkpoint or unknown pricing, retain the whole reservation. There is no expiring lease, automatic refund, background retry or worker takeover. The active slot remains held.

All mutations use the same control-row lock, so overlapping deployments use the same limits. The maximum reservation is $0.25; daily $5; lifetime $50. These constants are in `policy.mjs`, not browser configuration or freely adjustable environment variables. Money is rounded upward to nano-dollars. Dispatch refuses an expired run or one admitted on a different UTC day. A known call that crosses midnight is conservatively charged to both days, but only once to lifetime spending.

Postgres must provide durable commits. Transactions have bounded connection/lock/statement timeouts. Database failure blocks admissions and subsequent dispatch, and the watchdog aborts in-flight work. No accounting error falls back to process memory. [Postgres row locking](https://www.postgresql.org/docs/current/explicit-locking.html), [node-postgres transaction requirements](https://node-postgres.com/features/transactions).

## Emergency shutdown

```sh
node beta/operator.mjs kill
```

This changes the shared database flag immediately. Workers check it before dispatch and approximately every second while waiting on the provider. Calls already sent may still be billed. Set `BETA_KILL_SWITCH=1` in the host as a second barrier and stop all web replicas. If database access is down, stop replicas and revoke/disable the dedicated OpenAI project key. Do not rely on environment propagation alone for an immediate stop.

Automatic pauses occur on detected unsupported pricing/usage/settings, model-access problems, billing/rate limits or an exceeded call bound. All provider errors stop the current benchmark with zero retries. Ordinary timeouts/disconnects retain their slot/reservation; they do not automatically reset or resume.

## Recover a held run

1. Kill admissions and stop **every** old web worker/replica, including rolling deployments. Resolve the incident. Check the dedicated provider project's usage/billing separately; no automatic provider reconciliation is performed.
2. Run `status` to identify held runs. A run remains held even if its owner disappeared. Wait at least ten minutes after its last recorded change; the command enforces this minimum, but elapsed time alone is not evidence that a worker has stopped.
3. For each affected run, deliberately retire it:

   ```sh
   node beta/operator.mjs close-uncertain RUN_UUID --all-workers-stopped
   ```

   The command requires the shared kill flag, an aged unsettled run and explicit certification that all workers stopped. It charges the **full original reservation as consumed**, frees only the concurrency slot and records an operator audit entry. It never refunds unknown charges. It cannot resurrect or retry the old run. Do not use it while any old worker can still send a request.
4. Confirm retained dollars and empty active slots with `status`. Correct secrets/proxy/provider settings, reverify pricing if required, restart workers and then `resume --reviewed-config` with `BETA_KILL_SWITCH=0`. Existing budgets, quotas and idempotency records are preserved.

There is deliberately no refund, reset, replay or edit-cost command. If the conservative hold consumes budget unnecessarily, accept the lost allowance for this beta. If measured provider cost exceeds the retained reservation, stay paused; investigate and reconcile conservatively in a separately reviewed change before resuming.

## Database loss and deployments

- A routine restart retains all records. Running `migrate` again checks the migration hash and does not reset anything. Changing the identity secret or pricing hash fails closed against the bound database configuration.
- Use the same durable database for all production workers. Keep staging/demo separate. Never initialize a replacement empty production ledger to bypass a limit.
- If the ledger is lost, incomplete or restored from an old backup, **keep the beta off**. Stop all workers, reconcile the missing interval against provider records and conservatively account for every uncertain charge before any separately reviewed recovery. If this cannot be established, end the beta. No automatic reset or backup rollback is safe for spending limits.
- Deploy paused when changing accounting code or configuration. Wait for known work to finish, handle remaining holds, deploy, verify `status`, then resume explicitly. Avoid changing the stable identity secret while live; rotation requires a reviewed migration that preserves quotas and replay protection.

## Privacy and routine maintenance

```sh
node beta/operator.mjs prune
```

Run weekly via a private host scheduler or manually. This removes events older than 30 UTC days and throttle buckets older than seven days. Financial/run/call records and operator audit history are retained through the beta to preserve budget and replay guarantees. Backup retention must be configured at the host. Shut down and archive/delete the beta database deliberately after the project ends, with no later reuse as a fresh spending allowance.

Do not enable request body, header, exception-object or SQL-parameter logs. Never log secrets. Web errors use fixed messages; API keys, Turnstile secret, identity secret and database URL are scrubbed if echoed in an output. Prompts/outputs are not stored in the ledger. OpenAI receives content for live calls; provider retention settings still apply. Reverse proxies and infrastructure can retain IP/access logs independently; configure them with short retention and no body/header capture.

A single founder can operate this beta with daily status/provider-bill checks and a weekly price review. At $50 lifetime accounting, admissions stop permanently unless a new budget is explicitly reviewed; a new month does not reset it.
