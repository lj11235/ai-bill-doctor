import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone probe: no production or benchmark imports; no file writes.
// Verified 2026-10-11. Public Standard USD per million text tokens.
export const PRICING = Object.freeze({
  model: 'gpt-6.1-sol', input: 2, cached: 0.10, cacheWrite: 2.50, output: 10,
  longContextAbove: 272000, verifiedAt: '2026-10-11',
  source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  cacheSource: 'https://developers.openai.com/api/docs/guides/prompt-caching',
});
export const APPROVAL = 'APPROVE ONE PAID CALL';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const OUTPUT_CAP = 512;
const TIMEOUT_MS = 45000;
// Deliberately generous allowance for this fixed, tiny prompt and framing.
// This is a preflight estimate, not a provider-enforced dollar limit.
const INPUT_ALLOWANCE = 1024;
const ESTIMATE_USD = (INPUT_ALLOWANCE * PRICING.cacheWrite + OUTPUT_CAP * PRICING.output) / 1e6;

export function requestPayload() {
  return {
    model: PRICING.model, input: 'Reply with exactly OK.',
    reasoning: { effort: 'low', mode: 'standard', context: 'current_turn' },
    max_output_tokens: OUTPUT_CAP, service_tier: 'default',
    text: { format: { type: 'text' }, verbosity: 'low' },
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    tools: [], store: false, stream: false, background: false,
  };
}

export function plan() {
  return {
    mode: 'preview_only', model: PRICING.model, reasoning: 'low / standard',
    maxOutputTokens: OUTPUT_CAP, inputTokenAllowance: INPUT_ALLOWANCE,
    conservativeCostEstimateUsd: ESTIMATE_USD, apiCalls: 0, retries: 0,
    nextStep: 'After approval, run with --paid and confirm interactively. Enter the key only at the hidden prompt.',
  };
}

function report(category, outcome = 'failed') {
  return {
    outcome, category, httpStatus: null, errorCode: null, errorType: null,
    requestId: null, clientRequestId: null, rateLimitHeaders: {}, usage: null,
    costUsd: null, costStatus: outcome === 'not_run' ? 'not_called' : 'unknown',
  };
}

// Never forward arbitrary provider messages, response text, or headers.
function safeId(value, key) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !value.includes(key) && !/sk[-_]/i.test(value) ? value : null;
}

function safeHeaders(headers, key) {
  const result = {};
  for (const scope of ['requests', 'tokens', 'project-tokens']) {
    for (const kind of ['limit', 'remaining', 'reset']) {
      const name = `x-ratelimit-${kind}-${scope}`;
      const value = headers.get(name);
      const pattern = kind === 'reset' ? /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/ : /^\d+$/;
      if (typeof value === 'string' && value.length <= 64 && !value.includes(key) && pattern.test(value)) result[name] = value;
    }
  }
  const retry = headers.get('retry-after');
  if (typeof retry === 'string' && retry.length <= 64 && !retry.includes(key)
      && (/^\d+(?:\.\d+)?$/.test(retry)
        || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry))) result['retry-after'] = retry;
  return result;
}

function errorCategory(status, code, type) {
  const billing = {
    credit_balance_exhausted: 'billing_credit_balance',
    project_spend_limit_exceeded: 'billing_project_limit',
    organization_spend_limit_exceeded: 'billing_organization_limit',
    organization_usage_limit_exceeded: 'organization_usage_limit',
    insufficient_quota: 'billing_or_quota',
  };
  if (Object.hasOwn(billing, code)) return billing[code];
  if (type === 'insufficient_quota') return 'billing_or_quota';
  if (code === 'model_not_found') return 'model_unavailable_or_no_access';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission_or_region';
  if (code === 'slow_down') return 'rate_limit_ramp';
  // Generic 429 does not establish whether RPM, TPM, or quota was responsible.
  if (status === 429) return type === 'rate_limit_error' || code === 'rate_limit_exceeded' ? 'rate_limit' : 'unclassified_429';
  if (code === 'server_is_overloaded') return 'provider_overloaded';
  if (status >= 500) return 'provider_error';
  if (status >= 300 && status < 400) return 'redirect_blocked';
  if (status >= 400) return 'request_rejected';
  return 'provider_response_failed';
}

const count = value => Number.isSafeInteger(value) && value >= 0;
function readUsage(raw) {
  const usage = {
    inputTokens: raw?.input_tokens, cachedInputTokens: raw?.input_tokens_details?.cached_tokens,
    cacheWriteTokens: raw?.input_tokens_details?.cache_write_tokens,
    outputTokens: raw?.output_tokens, reasoningTokens: raw?.output_tokens_details?.reasoning_tokens,
    totalTokens: raw?.total_tokens,
  };
  if (!Object.values(usage).every(count)
      || usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens
      || usage.reasoningTokens > usage.outputTokens
      || usage.totalTokens !== usage.inputTokens + usage.outputTokens) return null;
  return usage;
}
const unknownUsage = (object, allowed) => Object.entries(object ?? {})
  .some(([key, value]) => !allowed.includes(key) && value != null && value !== 0);

