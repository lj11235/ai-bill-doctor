# AI Bill Doctor

A local, single-request experiment: find a cheaper OpenAI model, compare real outputs, and decide whether you would ship the result. The approved cream/green UI and flow are preserved. No prompt optimization, accounts, database, or dependencies.

## Run locally

Requires Node.js 20+. From this project folder:

```sh
node server.mjs
```

Open **http://localhost:5173**. If the old mock server is already running, stop it with **Ctrl+C**, then restart it. A browser refresh alone does not update the server.

If your shell says `node: command not found`, install Node.js 20 or newer and reopen your terminal.

There is no install/build step. `npm start` and `npm test` also work when Node/npm are on your PATH. The old standalone HTML preview cannot run the real benchmark; use the local server.

## Try the flow

1. **Find my savings** → select your current model and paste one text request.
2. Optionally add system instructions and an original response. **Load sample data** supplies sample input only; it still makes real, billed calls.
3. Enter a temporary OpenAI API key with Responses/model access and available API credit. Do not put it in a file or environment variable.
4. **Find a cheaper way** → local cost preflight → one baseline call and up to two candidate calls. Above-budget requests require an explicit checkbox confirmation.
5. Compare outputs. **Yes, this works** accepts the displayed candidate; **No, try another** shows the next already-tested candidate without another API call.
6. Enter your monthly bill and choose **A little / About half / Most of it**. See monthly/yearly opportunities and copy the exact model/setup for the accepted output.

If all cheaper outputs are rejected, the app recommends no change. If none are cheaper, or all candidates fail, it says so without inventing savings.

## Supported models and prices

Metadata, dated sources, prices, thresholds, and review order live in [`src/models.js`](src/models.js). Pricing reverified **2026-10-04**. USD per **1 million tokens**, public Standard tier:

