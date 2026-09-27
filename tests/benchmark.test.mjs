import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI } from '../lib/provider.mjs';
import { buildPlan, runBenchmark } from '../lib/benchmark.mjs';
import { BenchmarkError } from '../lib/errors.mjs';
import { DEMO_INPUT } from '../src/data.js';

const TEST_KEY = 'test-key-never-persist-this';
const responseData = (model, extra = {}) => ({ model, service_tier: 'default', status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Actual answer from ${model}` }] }], ...extra });
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
  return runBenchmark({ input: DEMO_INPUT, apiKey: TEST_KEY, provider: args => callOpenAI({ ...args, fetchImpl: fake.fetchImpl }), ...extra });
}

test('real provider adapter reads API usage/output and sends only fixed text-only request options', async () => {
  const fake = fixtureFetch();
  const result = await callOpenAI({ model: 'gpt-4o', input: { ...DEMO_INPUT, response: 'Never send original', tools: [{ type: 'web_search' }] }, apiKey: TEST_KEY, fetchImpl: fake.fetchImpl });
  assert.equal(result.usage.inputTokens, 1000);
  assert.equal(result.usage.cachedInputTokens, 200);
  assert.equal(result.usage.outputTokens, 100);
  assert.equal(result.cost, .00325);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.complete, true);
  assert.equal(fake.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(fake.calls[0].store, false);
  assert.equal(fake.calls[0].service_tier, 'default');
  assert.equal(fake.calls[0].truncation, 'disabled');
  assert.equal(fake.calls[0].max_output_tokens, 1024);
  assert.deepEqual(fake.calls[0].tools, []);
  assert.doesNotMatch(JSON.stringify(fake.calls), /Never send original/);
});

test('benchmark calls baseline once then configured candidates; ranks on actual cost', async () => {
  const fake = fixtureFetch();
  const events = [];
  const result = await runWith(fake, { emit: e => events.push(e) });
  assert.deepEqual(fake.calls.map(c => c.model), ['gpt-4o', 'gpt-4.1-mini', 'gpt-4o-mini']);
  assert.deepEqual(result.candidates.map(c => c.model), ['gpt-4o-mini', 'gpt-4.1-mini']);
  assert.equal(events.filter(e => e.state === 'complete').length, 3);
  assert.equal(result.baseline.outputSource, 'benchmark');
  assert.doesNotMatch(JSON.stringify({ result, events }), new RegExp(TEST_KEY));
});

test('pasted original is displayed; one replay measures its baseline and preserves that replay output', async () => {
  const fake = fixtureFetch();
  const result = await runWith(fake, { input: { ...DEMO_INPUT, response: 'My historical answer' } });
  assert.equal(result.baseline.displayOutput, 'My historical answer');
  assert.equal(result.baseline.outputSource, 'pasted');
  assert.equal(result.baseline.output, 'Actual answer from gpt-4o');
  assert.equal(fake.calls.filter(c => c.model === 'gpt-4o').length, 1);
});

test('large benchmarks make zero calls without approval; the exact approved bound permits the run', async () => {
  const fake = fixtureFetch();
  const input = { ...DEMO_INPUT, request: 'x'.repeat(30000) };
  await assert.rejects(runWith(fake, { input }), { code: 'budget_confirmation' });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(runWith(fake, { input, approvedMaxCost: .01 }), { code: 'budget_confirmation' });
  await runWith(fake, { input, approvedMaxCost: buildPlan(input).maxCost });
  assert.equal(fake.calls.length, 3);
});

test('unsupported model and malformed key fail before provider calls', async () => {
  const fake = fixtureFetch();
  await assert.rejects(runWith(fake, { apiKey: '\nnot-a-key' }), { code: 'invalid_key' });
  await assert.rejects(runWith(fake, { input: { ...DEMO_INPUT, model: 'unknown' } }), { code: 'unsupported_model' });
  assert.equal(fake.calls.length, 0);
});

test('one unavailable candidate does not kill the next candidate', async () => {
  const fake = fixtureFetch({ 'gpt-4.1-mini': { statusCode: 404, error: { code: 'model_not_found', message: TEST_KEY } } });
  const result = await runWith(fake);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].model, 'gpt-4o-mini');
  assert.equal(result.failures[0].code, 'model_unavailable');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
});

test('provider errors are safe and make no automatic retries', async () => {
  for (const [statusCode, code, expected] of [[401, 'bad', 'invalid_key'], [403, 'bad', 'model_unavailable'], [400, 'context_length_exceeded', 'context_too_long'], [429, 'insufficient_quota', 'quota'], [429, 'rate_limit_exceeded', 'rate_limit'], [500, 'bad', 'provider_error']]) {
    const fake = fixtureFetch({ 'gpt-4o': { statusCode, error: { code, message: TEST_KEY } } });
    await assert.rejects(runWith(fake), error => error.code === expected && !error.message.includes(TEST_KEY));
    assert.equal(fake.calls.length, 1);
  }
});

test('ambiguous transport failure stops later spending and never leaks an exception', async () => {
  const fake = fixtureFetch({ 'gpt-4.1-mini': new Error(TEST_KEY) });
  const result = await runWith(fake);
  assert.equal(fake.calls.length, 2);
  assert.equal(result.costMayBeIncomplete, true);
  assert.equal(result.candidates.length, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
});

test('truncated candidates are priced but excluded; truncated baseline stops immediately', async () => {
  const fake = fixtureFetch({ 'gpt-4.1-mini': responseData('gpt-4.1-mini', { status: 'incomplete' }) });
  const result = await runWith(fake);
  assert.equal(result.measured.length, 3);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.failures[0].code, 'output_limit');
  const badBaseline = fixtureFetch({ 'gpt-4o': responseData('gpt-4o', { status: 'incomplete' }) });
  await assert.rejects(runWith(badBaseline), { code: 'baseline_incomplete' });
  assert.equal(badBaseline.calls.length, 1);
});

test('missing usage, unknown returned model, unpriced tiers, and refusals never get accepted', async () => {
  for (const extra of [{ usage: null }, { model: 'unknown' }, { service_tier: 'priority' }, { usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cache_write_tokens: 3 } } }]) {
    const fake = fixtureFetch({ 'gpt-4o': responseData('gpt-4o', extra) });
    await assert.rejects(runWith(fake));
  }
  const fake = fixtureFetch({ 'gpt-4o': responseData('gpt-4o', { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] }) });
  await assert.rejects(runWith(fake), { code: 'baseline_incomplete' });
});

test('costlier actual outputs produce zero recommendations', async () => {
  const fake = fixtureFetch({ 'gpt-4o': responseData('gpt-4o', { usage: { input_tokens: 1, output_tokens: 1 } }) });
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
  const result = await runBenchmark({ input: DEMO_INPUT, apiKey: TEST_KEY, provider: async ({ model }) => {
    calls++;
    if (model === 'gpt-4o') return { model, complete: true, cost: .001, output: 'Baseline' };
    throw new BenchmarkError('timeout', 'Timed out.', 504);
  } });
  assert.equal(calls, 2);
  assert.equal(result.failures[0].code, 'timeout');
});
