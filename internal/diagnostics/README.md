# One-call API connectivity diagnostic

A standalone synthetic probe. It never imports the product or benchmark harness, reads or writes `smb-v1`, or contributes to benchmark metrics. There are no new dependencies, file writes, or automatic retries.

## Preview and test — no paid calls

From the project directory, with Node 20 or later:

```sh
node internal/diagnostics/connectivity.mjs
node --test internal/diagnostics/connectivity.test.mjs
```

Complete mocked suite:

```sh
node --test tests/*.test.mjs internal/benchmark/harness.test.mjs internal/diagnostics/connectivity.test.mjs
```

The default command only prints a plan. Tests inject synthetic responses; unmocked fetches in the diagnostic tests are blocked.

## Live execution — only after explicit approval

```sh
node internal/diagnostics/connectivity.mjs --paid
```

1. Review the fixed settings and conservative cost estimate.
2. Type `APPROVE ONE PAID CALL` at the confirmation prompt. Confirmation entry is hidden too.
3. At the next prompt, enter your OpenAI API key. Nothing is echoed, including pasted characters.

An interactive terminal is required. Keys are never accepted through arguments, environment variables, or files. Do not put a key in a shell command or chat message. Ctrl-C/Ctrl-D cancels entry. Invalid arguments, declined approval, cancellation, or invalid key format make zero calls.

After valid approval and key entry, the process makes exactly one POST to `https://api.openai.com/v1/responses`. It does not follow redirects, fetch a model list, poll, retry, or fall back to another model. The 45-second timeout covers the request and response body. A timeout does not establish whether OpenAI charged the request; an unknown cost stays `null`, never zero. A future attempt requires fresh approval.

## Fixed settings and cost

Verified against official documentation on **2026-10-11**:

- Model: `gpt-6.1-sol`; prompt: `Reply with exactly OK.`
- Reasoning: `low`, `standard` mode, `current_turn`. Sol does not support `none` or `minimal`. [Model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- Total output cap: **512 tokens**, including reasoning. The API accepts a minimum of 16, but that is not a reliable reasoning allowance. 512 is a small practical buffer for this trivial prompt, not a documented or empirically verified minimum. No paid calls were used to tune it. An incomplete response is reported without retrying. [Responses reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create), [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)
- Standard service tier, low text verbosity, no tools, no background processing, no streaming, `store: false`, implicit 30-minute prompt cache.
- Public short-context rates per million tokens: ordinary input **$2**, cached input **$0.10**, cache writes **$2.50**, output **$10**. [Model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol)

The **$0.007680 conservative preflight estimate** allows 1,024 input tokens, all charged at the cache-write rate, plus all 512 output tokens. This is generous for the fixed prompt and framing. The input allowance is an estimate, not an API-enforced input or dollar limit. The actual output cap is sent to the provider. There is no extra paid token-count request.

Measured cost uses API-reported usage:

```text
ordinary input = input_tokens - cached_tokens - cache_write_tokens
USD = (ordinary input × 2 + cached_tokens × 0.10
       + cache_write_tokens × 2.50 + output_tokens × 10) / 1,000,000
```

Cache writes replace ordinary input billing for those tokens. Reasoning tokens are already included in output usage and are not added again. [Official cache calculation](https://developers.openai.com/api/docs/guides/prompt-caching)

Missing/inconsistent usage, unknown billing fields, unexpected models/tiers/cache settings, Pro mode, tools, or input above 272,000 tokens suppress the cost calculation. Long-context pricing is deliberately outside this tiny probe. Costs use public Standard pricing; account-specific discounts or regional charges are not verified by this diagnostic.

## Safe results

The terminal receives a sanitized JSON report containing the outcome/category, HTTP status, error code/type, request IDs, allowlisted rate-limit headers, numeric usage, and calculated USD cost. Model output, raw error messages, organization/account metadata, authorization headers, keys, and exception stacks are not printed. No report is saved automatically.

Keys remain in process memory only; references are cleared after use. JavaScript cannot guarantee secure memory erasure. `store: false` disables response retrieval storage, not all provider retention policies.

- `success`: complete visible text was received; `costUsd` is calculated from actual usage. The generated text itself is discarded.
- `billing_credit_balance`, `billing_project_limit`, `billing_organization_limit`, `organization_usage_limit`, `billing_or_quota`: inspect the corresponding account control.
- `authentication`, `permission_or_region`, `model_unavailable_or_no_access`: inspect key permissions and model/project access.
- `rate_limit`, `rate_limit_ramp`: provider reported throttling. Generic `unclassified_429` does not prove a rate-limit or billing cause. Request/token/project-token headers are preserved; exhausted counters alone do not conclusively distinguish RPM from TPM.
- `output_limit`, `incomplete_response`, `refusal`, `empty_output`: connectivity may have worked, but the probe did not finish successfully. Usable usage still produces a measured cost.
- `timeout`, `network_or_transport`, `unreadable_response`, `unsupported_pricing`, `missing_or_invalid_usage`: cost may be unknown. Do not automatically rerun.

Error code/type and request IDs accept only bounded, safe identifier characters; suspicious values are omitted. Header values accept only numeric limits, durations, and standard retry dates. Unknown error details are never copied into the report. The client request ID can help OpenAI support investigate a timeout; it is not an idempotency guarantee.

References: [error codes](https://developers.openai.com/api/docs/guides/error-codes), [rate-limit headers](https://developers.openai.com/api/docs/guides/rate-limits), [request IDs](https://developers.openai.com/api/reference/overview).
