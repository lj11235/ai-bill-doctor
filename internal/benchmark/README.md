# Internal SMB replacement experiment

This harness uses the frozen V0 engine at commit `6558f96e542648e88120bb6328fa42486117800b`. It adds no customer UI or server route. No new dependencies. All case content is synthetic business data, authored before model execution.

## Review before spending

Read [all 12 cases, full prompts and hidden evaluations](CASES.md). Canonical model inputs are in [fixtures.json](fixtures.json); hidden ground truth and rubrics are in [rubrics.json](rubrics.json). Six cases use exact JSON and six use manual rubrics. There are two cases per category, eight Astra baselines and four Sol baselines. Do not treat these twelve selected cases as a population estimate of all SMB workloads.

| ID | Workload | Baseline | Evaluation |
| --- | --- | --- | --- |
| 01-billing-triage | Support classification and genuine billing urgency | Sol | Exact JSON labels |
| 02-contracted-arr | Active account ARR versus quoted expansion | Astra | Exact JSON amounts |
| 03-invoice-json | Messy invoice, credit, tax and partial payment | Sol | Exact JSON reconciliation |
| 04-multi-team-routing | Unresolved actions; sales rep is FYI only | Astra | Exact JSON routing |
| 05-unit-economics | Inference saving versus additional support cost | Astra | Numeric intermediates and decision |
| 06-experiment-economics | Cost per successful task, support and quality floor | Astra | Numeric intermediates and decision |
| 07-feedback-reliability | Deduplicated customer feedback and uncertain causes | Sol | Manual rubric |
| 08-feedback-conflicts | Segment conflict, ownership error and confounded usage | Astra | Manual rubric |
| 09-outage-rewrite | Customer update with incomplete recovery | Sol | Manual rubric |
| 10-onboarding-copy | Two useful variants with exact pricing/plan constraints | Astra | Manual rubric |
| 11-launch-synthesis | Dated launch packet with outstanding gates | Astra | Manual rubric |
| 12-pilot-synthesis | Shifted traffic mix, support cost and false confidence | Astra | Manual rubric |

Sol means `gpt-6.1-sol`. Astra runs Astra → Sol → Luna; Sol runs Sol → Luna. The harness imports the existing engine, provider, pricing and request settings. Medium reasoning, Standard tier, 2,048 total output tokens, no retries, the $0.05 default and $0.25 hard ceiling all stay unchanged. Every live harness run requires an explicit per-case approval, including cases below $0.05. Long cases are about 6.9 KB and 5.9 KB of input: longer realistic packets within V0's budget, not maximum-context stress tests.

## Precommit and result storage

`init` creates a manifest before any calls. It fingerprints both definition files, the harness code, engine/provider, pricing/settings, and product files. Subsequent commands refuse to run or grade if a locked file changes. Keep the original experiment if a genuine fixture error is discovered; record the limitation outside its criteria and review a corrected version as a new experiment. Never repair an answer key after looking at outputs and then reuse the old results.

One attempt per case per experiment. No overwrite, automatic rerun or best-of selection. A crash leaves its partial checkpoint; summary records interrupted calls as technical inconclusives. Do not delete a failed attempt to rerun it. A repeat experiment must be reported separately, including why it was repeated. These are local process guardrails, not access controls against someone deliberately editing files and recomputing hashes.

Generated files live under the already ignored `outputs/internal-benchmark/EXPERIMENT/`:

```text
manifest.json                 Lock and creation time, before any paid call
01-billing-triage/
  result.json                 Actual outputs, costs, usage, settings, statuses
  human.json                  Candidate replacement yes/no, tied to output hash
  rubric.json                 strict_pass, acceptable_pass and criterion evidence
...one directory per attempted case
```

See [result.schema.json](result.schema.json) for the result schema and `$defs/human` and `$defs/rubric` for companion schemas. Schema version 2 identifies baseline-replacement decisions and the two rubric outcomes; version 1 ship decisions cannot be reused. Initialize a new experiment with the updated severity lock before collecting outputs. The schemas document records; the harness validates locks, ladder, plan, decisions and review evidence without an external schema library. No sample model outputs or invented benchmark results are bundled. Test responses exist only in `harness.test.mjs`.

The API key is entered at a hidden TTY prompt, held in memory and not accepted through argv, files or environment variables. The harness retains the model outputs deliberately for internal review; treat result folders as private. It persists selected provider fields and safe error codes, never headers, API keys or raw error messages. Checkpoint files are local and created with restrictive permissions.

## Blind human review and independent grading

