# Offline batch rubric review

This standalone tool reads the locked experiment and calls the existing harness's `grade` and `verifyReview` functions. It does not change the frozen CLI, definitions, rubrics, scoring rules, outputs, human decisions, settings or pricing. No dependencies or API calls. Nothing is uploaded by this tool.

## Current grading state

At inspection on 2026-10-18, Cases 02–06 had complete exact-JSON grading records. Cases 07–12 had no rubric records or persisted partial grades. The frozen interactive CLI keeps criterion answers in memory and writes `rubric.json` only after completing a whole case; interrupted answers before that write are not recoverable from the experiment. Existing records are preserved.

## Commands

Run from the project root with Node 20+:

```sh
node internal/review/cli.mjs status smb-v1
node internal/review/cli.mjs export smb-v1 outputs/review/smb-v1-manual-rubric-review.json
```

Export creates a new file and refuses to overwrite one. Use another filename when exporting again. The JSON contains all six manual cases, their system instructions and requests, recorded outputs with stable output identifiers, and the exact criterion ID, severity and text for every complete output. Current data has 16 complete outputs and 98 criterion judgments to fill. It excludes model identities, usage, pricing, human yes/no decisions, and provider metadata. The opaque `sourceHash` binds each case to its saved result, human decisions and rubric without disclosing those records.

Give this JSON to an external reviewer. Save their completed copy as `outputs/review/smb-v1-manual-rubric-reviewed.json`. **Change only each criterion's `result` and `evidence`.** Every complete output, including the baseline, is graded independently against every precommitted criterion. Human replacement decisions do not determine rubric grades. The tool does not make any judgments itself.

Each criterion lives at `cases[].outputs[].criteria[]`; the parent output has `outputId`, `label`, `status` and verbatim `text`. For example, the editable portion is:

```json
{
  "result": "inconclusive",
  "evidence": "The output does not resolve the uncertainty required by this criterion."
}
```

Use `pass`, `fail` or `inconclusive` plus nonblank evidence. Keep IDs, severity, criterion text, instructions, output text, source hashes and all other fields unchanged. Already locked manual grades are exported with their original verdicts and evidence filled in; preserve them exactly. Technical-inconclusive outputs have no editable criteria and keep the harness's existing treatment.

Validate without writing, then import when the review is ready:

```sh
node internal/review/cli.mjs import smb-v1 outputs/review/smb-v1-manual-rubric-reviewed.json --check
node internal/review/cli.mjs import smb-v1 outputs/review/smb-v1-manual-rubric-reviewed.json
node internal/review/cli.mjs status smb-v1
```

These commands never show model identities or costs. If `node` is not on PATH, replace it with the installed Node executable. No install/build step is needed.

## Validation and recovery

- The entire six-case packet must be complete and valid before writing any grades. Missing, duplicate, unknown or invalid cases, outputs, criteria, verdicts or evidence are rejected. Repeated JSON object keys and unknown fields are also rejected. JSON files are limited to 5 MiB.
- The experiment fingerprint, saved human decisions, outputs and any existing rubric records are validated with the frozen harness. Changed instructions, output text, criterion wording/severity or source bindings are rejected.
- Scoring remains the existing strict/acceptable methodology. Import writes the normal `rubric.json` format, including every criterion's severity, verdict and evidence, and hashes of the result, human decisions and rubric. It invents no baseline human decisions.
- Matching locked grading is explicitly reported as preserved and never rewritten. Conflicting grading rejects the batch before writes. This includes changes to evidence, even if the overall pass/fail result would remain the same. Completed exact-JSON grades and Case 01 are outside this importer.
- Each case is published atomically with a synced temporary file and an exclusive hard link, so an interrupted import cannot leave a half-written `rubric.json` or overwrite another importer. The whole batch is **not** a single transaction: completed cases stay locked if a later case fails. Re-run the same complete reviewed file to preserve completed cases and finish the rest. Concurrent conflicts stop further writes.
- A hard interruption can leave a private `.review-*.tmp` staging file. It is ignored, never treated as a grade, and not automatically deleted. Existing malformed/partial `rubric.json` files fail closed and are preserved for inspection. Edits still present only in a review draft are not imported until the entire packet is complete.
- Filesystem permissions are private (`0600`). This is a local review tool, not protection against someone deliberately editing experiment records or recomputing hashes. Run one grading workflow at a time; do not run the old interactive grader concurrently.

## Mocked tests

```sh
node --test internal/review/review.test.mjs
node --test tests/*.test.mjs internal/benchmark/harness.test.mjs internal/diagnostics/connectivity.test.mjs internal/batch/batch.test.mjs internal/review/review.test.mjs
```

Tests use synthetic results in temporary directories. They cover exact export fidelity, strict/acceptable scoring, complete validation, duplicate detection, partial existing grading, interruption before and after publication, resuming imports, concurrent publication, source drift, permissions and offline CLI behavior. They do not grade real outputs.
