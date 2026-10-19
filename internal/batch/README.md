# One controlled batch: smb-v1, Cases 02–12

This standalone orchestrator calls the existing `executeCase` and `observedProvider` functions. It leaves the locked source files, fixtures, rubrics, model settings, pricing and customer-facing product unchanged. It never initializes an experiment or runs Case 01.

## Verified plan

- Existing fingerprint: `a23797b9ab0c372ce014b64a0eda22c1751da4726f129486f4ef9f2e6dcfdd70`.
- Cases 02–12, in fixture order, one case and one provider call at a time.
- **Exact conservative reservation: $1.448278.** This sums the existing per-case plans, each already rounded upward to a whole microdollar.
- **Batch ceiling: $1.50. Per-case ceiling: $0.25. Maximum calls: 30. Retries: zero.**
- The frozen engine still chooses each call's model, request, reasoning, output cap and pricing. Each case uses its original plan, including the two-call or three-call limit.
- Case 01 and the standalone connectivity diagnostic are outside these new batch totals. Case 01's original uncertain charge is preserved; it is not reclassified as free.

## Commands and approval

Use Node 20 or later from the project directory. Preview is read-only and makes no API calls:

```sh
node internal/batch/cli.mjs plan
```

Before live execution, explicitly approve **one batch of Cases 02–12 with a $1.50 total ceiling and a $1.448278 conservative reservation**. The earlier one-call connectivity approval does not authorize this batch.

After that approval, run exactly once in a local interactive terminal:

```sh
node internal/batch/cli.mjs run --paid --approve 1.50
```

The command displays the verified total before prompting for a key. The explicit command flags authorize the batch; there is no second typed confirmation phrase. Enter the API key only at the hidden prompt. The key is requested once, stays in process memory, and is sent only to the existing OpenAI provider. It is never accepted through an argument, environment variable or file. Do not paste the key into chat. Ctrl-C/Ctrl-D cancels hidden entry. JavaScript cannot guarantee secure erasure of memory after references are cleared.

Run only this batch process: do not start separate provider traffic or the legacy per-case CLI concurrently. Claiming the case directories blocks duplicate execution through the legacy CLI, but this local orchestrator cannot cap unrelated traffic on the API account.

Execution prints only case IDs and neutral progress, followed by an aggregate report. It does not print outputs, model identities, per-candidate costs, savings or rubric content. The report includes completed cases, inconclusive cases, unstarted cases, API attempts, full case reservations and known measured spending. “Completed” means every planned output is complete; it is not a quality judgment. Refusals or missing outputs appear in the inconclusive case list for this execution report; their detailed runner statuses remain unchanged.

Human replacement review and rubric grading are separate, manual steps using the existing benchmark CLI. This command creates neither `human.json` nor `rubric.json`.

## Spending and preservation

1. Verify the existing manifest with `verifyManifest`, the pinned fingerprint and the existing Case 01 record. Refuse any existing directory for Cases 02–12; never skip, reset or overwrite a prior attempt.
2. Acquire the batch's permanent single-use directory with exclusive `mkdir`. A concurrent or repeated batch cannot acquire it.
3. Persist the authorization receipt, then exclusively claim every remaining case directory before any paid calls. An interrupted preparation leaves its claims intact and blocks another run.
4. Before each case, persist its **entire** conservative reservation. Add reservations using integer microdollars and reject any total above $1.50 or case above $0.25. Never release a reservation after a failure, short response or unused candidate allowance.
5. The original runner saves its normal write-ahead checkpoint. Before each provider invocation, persist a separate dispatch marker. Recheck the manifest, Case 01 hashes, prior result hashes, receipt hashes, reservation sum, expected call order and exact frozen input before dispatch.
6. Store the runner's sanitized record in the existing case directory as `result.json`, with its unchanged schema. Checkpoints use temporary files, atomic replacement and `fsync`. New journal receipts use exclusive creation; none is overwritten. Files are private to the local user.

Accounting is stored in ignored local directories:

```text
outputs/internal-benchmark/smb-v1/<case-id>/result.json
outputs/internal-batch/smb-v1-cases-02-12/
  authorization.json
  claimed.json
  reserve-<case-number>.json
  dispatch-<case-number>-<call-index>.json
  record-<case-number>.json
  finish.json
```

The first directory retains the standard benchmark results. The second is spending and recovery evidence, not benchmark metrics. Existing files and hashes are never amended to enroll the orchestrator in the locked experiment.

## Stop conditions

Any provider exception stops the batch, including rate limits, billing/access errors, timeouts and transport failures. Unknown usage/pricing, changed settings, unclassified incomplete responses, costs above a reservation, changed locks/files, journal/checkpoint failures and cancellation also stop further calls. No exception text, credentials or raw response is printed.

A confirmed output-budget exhaustion with valid usage/cost remains `inconclusive_output_budget`. The engine may finish the remaining candidates when its existing rules permit, then continue to later cases within their full reservations. A baseline output limit still stops that case's candidates. Priced refusals retain the runner's existing status and may allow later cases. Neither outcome is changed to a pass.

Some frozen-engine candidate errors normally allow a later candidate. Once the batch detects an unsafe result, it refuses that later candidate's write-ahead checkpoint **before saving another attempted call or dispatching it**. This leaves the last truthful runner snapshot, sometimes with `state: running`, instead of fabricating a finished record or a paid attempt. The batch report identifies the stop. The existing human-review CLI may refuse that unfinished case; leave it inconclusive and review complete cases separately.

Ctrl-C/SIGTERM during execution aborts the active request and stops the batch. A client timeout or abort does not guarantee provider cancellation or a zero charge. Unknown charges remain unknown, with the full reservation retained.

## Crash recovery: inspect, never automatically resume

```sh
node internal/batch/cli.mjs status
```

This command is read-only and makes no API calls. After a crash it reconstructs the saved reservations, dispatch markers and standard runner records. Missing/corrupt accounting is flagged; unverified totals become `null`, not zero. A surviving in-flight checkpoint makes charges uncertain. Dispatch markers are written before provider invocation, so after an interruption the reported attempt count can be an upper bound rather than proof that every request reached OpenAI.

**There is no resume/reset command.** Re-running `run` fails before requesting another provider call. Keep every batch receipt, case directory and checkpoint, including empty claimed directories or leftover temporary files. Do not delete them to make a rerun possible. Continuing any unstarted cases after a stopped/interrupted batch requires inspection and a separately reviewed, explicitly authorized recovery procedure. This protects the one-attempt rule even when a crash occurs just before or after a network request.

These controls govern this local process using the frozen conservative estimates. They do not establish an instantaneous provider-side account spending limit or prevent unrelated API usage.

## Mock tests

```sh
node --test internal/batch/batch.test.mjs
node --test tests/*.test.mjs internal/benchmark/harness.test.mjs internal/diagnostics/connectivity.test.mjs internal/batch/batch.test.mjs
```

The batch tests use isolated temporary copies of experiment metadata and synthetic provider responses. They never mutate the real `smb-v1` directory or make paid calls. They cover exact reservations, explicit approval, sequential execution, stop conditions, write failures, concurrent starts, secret redaction, result preservation, and forced process crashes at reservation, in-flight and between-case boundaries.