1. The operator runs a case. Ideally someone else reviews it. Give the reviewer only the `blind` output, not the catalog, manifest, plan or raw result file.
2. The reviewer sees the original system/request, Baseline, Candidate A and (when present) Candidate B, without model names, usage, costs, savings or the hidden rubric.
3. `human` asks **“Would you replace the baseline with this candidate for this workload?”** Record yes/no independently for every complete candidate. The baseline stays visible as a reference and receives no human ship decision. Unusable/missing candidates receive no fabricated yes/no. Decisions are locked before `reveal` becomes available. Review Candidate B even if Candidate A receives yes; model execution/order still uses the unchanged engine.
4. `rubric` grades the baseline and every complete candidate independently after human decisions are locked. Exact JSON cases compare parsed structures: object-key order is irrelevant, array order matters, extra fields fail, and numbers must equal the requested rounded values. Fences or prose around JSON fail. There is no tolerance chosen after observing an answer.
5. For subjective cases, an evaluator marks each precommitted criterion pass/fail/inconclusive and writes evidence. Its precommitted critical/secondary severity is retained alongside the individual result. Report both strict and acceptable outcomes as defined below. No canonical prose answer or LLM judge is used. Prefer a second evaluator, and grade before revealing costs to limit bias.
6. `reveal` shows model, measured call cost and measured reduction only after human decisions exist. Rubric and human judgments remain separate.

Blinding is practical, not perfect: candidate order is fixed, a reviewer who knows the ladder can infer identities, and generated prose may self-identify. The same operator reading the case catalog already knows its baseline. Use a reviewer who has not studied the assignments when possible. Raw files are not a reviewer UI and intentionally contain provenance/costs.

### Rubric severity and outcomes

The 36 approved manual criteria retain their exact wording. Severity is assigned before outputs and included in the manifest fingerprint. Critical criteria protect against unsafe, materially incorrect, misleading or unusable business decisions. Secondary criteria cover supporting completeness, presentation and nonessential detail.

| Case | Critical criteria | Secondary criteria |
| --- | --- | --- |
| 07 | facts, deduplication, uncertainty, format | actions |
| 08 | segments, ownership, causality, recommendation, format | experiment |
| 09 | scope_time, ongoing_work, data_uncertainty, next_update | voice_format |
| 10 | free_plan, paid_plan, control, unsupported_claims | distinct_variants, format |
| 11 | decision, gates, evidence_limits, scope_resources, next_decision | owners |
| 12 | economics, mix, false_confidence, decision, experiment, limits | format_sources |

There are **29 critical and 7 secondary** criteria. Some approved criteria bundle formatting with material safeguards: the `format` criteria in 07/08 and `format_sources` in 11 forbid invented business claims, guarantees or approvals, so those whole criteria remain critical. We have not split or rewritten them. This means a formatting-only failure within one of those bundled criteria still fails acceptable review. In 09, the incorrect rerun instruction is separately covered by critical `ongoing_work`; in 12, critical economics, mix, correctness, decision, experiment and limits criteria cover the business substance, while `format_sources` covers presentation and supporting citations. Grade each applicable criterion independently; a factual error also present in a secondary criterion must still fail the applicable critical criterion. Actions in 07, follow-up experiment detail in 08 and owner detail in 11 are supporting completeness, with material claim and decision safeguards retained in critical criteria.

Each output records `strict_pass` and `acceptable_pass`, each either `true`, `false` or `"inconclusive"`:

- **Strict:** true only when every criterion passes; false if any criterion fails; otherwise inconclusive.
- **Acceptable:** false if any critical criterion fails. Otherwise, any inconclusive critical criterion makes it inconclusive. Once all critical criteria pass, at least **80% of all criteria** must pass. This requires 4/5, 5/6 or 6/7 for the approved rubrics; the denominator never drops inconclusive criteria.
- **Secondary uncertainty:** if enough criteria already pass, acceptable is true even with secondary uncertainty. If resolving secondary uncertainty could change whether 80% pass, acceptable is inconclusive. If 80% cannot be reached, acceptable is false.
- **Exact JSON:** a match is true for both outcomes and a mismatch is false for both. Technical/budget failures remain inconclusive for both; explicit refusals remain false for both.

A human replacement yes does not override either rubric outcome. A failing baseline does not make a failing candidate acceptable: grade each against the fixed independent criteria.

### Outcomes

- `complete`: usable, priced response eligible for separate human/rubric review.
- `quality_failure`: explicit refusal on these benign tasks; rubric fail, not a technical error.
- `inconclusive_output_budget`: confirmed `incomplete_details.reason = max_output_tokens`. No quality failure and no retry with changed settings. Reported usage/cost is retained.
- `inconclusive_technical`: API, access, transport, pricing/configuration, empty response, or incomplete output without confirmed budget exhaustion. Keep a safe reason code. An incomplete response alone is not sufficient to infer an output-budget failure.
- `not_run`: the unchanged engine stopped before this call, for example after an incomplete baseline. It is unavailable evidence, not a candidate quality failure.
- `running` in an interrupted checkpoint: technical inconclusive. Unknown charges stay marked as potentially incomplete. The interrupted workload is terminal unavailable evidence, reported separately, rather than an indefinitely pending human review; its partial outputs are retained for diagnosis.