| Model ID | Uncached input | Cached input | Cache write | Output | Review candidates |
| --- | ---: | ---: | ---: | ---: | --- |
| [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra) | $10 | $1 | $12.50 | $50 | 6.1 Sol → Luna |
| [`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | $2 | $0.10 | $2.50 | $10 | Luna |
| [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna) | $0.10 | $0.01 | $0.125 | $0.50 | Candidate only |

**More than 272,000 total input tokens** triggers long-context prices for the **entire request**: 2× uncached/cached/cache-write rates and 1.5× output rates. Exactly 272,000 uses short-context rates; output length does not determine the band. All three model pages linked above specify “more than 272K input tokens” and “for the full request.” We use `usage.input_tokens`, which includes the cache-read/write subsets in the [Responses usage schema](https://developers.openai.com/api/reference/resources/responses/methods/create). The calculator supports this rule, although V0's input and spending limits prevent such large benchmarks. See [official short/long rates](https://developers.openai.com/api/docs/pricing).

All calls use the same explicit **medium reasoning effort / standard reasoning mode**, current-turn reasoning context, medium text verbosity, implicit caching with a `30m` minimum lifetime, and the same output cap. No Pro mode or sampling overrides. These are benchmark settings; we cannot recover the settings or cost of a historical pasted answer. See [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and the [Responses API schema](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

The GPT-4 choices have been replaced to keep one V0 configuration and billing path. Only text requests are supported. Other models, undocumented snapshots, tools, images, files, audio, structured-output schemas, and custom configurations are excluded. Do not choose a different model to stand in for your actual baseline.

The server requires the documented returned model ID, Standard tier, matching reasoning settings, and complete billing counts. Unknown nonzero usage categories or incompatible returned settings exclude the affected comparison. A failed baseline stops the run. Account-specific access can still fail; pricing is maintained manually, so update metadata and tests together when the docs change.

## What is real, and what is estimated?

**Real:** outputs, returned model, latency, and API-reported uncached/cached/cache-write/output usage, including the reasoning subset. Prompts and settings are identical between baseline and candidates. Review follows `CANDIDATES`: Astra → 6.1 Sol → Luna, or 6.1 Sol → Luna. Measured cost never changes this order. The next candidate is shown after the user rejects the first; there is no AI quality judge.

**Calculated call cost:** `((input − cached − cache write) × input price + cached × cached price + cache write × write price + output × output price) / 1,000,000`. Reasoning tokens are already included in output usage and are never charged twice. Cache writes replace the ordinary input charge on those tokens; they are not an additional 1.25× charge. Missing counts are not assumed to be zero. This uses observed usage and public Standard prices, not an invoice or detection of negotiated account pricing. Fast/Ultrafast, Batch/Flex, taxes, regional uplift, and custom pricing are unsupported. Truncated/refused/empty outputs are excluded; their reported costs still count toward benchmark spending.

Cache-write billing was rechecked on **2026-10-04**: the official [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) explicitly states “Cache-write pricing is not an additive fee: input tokens use the uncached-input, cached-input, or cache-write rate.” Its input-cost example subtracts both cached and written tokens before charging ordinary input. The existing formula remains correct.

**Pasted original:** displayed for comparison and never sent to OpenAI. Plain text has no usage metadata, so one baseline replay is necessary to measure cost. The replay can differ from the pasted answer; both the distinction and measured replay are available under “How we calculated this.” There is no claim to know the pasted answer's historical cost.

**Estimated savings opportunity:** `(baseline cost − accepted candidate cost) / baseline cost`. The measured percentage reduction includes both differences in model token pricing and differences in the actual number of output tokens generated in this sample. Monthly = bill × workflow share × reduction. Annual = unrounded monthly × 12. A little = 25%, About half = 50%, Most of it = 75% of spend. This assumes a comparable request mix, volume, pricing, caching, and acceptable outputs beyond the one example. Acceptance is a user judgment on one sample, **not validated production savings**.

No benchmark results remain mocked in the app. Provider calls in automated tests are mocked. The sample input is authored example text.

## Spending and privacy guardrails

- Default per-benchmark budget **$0.05**; explicit approval above it; hard V0 ceiling **$0.25**. Both limits are unchanged. Every Astra benchmark requires confirmation: three maximum output allowances alone total $0.123904, before input. The supplied sample reserves $0.140754; Sol → Luna on the same sample reserves $0.024429 and fits the default.
- Configure the default with `BENCHMARK_BUDGET_USD=0.03 node server.mjs`. Change other limits in `src/models.js`.
- At most **3 calls / 2 candidates**, **2,048 output tokens per call, including reasoning**, **45 seconds per call**, **zero retries**. One benchmark runs at a time.
- Conservative preflight: UTF-8 prompt bytes + 512 tokens of message overhead, full output allowance including reasoning, and all input charged at the higher cache-write rate. No cache hit is assumed. This is a conservative estimate rather than exact tokenization. The server rechecks approval and reserves the full allowance for every attempted call, including failures. Unexpected overages stop later calls.
- Input limited to 48 KB of request + instructions. Output caps apply equally to every model. Medium reasoning consumes part of the 2,048-token allowance, so even a short visible answer can hit the cap. Incomplete answers cannot produce savings recommendations; the app never silently lowers reasoning or raises the cap to make them pass.
- Cancel/closing the page aborts the connection and stops later calls. An already-sent or timed-out call may still be billed by OpenAI. No automatic retry hides extra spend.
- API key exists only in the password field/request memory while needed, is cleared from the field immediately when starting, and is not kept in app state, URLs, browser storage, files, logs, results, or copied setup. Server references are released after the benchmark; process exit clears its memory. JavaScript does not provide guaranteed physical zeroization of immutable strings.
- No analytics or request logging. Request/output data stays in tab/process memory; refresh clears the result. Keys must be re-entered for a new run.
- Browser calls only the local server. Provider calls go server-side to the fixed `https://api.openai.com/v1/responses` endpoint with `store: false`, `tools: []`, standard tier, and no redirects. OpenAI's [data retention policy](https://developers.openai.com/api/docs/guides/your-data) still applies; `store: false` is not a claim of zero retention at OpenAI.
- Loopback-only server, same-origin JSON POST checks, no CORS, no cookies, no database. Prompts cannot alter API settings, execute tools, or trigger external actions. Rendered content is HTML-escaped. This is a local experiment, not a hosted service.

### Output-cap decision (2026-10-04)

The supplied sample has 602 UTF-8 prompt bytes, so preflight reserves **1,114 input tokens per call**, all at cache-write rates. Reserving the full output cap on each call gives:

| Output cap per call | Astra | 6.1 Sol | Luna | Total, rounded up | $0.25 ceiling |
| --- | ---: | ---: | ---: | ---: | --- |
| **2,048** | $0.116325 | $0.023265 | $0.00116325 | **$0.140754** | Fits; confirmation required |
| 4,096 | $0.218725 | $0.043745 | $0.00218725 | **$0.264658** | Exceeds ceiling |

Use **2,048** as the budget-compatible improvement over 1,024. This does **not** establish that longer synthesis at medium reasoning will fit. The [official reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) recommends initially reserving at least 25,000 tokens for reasoning and outputs before tuning to observed usage; neither tested cap meets that general recommendation. No live benchmark was run to validate cap adequacy. Incomplete outputs remain excluded, and the app makes no recommendation when the baseline is incomplete. The approved UI, reasoning configuration, default budget, and hard ceiling are unchanged.

## Tests and structure

```sh
node --test tests/*.test.mjs
```

Tests cover both GPT-6 ladders, identical request settings, all token price categories, the long-context boundary, measured savings versus price ratios, incompatible configurations, shares, rejection/acceptance, API failures, Astra budget approval, truncation, cancellation, same-origin requests, and credential handling. They mock the provider and do not spend API credit. A paid smoke test requires entering your own key in the local UI.

```text
src/app.js          Approved screens, streaming progress, user decision
src/styles.css      Responsive styles
src/models.js      Dated model/pricing metadata, candidates, limits, cost math
src/data.js        Sample input, shared request payload, savings/copy helpers
lib/provider.mjs   OpenAI Responses call and usage extraction
lib/benchmark.mjs  Preflight, bounded calls, candidate review order, partial failures
lib/errors.mjs     Safe founder-facing errors
server.mjs         Local HTTP server and two POST endpoints
tests/             Provider-mocked tests (no live calls)
```
