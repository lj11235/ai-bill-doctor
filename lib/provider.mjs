import { MODELS, LIMITS, costFromUsage, pricingForUsage } from '../src/models.js';
import { requestPayload } from '../src/data.js';
import { BenchmarkError, providerError } from './errors.mjs';

const endpoint = 'https://api.openai.com/v1/responses';

// Fail closed when a future usage schema adds a nonzero billing category.
function hasUnknownUsage(object, allowed) {
  return object && Object.entries(object).some(([key, value]) => !allowed.includes(key) && value != null && value !== 0);
}

// The only provider network call. No SDK retries, user-provided URLs, or tools.
export async function callOpenAI({ model, input, apiKey, signal, fetchImpl = fetch }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, LIMITS.timeoutMs);
  const started = performance.now();
  try {
    const payload = requestPayload(input, model);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
    let data;
    try { data = await response.json(); } catch { throw new BenchmarkError('provider_error', 'OpenAI returned an unreadable response. No automatic retry was made.', 502); }
    if (!response.ok) throw providerError(response.status, data?.error?.code);
    const metadata = MODELS[model];
    if (!metadata?.returnedModels.includes(data?.model) || data.service_tier !== 'default') {
      throw new BenchmarkError('unsupported_pricing', 'OpenAI returned a model or price tier we cannot price reliably. No savings comparison was made.', 502);
    }
    if (hasUnknownUsage(data.usage, ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens'])
        || hasUnknownUsage(data.usage?.input_tokens_details, ['cached_tokens', 'cache_write_tokens'])
        || hasUnknownUsage(data.usage?.output_tokens_details, ['reasoning_tokens'])
        || data.output?.some(item => !['message', 'reasoning'].includes(item.type))
        || (data.prompt_cache_options && (data.prompt_cache_options.mode !== payload.prompt_cache_options.mode || data.prompt_cache_options.ttl !== payload.prompt_cache_options.ttl))) {
      throw new BenchmarkError('unsupported_pricing', 'OpenAI returned a pricing category this V0 cannot calculate reliably. This output is excluded from savings comparisons.', 502);
    }
    if (Object.entries(payload.reasoning).some(([key, value]) => data.reasoning?.[key] !== value)
        || (data.max_output_tokens != null && data.max_output_tokens !== payload.max_output_tokens)
        || (data.text && (data.text.verbosity !== payload.text.verbosity || data.text.format?.type !== 'text'))) {
      throw new BenchmarkError('incomparable_settings', 'OpenAI did not confirm the same benchmark reasoning or output settings. This output is excluded from savings comparisons.', 502);
    }
    const usage = {
      inputTokens: data.usage?.input_tokens,
      cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens,
      cacheWriteTokens: data.usage?.input_tokens_details?.cache_write_tokens,
      outputTokens: data.usage?.output_tokens,
      reasoningTokens: data.usage?.output_tokens_details?.reasoning_tokens,
    };
    let cost;
    try {
      cost = costFromUsage(model, usage, data.service_tier);
      if (data.usage.total_tokens !== usage.inputTokens + usage.outputTokens) throw new RangeError('Inconsistent total.');
    } catch { throw new BenchmarkError('missing_usage', 'OpenAI did not return complete, usable token counts. We cannot price this output.', 502); }
    const output = (Array.isArray(data.output) ? data.output : [])
      .filter(item => item.type === 'message' && item.role === 'assistant')
      .flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text).join('\n');
    const refusal = data.output?.some(item => item.content?.some(part => part.type === 'refusal'));
    const complete = data.status === 'completed' && Boolean(output.trim()) && !refusal;
    return {
      model, returnedModel: data.model, usage, cost,
      pricing: pricingForUsage(model, usage.inputTokens, data.service_tier),
      settings: { reasoning: { ...payload.reasoning }, text: structuredClone(payload.text), prompt_cache_options: { ...payload.prompt_cache_options } },
      latencyMs: Math.round(performance.now() - started), output,
      complete, status: data.status,
      issue: complete ? null : data.status === 'incomplete' ? 'output_limit' : refusal ? 'refusal' : 'empty_output',
    };
  } catch (error) {
    if (signal?.aborted) throw new BenchmarkError('cancelled', 'Benchmark cancelled. A call already sent to OpenAI may still be charged.', 499);
    if (controller.signal.aborted) throw new BenchmarkError('timeout', 'OpenAI took too long. We stopped without retrying; the last call may still be charged.', 504);
    if (error instanceof BenchmarkError) throw error;
    throw new BenchmarkError('provider_error', 'Could not reach OpenAI. No automatic retry was made; a call already sent may still be charged.', 502);
  } finally {
    apiKey = '';
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