All priced responses are recorded, including models excluded from the customer app's cheaper-candidate list. A model that produced a more expensive complete response can still be quality-graded; it contributes no positive savings estimate. An incomplete baseline stops subsequent calls exactly as it does in V0. We do not change the cap to improve success rates.

## Metrics (also grouped by category)

Primary quality rates use **attempted workloads**, including technical/budget failures, as denominator. Report numerator and denominator alongside percentages. Unrun cases are reported separately. Until all complete candidates have human decisions and all complete outputs (including baseline) have rubric decisions, quality rates are provisional lower bounds. Empty denominators and empty medians are `null`, not zero.

| Metric | Precommitted calculation |
| --- | --- |
| Human replacement (`cheaperModelAcceptance`) | Workloads with any configured candidate receiving replacement **yes** / attempted workloads |
| Strict / acceptable rubric-qualified replacement | Report both: workloads with any candidate whose respective `strict_pass` / `acceptable_pass` is **true** / attempted workloads, independently of human decisions |
| Strict / acceptable Luna replacement | Report both: workloads where Luna passes the respective rubric outcome / attempted workloads |
| Strict / acceptable Sol replacement | Report both: Astra workloads where Sol passes the respective rubric outcome / attempted Astra workloads |
| False confidence (primary) | Replacement-yes candidate outputs with `acceptable_pass=false` / replacement-yes candidate outputs with boolean `acceptable_pass`. Report affected case IDs and candidate labels; exclude pending/inconclusive judgments from this denominator |
| Strict false confidence (diagnostic) | The same calculation using `strict_pass`, with its own denominator and affected case IDs/candidate labels; individual criterion failures remain in each rubric record |
| Median measured savings among human-accepted replacements | For each workload, choose the first replacement-yes candidate in quality order with a valid positive measured reduction. Median of those reductions, one per workload; also report the number contributing |
| Median measured savings among strict / acceptable rubric-qualified replacements | Report both: same selection and median, using the respective rubric outcome **true** independently of human judgment |
| Inconclusive | Workloads with any budget/technical/not-run/interrupted output or acceptable-inconclusive judgment / attempted workloads. Also report `strictInconclusive` using strict judgments |

“Cheaper-model” refers to the configured lower-priced model family, not guaranteed lower measured cost. The first four rates test acceptability/correctness of substitution; actual cost benefit is a separate check. Savings use the production engine's `(baseline cost − candidate cost) / baseline cost`, reflecting actual API usage and prices. Never choose the candidate with maximum savings. A baseline that fails its rubric does not become ground truth; candidates are graded against the independent definition. Quality failure totals include baseline failures for diagnosis. `qualityFailureOutputs` uses acceptable failures; `strictFailureOutputs` separately retains strict failures. `pendingHumanOutputs` counts only complete candidates; pending rubric outputs still include the baseline.

Inconclusive workloads can also contain a passing replacement, so those percentages are not mutually exclusive. A confirmed cap-limited output never increments the quality-failure count. Pending reviews are shown separately from inconclusive model results. No claim of validated production savings follows from this experiment.

## Commands

Use Node 20+ from the project root. Inspect these now; the paid command is for **after review and approval**.

```sh
# Safe: inspect definitions and conservative costs; no provider calls
node internal/benchmark/cli.mjs list
node internal/benchmark/cli.mjs catalog
node internal/benchmark/cli.mjs plan 01-billing-triage

# Lock definitions/configuration before collecting any outputs
node internal/benchmark/cli.mjs init smb-v1

# AFTER APPROVAL ONLY: one case, exact quoted preflight ceiling, hidden key prompt
node internal/benchmark/cli.mjs run smb-v1 01-billing-triage --paid --approve 0.026495

# Human decisions first; no model identities or costs in these views
node internal/benchmark/cli.mjs blind smb-v1 01-billing-triage
node internal/benchmark/cli.mjs human smb-v1 01-billing-triage

# Independent grading, then reveal measured economics
node internal/benchmark/cli.mjs rubric smb-v1 01-billing-triage
node internal/benchmark/cli.mjs reveal smb-v1 01-billing-triage

# Aggregate current results without making more calls
node internal/benchmark/cli.mjs summary smb-v1
```

Repeat `plan` → `run` → `human` → `rubric` → `reveal` explicitly for each remaining case ID. Use that case's quoted `maxCost` for `--approve`; never reuse a lower quote or silently raise the ceiling. There is no run-all command. Do not read the hidden rubric before the human decision; the full catalog is for the experiment owner, not the blind reviewer.

If Node is not on your PATH, use your installed Node binary in place of `node`. No installation or build step is required.

```sh
# Internal harness tests, all mocked (no paid calls)
node --test internal/benchmark/harness.test.mjs

# Frozen product suite plus internal harness
node --test tests/*.test.mjs internal/benchmark/harness.test.mjs
```

The harness tests also compare every existing project file against the frozen commit's blob hashes and check that the local server cannot serve fixtures, rubrics or results.
