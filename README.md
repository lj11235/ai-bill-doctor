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

Metadata and candidates are centralized in [`src/models.js`](src/models.js), checked **2026-09-26** against the official model pages. USD per **1 million text tokens**, standard service tier:

| Model | Input | Cached input | Output | Cheaper candidates |
| --- | ---: | ---: | ---: | --- |
| [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o) | $2.50 | $1.25 | $10.00 | GPT-4.1 mini, GPT-4o mini |
| [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1) | $2.00 | $0.50 | $8.00 | GPT-4.1 mini, GPT-4o mini |
| [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) | $0.40 | $0.10 | $1.60 | GPT-4o mini |
| [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini) | $0.15 | $0.075 | $0.60 | Candidate only |

This initial set shares text-in/text-out support, has materially lower candidate input/output rates, and avoids reasoning-specific settings. GPT-4.1 nano is excluded because its [shutdown is scheduled for October 23, 2026](https://developers.openai.com/api/docs/deprecations). Other models, snapshots as input choices, fine-tunes, tools, images, files, audio, and structured-output schemas are unsupported. Do not select a different baseline to stand in for your actual model.

The server requests documented aliases, records the returned model snapshot, and rejects unknown snapshots or service tiers it cannot price. Account-specific model access can still fail. Update model metadata and tests together when prices/availability change. Sources: [pricing](https://developers.openai.com/api/docs/pricing), [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [token usage](https://developers.openai.com/api/docs/guides/token-counting).

## What is real, and what is estimated?

**Real:** outputs, returned model, latency, and API-reported input/cached/output usage for every completed call. Prompts are identical between baseline and candidates. Candidates follow the configured `CANDIDATES` order, chosen to prioritize likely output quality. GPT-4.1 mini appears before GPT-4o mini for GPT-4o/GPT-4.1 benchmarks, even when GPT-4o mini costs less. The next candidate is shown after the user rejects the first; there is no AI quality judge.

**Calculated call cost:** `((input − cached input) × input price + cached input × cached price + output × output price) / 1,000,000`. This is an estimate from measured usage, not an invoice. Cached input defaults to zero only when unavailable, disclosed in the details. No Batch discounts, priority tiers, taxes, regional uplift, or negotiated pricing. Truncated/refused/empty outputs are excluded; their reported costs still count toward benchmark spending.

**Pasted original:** displayed for comparison and never sent to OpenAI. Plain text has no usage metadata, so one baseline replay is necessary to measure cost. The replay can differ from the pasted answer; both the distinction and measured replay are available under “How we calculated this.” There is no claim to know the pasted answer's historical cost.

**Estimated savings opportunity:** `(baseline cost − accepted candidate cost) / baseline cost`. The measured percentage reduction includes both differences in model token pricing and differences in the actual number of output tokens generated in this sample. Monthly = bill × workflow share × reduction. Annual = unrounded monthly × 12. A little = 25%, About half = 50%, Most of it = 75% of spend. This assumes a comparable request mix, volume, pricing, caching, and acceptable outputs beyond the one example. Acceptance is a user judgment on one sample, **not validated production savings**.

No benchmark results remain mocked in the app. Provider calls in automated tests are mocked. The sample input is authored example text.

## Spending and privacy guardrails

- Default per-benchmark budget **$0.05**; explicit approval above it; hard V0 ceiling **$0.25**.
- Configure the default with `BENCHMARK_BUDGET_USD=0.03 node server.mjs`. Change other limits in `src/models.js`.
- At most **3 calls / 2 candidates**, **1,024 output tokens per call**, **45 seconds per call**, **zero retries**. One benchmark runs at a time.
- Conservative preflight: UTF-8 prompt bytes + 512 tokens of message overhead, full output allowance, and no cache discount. This is a conservative estimate rather than exact tokenization. The server rechecks approval and reserves the full allowance for every attempted call, including failures. Unexpected overages stop later calls.
- Input limited to 48 KB of request + instructions. Output caps apply equally to every model. A request expecting a longer answer may be unsuitable for this V0.
- Cancel/closing the page aborts the connection and stops later calls. An already-sent or timed-out call may still be billed by OpenAI. No automatic retry hides extra spend.
- API key exists only in the password field/request memory while needed, is cleared from the field immediately when starting, and is not kept in app state, URLs, browser storage, files, logs, results, or copied setup. Server references are released after the benchmark; process exit clears its memory. JavaScript does not provide guaranteed physical zeroization of immutable strings.
- No analytics or request logging. Request/output data stays in tab/process memory; refresh clears the result. Keys must be re-entered for a new run.
- Browser calls only the local server. Provider calls go server-side to the fixed `https://api.openai.com/v1/responses` endpoint with `store: false`, `tools: []`, standard tier, and no redirects. OpenAI's [data retention policy](https://developers.openai.com/api/docs/guides/your-data) still applies; `store: false` is not a claim of zero retention at OpenAI.
- Loopback-only server, same-origin JSON POST checks, no CORS, no cookies, no database. Prompts cannot alter API settings, execute tools, or trigger external actions. Rendered content is HTML-escaped. This is a local experiment, not a hosted service.

## Tests and structure

```sh
node --test tests/*.test.mjs
```

Tests cover costs, shares, candidate ordering, rejection/acceptance, API failures, budget approval, truncation, cancellation, same-origin requests, and credential handling. They mock the provider and do not spend API credit. A paid smoke test requires entering your own key in the local UI.

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
