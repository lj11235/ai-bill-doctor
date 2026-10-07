import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI } from '../lib/provider.mjs';
import { buildPlan, runBenchmark } from '../lib/benchmark.mjs';
import { BenchmarkError } from '../lib/errors.mjs';
import { DEMO_INPUT } from '../src/data.js';
import { CANDIDATES, BENCHMARK_SETTINGS, costFromUsage } from '../src/models.js';

const TEST_KEY = 'test-key-never-persist-this';
const apiUsage = (input = 1000, cached = 200, write = 300, output = 100, reasoning = 40) => ({
  input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
  output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
});
const responseData = (model, extra = {}) => ({
  model, service_tier: 'default', status: 'completed', ...structuredClone(BENCHMARK_SETTINGS), max_output_tokens: 2048,
  usage: apiUsage(),
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Actual answer from ${model}` }] }], ...extra,
});
function fixtureFetch(replies = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, ...payload });
    assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
    const data = replies[payload.model] || responseData(payload.model);
    if (data instanceof Error) throw data;
    return { ok: !data.error, status: data.statusCode || 200, json: async () => data };
  } };
}
function runWith(fake, extra = {}) {
  return runBenchmark({ input: DEMO_INPUT, approvedMaxCost: buildPlan(extra.input || DEMO_INPUT).maxCost, apiKey: TEST_KEY, provider: args => callOpenAI({ ...args, fetchImpl: fake.fetchImpl }), ...extra });
}

test('real provider adapter reads API usage/output and sends only fixed text-only request options', async () => {
  const fake = fixtureFetch();
  const result = await callOpenAI({ model: 'gpt-6-astra', input: { ...DEMO_INPUT, response: 'Never send original', tools: [{ type: 'web_search' }] }, apiKey: TEST_KEY, fetchImpl: fake.fetchImpl });
  assert.equal(result.usage.inputTokens, 1000);
  assert.equal(result.usage.cachedInputTokens, 200);
  assert.equal(result.usage.outputTokens, 100);
  assert.equal(result.usage.cacheWriteTokens, 300);
  assert.equal(result.usage.reasoningTokens, 40);
  assert.equal(result.cost, .01395);
  assert.equal(result.pricing.contextBand, 'short');
  assert.deepEqual(result.settings, BENCHMARK_SETTINGS);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.complete, true);
  assert.equal(fake.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(fake.calls[0].store, false);
  assert.equal(fake.calls[0].service_tier, 'default');
  assert.equal(fake.calls[0].truncation, 'disabled');
  assert.equal(fake.calls[0].max_output_tokens, 2048);
  assert.deepEqual(fake.calls[0].tools, []);
  assert.doesNotMatch(JSON.stringify(fake.calls), /Never send original/);
});

test('benchmark preserves configured review order even when the later candidate costs less', async () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const fake = fixtureFetch();
    const events = [];
    const result = await runWith(fake, { input: { ...DEMO_INPUT, model }, emit: e => events.push(e) });
    assert.deepEqual(fake.calls.map(c => c.model), [model, ...CANDIDATES[model]]);
    assert.deepEqual(result.candidates.map(c => c.model), CANDIDATES[model]);
    if (model === 'gpt-6-astra') {
      assert.ok(result.candidates[0].cost > result.candidates[1].cost);
      assert.ok(result.candidates[0].reduction < result.candidates[1].reduction);
    }
    assert.equal(events.filter(e => e.state === 'complete').length, 1 + CANDIDATES[model].length);
    assert.equal(result.baseline.outputSource, 'benchmark');
    assert.doesNotMatch(JSON.stringify({ result, events }), new RegExp(TEST_KEY));
  }
});

test('pasted original is displayed; one replay measures its baseline and preserves that replay output', async () => {
  const fake = fixtureFetch();
  const result = await runWith(fake, { input: { ...DEMO_INPUT, response: 'My historical answer' } });
  assert.equal(result.baseline.displayOutput, 'My historical answer');
  assert.equal(result.baseline.outputSource, 'pasted');
  assert.equal(result.baseline.output, 'Actual answer from gpt-6-astra');
  assert.equal(fake.calls.filter(c => c.model === 'gpt-6-astra').length, 1);
});

test('large benchmarks make zero calls without approval; the exact approved bound permits the run', async () => {
  const fake = fixtureFetch();
  const input = { ...DEMO_INPUT, request: 'x'.repeat(5000) };
  await assert.rejects(runWith(fake, { input, approvedMaxCost: undefined }), { code: 'budget_confirmation' });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(runWith(fake, { input, approvedMaxCost: .01 }), { code: 'budget_confirmation' });
  await runWith(fake, { input, approvedMaxCost: buildPlan(input).maxCost });
  assert.equal(fake.calls.length, 3);
});

test('unsupported model and malformed key fail before provider calls', async () => {
  const fake = fixtureFetch();
  await assert.rejects(runWith(fake, { apiKey: '\nnot-a-key' }), { code: 'invalid_key' });
  await assert.rejects(async () => runWith(fake, { input: { ...DEMO_INPUT, model: 'unknown' } }), { code: 'unsupported_model' });
  assert.equal(fake.calls.length, 0);
});

test('one unavailable candidate does not kill the next candidate', async () => {
  const fake = fixtureFetch({ 'gpt-6.1-sol': { statusCode: 404, error: { code: 'model_not_found', message: TEST_KEY } } });
  const result = await runWith(fake);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].model, 'gpt-6-luna');
  assert.equal(result.failures[0].code, 'model_unavailable');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
});

test('provider errors are safe and make no automatic retries', async () => {
  for (const [statusCode, code, expected] of [[401, 'bad', 'invalid_key'], [403, 'bad', 'model_unavailable'], [400, 'context_length_exceeded', 'context_too_long'], [429, 'insufficient_quota', 'quota'], [429, 'rate_limit_exceeded', 'rate_limit'], [500, 'bad', 'provider_error']]) {
    const fake = fixtureFetch({ 'gpt-6-astra': { statusCode, error: { code, message: TEST_KEY } } });
    await assert.rejects(runWith(fake), error => error.code === expected && !error.message.includes(TEST_KEY));
    assert.equal(fake.calls.length, 1);
  }
});

test('ambiguous transport failure stops later spending and never leaks an exception', async () => {
  const fake = fixtureFetch({ 'gpt-6.1-sol': new Error(TEST_KEY) });
  const result = await runWith(fake);
  assert.equal(fake.calls.length, 2);
  assert.equal(result.costMayBeIncomplete, true);
  assert.equal(result.candidates.length, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
});

test('completed answers using more than 1,024 reasoning/output tokens remain comparable', async () => {
  const fake = fixtureFetch(Object.fromEntries(['gpt-6-astra', ...CANDIDATES['gpt-6-astra']].map(model => [
    model, responseData(model, { usage: apiUsage(1000, 200, 300, 1800, 1400) }),
  ])));
  const result = await runWith(fake);
  assert.deepEqual(result.candidates.map(c => c.model), CANDIDATES['gpt-6-astra']);
  assert.deepEqual(result.measured.map(c => c.cost), [.09895, .01977, .0009895]);
  assert.ok(result.measuredBenchmarkCost < result.plan.maxCost);
  for (const call of result.measured) {
    assert.equal(call.complete, true);
    assert.equal(call.usage.outputTokens, 1800);
    assert.equal(call.usage.reasoningTokens, 1400);
  }
});

test('exhausting the 2,048 cap during reasoning is priced but excluded; an incomplete baseline stops', async () => {
  const incomplete = {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [],
    usage: apiUsage(1000, 200, 300, 2048, 2048),
  };
  const fake = fixtureFetch({ 'gpt-6.1-sol': responseData('gpt-6.1-sol', incomplete) });
  const result = await runWith(fake);
  assert.equal(result.measured.length, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].model, 'gpt-6-luna');
  assert.equal(result.failures[0].code, 'output_limit');
  assert.equal(result.measured[1].cost, .02225);
  assert.equal(result.measuredBenchmarkCost, result.measured.reduce((total, call) => total + call.cost, 0));
  const badBaseline = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', incomplete) });
  await assert.rejects(runWith(badBaseline), { code: 'baseline_incomplete' });
  assert.equal(badBaseline.calls.length, 1);
});

test('missing usage, unknown returned model, unpriced tiers, and refusals never get accepted', async () => {
  for (const extra of [{ usage: null }, { model: 'unknown' }, { service_tier: 'priority' }, { usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cache_write_tokens: 3 } } }]) {
    const fake = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', extra) });
    await assert.rejects(runWith(fake));
  }
  const fake = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }) });
  await assert.rejects(runWith(fake), { code: 'baseline_incomplete' });
});

test('costlier actual outputs produce zero recommendations', async () => {
  const fake = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', { usage: apiUsage(1, 0, 0, 1, 0) }) });
  const result = await runWith(fake);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.measured.length, 3);
});

test('cancellation stops subsequent calls and timeout is handled without a retry', async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fixtureFetch();
  await assert.rejects(runWith(fake, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(fake.calls.length, 0);
  let calls = 0;
  const result = await runBenchmark({ input: DEMO_INPUT, approvedMaxCost: buildPlan(DEMO_INPUT).maxCost, apiKey: TEST_KEY, provider: async ({ model }) => {
    calls++;
    if (model === 'gpt-6-astra') return { model, complete: true, cost: .001, output: 'Baseline' };
    throw new BenchmarkError('timeout', 'Timed out.', 504);
  } });
  assert.equal(calls, 2);
  assert.equal(result.failures[0].code, 'timeout');
});

test('all comparable calls use byte-identical prompts, medium reasoning, output cap and other settings', async () => {
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    const fake = fixtureFetch();
    const input = { ...DEMO_INPUT, model, system: '  Keep exactly.\n', request: 'Real request\n' };
    await runWith(fake, { input });
    for (const { model: ignored, ...payload } of fake.calls) {
      assert.deepEqual(payload.reasoning, { effort: 'medium', mode: 'standard', context: 'current_turn' });
      assert.deepEqual(payload.input, [{ role: 'system', content: input.system }, { role: 'user', content: input.request }]);
      assert.equal(payload.max_output_tokens, 2048);
      assert.equal(payload.service_tier, 'default');
      assert.deepEqual(payload.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
      const { model: baselineModel, ...baselinePayload } = fake.calls[0];
      assert.deepEqual(payload, baselinePayload);
      assert.doesNotMatch(JSON.stringify(payload), /temperature|top_p|top_logprobs/);
    }
  }
});

test('a requested reasoning/pricing override is rejected before spending', async () => {
  const fake = fixtureFetch();
  for (const extra of [{ reasoning: { effort: 'high' } }, { reasoning: { mode: 'pro' } }, { service_tier: 'flex' }, { max_output_tokens: 500 }]) {
    await assert.rejects(runBenchmark({ input: { ...DEMO_INPUT, ...extra }, apiKey: TEST_KEY, provider: args => callOpenAI({ ...args, fetchImpl: fake.fetchImpl }) }), { code: 'unsupported_configuration' });
  }
  assert.equal(fake.calls.length, 0);
});

test('missing or mismatched returned reasoning never generates a recommendation', async () => {
  for (const reasoning of [undefined, { effort: 'none', mode: 'standard', context: 'current_turn' }, { effort: 'high', mode: 'standard', context: 'current_turn' }, { effort: 'medium', mode: 'pro', context: 'current_turn' }]) {
    const fake = fixtureFetch({ 'gpt-6-luna': responseData('gpt-6-luna', { reasoning }) });
    const result = await runWith(fake, { input: { ...DEMO_INPUT, model: 'gpt-6.1-sol' } });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.failures[0].code, 'incomparable_settings');
    const baseline = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', { reasoning }) });
    await assert.rejects(runWith(baseline), { code: 'incomparable_settings' });
    assert.equal(baseline.calls.length, 1);
  }
});

test('unsupported service tiers, usage categories and cache policies cannot yield savings', async () => {
  const extras = [
    ...['priority', 'fast', 'ultrafast', 'flex', 'batch', 'auto', 'custom', undefined].map(service_tier => ({ service_tier })),
    { usage: { ...apiUsage(), tool_cost: .01 } },
    { usage: { ...apiUsage(), input_tokens_details: { ...apiUsage().input_tokens_details, audio_tokens: 10 } } },
    { usage: { ...apiUsage(), output_tokens_details: { reasoning_tokens: 40, future_billed_tokens: 2 } } },
    { prompt_cache_options: { mode: 'implicit', ttl: '24h' } },
    { output: [{ type: 'web_search_call' }] },
  ];
  for (const extra of extras) {
    const fake = fixtureFetch({ 'gpt-6-luna': responseData('gpt-6-luna', extra) });
    const result = await runWith(fake, { input: { ...DEMO_INPUT, model: 'gpt-6.1-sol' } });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.failures[0].code, 'unsupported_pricing');
  }
});

test('missing cache/reasoning counts and inconsistent totals are never assumed to be zero', async () => {
  for (const usage of [
    { ...apiUsage(), input_tokens_details: { cached_tokens: 200 } },
    { ...apiUsage(), input_tokens_details: { cache_write_tokens: 300 } },
    { ...apiUsage(), output_tokens_details: {} },
    { ...apiUsage(), total_tokens: 999 },
  ]) {
    const fake = fixtureFetch({ 'gpt-6-luna': responseData('gpt-6-luna', { usage }) });
    const result = await runWith(fake, { input: { ...DEMO_INPUT, model: 'gpt-6.1-sol' } });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.failures[0].code, 'missing_usage');
  }
});

test('measured reduction uses actual generated usage, not the model price ratio', async () => {
  const fake = fixtureFetch({
    'gpt-6-astra': responseData('gpt-6-astra', { usage: apiUsage(1000, 0, 0, 100, 50) }),
    'gpt-6.1-sol': responseData('gpt-6.1-sol', { usage: apiUsage(1000, 0, 0, 400, 300) }),
  });
  const result = await runWith(fake);
  assert.equal(result.baseline.cost, .015);
  assert.equal(result.candidates[0].cost, .006);
  assert.ok(Math.abs(result.candidates[0].reduction - .6) < 1e-10); // 60%, not headline 80%.
  assert.notEqual(result.candidates[0].reduction, .8);
});

test('provider applies long-context pricing from actual total input usage', async () => {
  const fake = fixtureFetch({ 'gpt-6-astra': responseData('gpt-6-astra', { usage: apiUsage(272001, 1000, 1000, 1000, 800) }) });
  const result = await callOpenAI({ model: 'gpt-6-astra', input: DEMO_INPUT, apiKey: TEST_KEY, fetchImpl: fake.fetchImpl });
  assert.equal(result.pricing.contextBand, 'long');
  assert.equal(result.cost, 5.50202);
  assert.equal(result.cost, costFromUsage(result.model, result.usage));
});

test('Astra needs consent even for a small request; hard ceiling blocks all calls', async () => {
  const fake = fixtureFetch();
  await assert.rejects(runWith(fake, { approvedMaxCost: undefined }), { code: 'budget_confirmation' });
  await assert.rejects(runWith(fake, { approvedMaxCost: .251 }), { code: 'budget_confirmation' });
  await assert.rejects(runBenchmark({ input: { ...DEMO_INPUT, request: 'x'.repeat(30000) }, apiKey: TEST_KEY, approvedMaxCost: .25, provider: args => callOpenAI({ ...args, fetchImpl: fake.fetchImpl }) }), { code: 'budget_limit' });
  assert.equal(fake.calls.length, 0);
});
