import { MODELS, LIMITS, costFromUsage } from '../src/models.js';
import { requestPayload } from '../src/data.js';
import { BenchmarkError, providerError } from './errors.mjs';

const endpoint = 'https://api.openai.com/v1/responses';

// The only provider network call. No SDK retries, user-provided URLs, or tools.
export async function callOpenAI({ model, input, apiKey, signal, fetchImpl = fetch }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, LIMITS.timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestPayload(input, model)),
      signal: controller.signal,
      redirect: 'error',
    });
    let data;
    try { data = await response.json(); } catch { throw new BenchmarkError('provider_error', 'OpenAI returned an unreadable response. No automatic retry was made.', 502); }
    if (!response.ok) throw providerError(response.status, data?.error?.code);
    const rates = MODELS[model];
    if (!rates || (data.model !== model && !rates.snapshots.includes(data.model)) || (data.service_tier && data.service_tier !== 'default')) {
      throw new BenchmarkError('unsupported_pricing', 'OpenAI returned a model or price tier we cannot price reliably. No savings comparison was made.', 502);
    }
    if ((data.usage?.input_tokens_details?.cache_write_tokens ?? 0) !== 0) {
      throw new BenchmarkError('unsupported_pricing', 'This call includes a pricing category this V0 does not support.', 502);
    }
    const usage = {
      inputTokens: data.usage?.input_tokens,
      cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      cachedInputReported: data.usage?.input_tokens_details?.cached_tokens != null,
      outputTokens: data.usage?.output_tokens,
    };
    let cost;
    try { cost = costFromUsage(model, usage); } catch { throw new BenchmarkError('missing_usage', 'OpenAI did not return usable token counts. We cannot price this output.', 502); }
    const output = (Array.isArray(data.output) ? data.output : [])
      .filter(item => item.type === 'message' && item.role === 'assistant')
      .flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text' && typeof item.text === 'string')
      .map(item => item.text).join('\n');
    const refusal = data.output?.some(item => item.content?.some(part => part.type === 'refusal'));
    const complete = data.status === 'completed' && Boolean(output.trim()) && !refusal;
    return {
      model, returnedModel: data.model, usage, cost,
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