function measuredCost(data, usage) {
  if (!usage || data.model !== PRICING.model || data.service_tier !== 'default'
      || usage.inputTokens > PRICING.longContextAbove || usage.outputTokens > OUTPUT_CAP
      || (data.reasoning?.mode && data.reasoning.mode !== 'standard')
      || (data.prompt_cache_options && (data.prompt_cache_options.mode !== 'implicit' || data.prompt_cache_options.ttl !== '30m'))
      || !Array.isArray(data.output) || data.output.some(item => !['message', 'reasoning'].includes(item?.type))
      || unknownUsage(data.usage, ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens'])
      || unknownUsage(data.usage?.input_tokens_details, ['cached_tokens', 'cache_write_tokens'])
      || unknownUsage(data.usage?.output_tokens_details, ['reasoning_tokens'])) return null;
  const ordinary = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  // Write tokens replace ordinary input billing. Reasoning is already in output.
  return (ordinary * PRICING.input + usage.cachedInputTokens * PRICING.cached
    + usage.cacheWriteTokens * PRICING.cacheWrite + usage.outputTokens * PRICING.output) / 1e6;
}

// One fetch, zero SDK retries, no redirects, no follow-up retrievals.
// fetchImpl exists solely to test this path without using the network.
export async function probe({ approval, apiKey, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (approval !== APPROVAL) return report('approval_required', 'not_run');
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(apiKey)) return report('invalid_key_format', 'not_run');
  const result = report('network_or_transport');
  result.clientRequestId = randomUUID();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-Client-Request-Id': result.clientRequestId },
      body: JSON.stringify(requestPayload()),
    });
    result.httpStatus = response.status;
    result.requestId = safeId(response.headers.get('x-request-id'), apiKey);
    result.rateLimitHeaders = safeHeaders(response.headers, apiKey);
    if (response.status >= 300 && response.status < 400) {
      result.category = 'redirect_blocked';
      await response.body?.cancel();
      return result;
    }
    let data;
    try { data = await response.json(); }
    catch {
      result.category = controller.signal.aborted ? 'timeout' : response.ok ? 'unreadable_response' : errorCategory(response.status, null, null);
      return result;
    }
    result.errorCode = safeId(data?.error?.code, apiKey);
    result.errorType = safeId(data?.error?.type, apiKey);
    if (response.ok) {
      result.usage = readUsage(data?.usage);
      result.costUsd = measuredCost(data, result.usage);
      if (result.costUsd !== null) result.costStatus = 'measured';
    }
    if (!response.ok || data?.error) {
      result.category = errorCategory(response.status, result.errorCode, result.errorType);
      return result;
    }
    if (data?.status === 'incomplete') {
      result.category = data.incomplete_details?.reason === 'max_output_tokens' ? 'output_limit' : 'incomplete_response';
    } else if (data?.status !== 'completed') {
      result.category = 'provider_response_failed';
    } else if (!result.usage) {
      result.category = 'missing_or_invalid_usage';
    } else if (result.costUsd === null) {
      result.category = 'unsupported_pricing';
    } else {
      const content = data.output.filter(item => item?.type === 'message' && item.role === 'assistant')
        .flatMap(item => Array.isArray(item.content) ? item.content : []);
      if (content.some(part => part?.type === 'refusal')) result.category = 'refusal';
      else if (content.some(part => part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim())) {
        result.outcome = 'success'; result.category = 'success';
      } else result.category = 'empty_output';
    }
    return result;
  } catch {
    // Never forward exception messages or stacks: they can contain credentials.
    result.category = controller.signal.aborted ? 'timeout' : 'network_or_transport';
    return result;
  } finally {
    apiKey = ''; clearTimeout(timeout);
  }
}

// Both confirmation and key entry are hidden, including pasted characters.
// No argv/env/file key support. Restore the terminal on completion/cancellation.
export function hiddenLine(prompt, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(new Error('Interactive terminal required.'));
  return new Promise((resolveLine, reject) => {
    let value = '';
    let finished = false;
    const wasRaw = Boolean(input.isRaw);
    const finish = error => {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData); input.removeListener('end', onEnd); input.removeListener('error', onEnd);
      input.setRawMode(wasRaw); input.pause(); output.write('\n');
      const answer = value; value = '';
      if (error) reject(new Error('Entry cancelled.')); else resolveLine(answer);
    };
    const onEnd = () => finish(true);
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004' || character === '\u001a') { finish(true); return; }
        if (character === '\r' || character === '\n') { finish(false); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (/^[\x20-\x7e]$/.test(character) && value.length < 512) value += character;
        else { finish(true); return; }
      }
    };
    input.setRawMode(true);
    input.on('data', onData); input.on('end', onEnd); input.on('error', onEnd);
    output.write(prompt); input.resume();
  });
}

export async function main(args = process.argv.slice(2), { input = process.stdin, output = process.stdout, fetchImpl = fetch } = {}) {
  const print = value => output.write(JSON.stringify(value, null, 2) + '\n');
  if (!args.length || (args.length === 1 && args[0] === '--help')) { print(plan()); return 0; }
  if (args.length !== 1 || args[0] !== '--paid') { print(report('invalid_arguments', 'not_run')); return 1; }
  if (!input.isTTY || !output.isTTY) { print(report('interactive_terminal_required', 'not_run')); return 1; }
  let apiKey = '';
  let approval;
  try {
    output.write(`One paid ${PRICING.model} call, low reasoning, ${OUTPUT_CAP} total output tokens.\nConservative estimate: $${ESTIMATE_USD.toFixed(6)} at public Standard rates. No retries.\n`);
    approval = await hiddenLine(`Type ${APPROVAL} to continue (hidden): `, input, output);
    if (approval !== APPROVAL) { print(report('approval_required', 'not_run')); return 1; }
    apiKey = await hiddenLine('Temporary OpenAI API key (hidden; memory only): ', input, output);
  } catch {
    apiKey = ''; print(report('entry_cancelled', 'not_run')); return 1;
  }
  try {
    const result = await probe({ approval, apiKey, fetchImpl });
    apiKey = '';
    print(result);
    return result.outcome === 'success' ? 0 : 1;
  } finally { apiKey = ''; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Diagnostic stopped. No automatic retry. Charge status may be unknown.');
    process.exitCode = 1;
  });
}
