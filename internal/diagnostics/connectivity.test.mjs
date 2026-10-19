import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APPROVAL, plan, probe, main, hiddenLine } from './connectivity.mjs';

const TEST_KEY = 'synthetic-diagnostic-key-not-a-credential';
const originalFetch = globalThis.fetch;
// Any accidentally unmocked call fails locally, before contacting a provider.
before(() => { globalThis.fetch = () => { throw new Error('Network forbidden in mock tests.'); }; });
after(() => { globalThis.fetch = originalFetch; });
const usage = (input = 40, cached = 0, write = 0, output = 10, reasoning = 8) => ({
  input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
  output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
});
const success = (extra = {}) => ({
  model: 'gpt-6.1-sol', service_tier: 'default', status: 'completed', usage: usage(),
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], ...extra,
});
function fake(data = success(), status = 200, headers = {}) {
  let calls = 0;
  let payload;
  return {
    get calls() { return calls; }, get payload() { return payload; },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
      assert.match(options.headers['X-Client-Request-Id'], /^[a-f0-9-]{36}$/);
      payload = JSON.parse(options.body);
      return new Response(JSON.stringify(data), { status, headers });
    },
  };
}
const run = (f, extra = {}) => probe({ approval: APPROVAL, apiKey: TEST_KEY, fetchImpl: f.fetchImpl, ...extra });

function terminal(answers = []) {
  const input = new EventEmitter();
  input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {}; input.pause = () => {};
  let text = '';
  const output = { isTTY: true, write: value => {
    text += value;
    if (value.includes('(hidden') && answers.length) {
      const answer = answers.shift();
      queueMicrotask(() => input.emit('data', Buffer.from(answer)));
    }
  } };
  return { input, output, get text() { return text; } };
}

test('default CLI is a no-call preview; no environment or argument key support', () => {
  const script = fileURLToPath(new URL('connectivity.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: TEST_KEY },
  });
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).apiCalls, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout.includes(TEST_KEY), false);
  assert.equal(plan().conservativeCostEstimateUsd, .00768);
  assert.ok(plan().conservativeCostEstimateUsd < .01);
});

test('missing or wrong approval and invalid keys make zero calls', async () => {
  const f = fake();
  for (const approval of [undefined, false, true, 'yes', '']) {
    const r = await run(f, { approval });
    assert.equal(r.category, 'approval_required');
    assert.equal(r.costStatus, 'not_called');
  }
  for (const apiKey of ['', undefined, 'short', TEST_KEY + '\n', 'x'.repeat(513)]) {
    assert.equal((await run(f, { apiKey })).category, 'invalid_key_format');
  }
  assert.equal(f.calls, 0);
});

test('one approved request uses the fixed tiny prompt and bounded supported settings', async () => {
  const f = fake(success(), 200, { 'x-request-id': 'req_connectivity_123' });
  const r = await run(f);
  assert.equal(f.calls, 1);
  assert.deepEqual(f.payload, {
    model: 'gpt-6.1-sol', input: 'Reply with exactly OK.',
    reasoning: { effort: 'low', mode: 'standard', context: 'current_turn' },
    max_output_tokens: 512, service_tier: 'default',
    text: { format: { type: 'text' }, verbosity: 'low' },
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    tools: [], store: false, stream: false, background: false,
  });
  assert.equal(r.outcome, 'success');
  assert.equal(r.httpStatus, 200);
  assert.equal(r.requestId, 'req_connectivity_123');
  assert.equal(r.costUsd, .00018);
  assert.equal(r.costStatus, 'measured');
  assert.equal(r.usage.reasoningTokens, 8);
  assert.equal('output' in r, false);
});

test('cost uses actual ordinary, cached, write and output tokens; reasoning billed once', async () => {
  const f = fake(success({ usage: usage(100, 20, 30, 40, 32) }));
  const r = await run(f);
  assert.equal(r.costUsd, (50 * 2 + 20 * .1 + 30 * 2.5 + 40 * 10) / 1e6);
  const ceiling = await run(fake(success({ usage: usage(1024, 0, 1024, 512, 500) })));
  assert.equal(ceiling.costUsd, plan().conservativeCostEstimateUsd);
});

test('billing, access, quota, throttling and provider errors stay distinct without retries', async () => {
  for (const [status, code, type, category] of [
    [429, 'credit_balance_exhausted', 'insufficient_quota', 'billing_credit_balance'],
    [429, 'project_spend_limit_exceeded', 'insufficient_quota', 'billing_project_limit'],
    [429, 'organization_spend_limit_exceeded', 'insufficient_quota', 'billing_organization_limit'],
    [429, 'organization_usage_limit_exceeded', 'insufficient_quota', 'organization_usage_limit'],
    [429, 'insufficient_quota', 'insufficient_quota', 'billing_or_quota'],
    [429, null, 'insufficient_quota', 'billing_or_quota'],
    [429, 'rate_limit_exceeded', 'rate_limit_error', 'rate_limit'],
    [429, 'slow_down', 'rate_limit_error', 'rate_limit_ramp'],
    [429, null, null, 'unclassified_429'],
    [401, 'invalid_api_key', 'authentication_error', 'authentication'],
    [403, null, null, 'permission_or_region'],
    [404, 'model_not_found', 'invalid_request_error', 'model_unavailable_or_no_access'],
    [400, 'unsupported_value', 'invalid_request_error', 'request_rejected'],
    [503, 'server_is_overloaded', 'service_unavailable_error', 'provider_overloaded'],
    [500, null, null, 'provider_error'],
  ]) {
    const f = fake({ error: { code, type, message: `Raw secret ${TEST_KEY}` } }, status);
    const r = await run(f);
    assert.equal(r.category, category);
    assert.equal(r.errorCode, code);
    assert.equal(r.errorType, type);
    assert.equal(r.httpStatus, status);
    assert.equal(r.costUsd, null);
    assert.equal(r.costStatus, 'unknown');
    assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
    assert.equal(f.calls, 1);
  }
});

test('rate-limit headers are preserved without claiming they prove RPM versus TPM', async () => {
  const headers = { 'retry-after': '2', 'x-request-id': 'req_safe',
    'x-ratelimit-limit-requests': '5000', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1.5s',
    'x-ratelimit-limit-tokens': '1000000', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6m0s',
    'x-ratelimit-limit-project-tokens': '60000', 'x-ratelimit-remaining-project-tokens': '0', 'x-ratelimit-reset-project-tokens': '3s' };
  const r = await run(fake({ error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } }, 429, headers));
  const { 'x-request-id': id, ...rateHeaders } = headers;
  assert.equal(r.requestId, id);
  assert.deepEqual(r.rateLimitHeaders, rateHeaders);
  assert.equal(r.category, 'rate_limit');
});

test('reflected credentials, arbitrary headers, raw output and exception details never escape', async () => {
  const headers = { authorization: TEST_KEY, 'set-cookie': TEST_KEY, 'openai-organization': TEST_KEY,
    'x-request-id': `req_${TEST_KEY}`, 'x-ratelimit-reset-tokens': TEST_KEY, 'retry-after': TEST_KEY };
  const data = success({
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEST_KEY }] }],
  });
  const r = await run(fake(data, 200, headers));
  assert.equal(r.outcome, 'success');
  assert.equal(r.requestId, null);
  assert.deepEqual(r.rateLimitHeaders, {});
  assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
  const error = await run(fake({ error: { code: TEST_KEY, type: TEST_KEY, message: TEST_KEY } }, 400, headers));
  assert.equal(error.errorCode, null); assert.equal(error.errorType, null);
  assert.equal(JSON.stringify(error).includes(TEST_KEY), false);
  let calls = 0;
  const failure = await probe({ approval: APPROVAL, apiKey: TEST_KEY, fetchImpl: async () => {
    calls++; throw new Error(`Authorization: Bearer ${TEST_KEY}`);
  } });
  assert.equal(failure.category, 'network_or_transport');
  assert.equal(failure.costUsd, null);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(failure).includes(TEST_KEY), false);
});

test('redirects are reported without following Location or retrying', async () => {
  const f = fake({}, 307, { location: 'https://example.invalid/credential-trap', 'x-request-id': 'req_redirect' });
  const r = await run(f);
  assert.equal(r.category, 'redirect_blocked');
  assert.equal(r.httpStatus, 307); assert.equal(r.requestId, 'req_redirect');
  assert.equal(f.calls, 1);
});

test('timeout makes one attempt and keeps charges unknown', async () => {
  let calls = 0;
  const r = await probe({ approval: APPROVAL, apiKey: TEST_KEY, timeoutMs: 5,
    fetchImpl: (_, { signal }) => new Promise((_, reject) => {
      calls++; signal.addEventListener('abort', () => reject(new Error(TEST_KEY)), { once: true });
    }),
  });
  assert.equal(calls, 1); assert.equal(r.category, 'timeout');
  assert.equal(r.httpStatus, null); assert.equal(r.costStatus, 'unknown');
  assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
});

test('unreadable bodies preserve HTTP status and safe request headers', async () => {
  for (const [status, category] of [[200, 'unreadable_response'], [401, 'authentication'], [429, 'unclassified_429']]) {
    let calls = 0;
    const r = await probe({ approval: APPROVAL, apiKey: TEST_KEY, fetchImpl: async () => {
      calls++; return new Response(TEST_KEY, { status, headers: { 'x-request-id': 'req_unreadable' } });
    } });
    assert.equal(r.category, category); assert.equal(r.httpStatus, status);
    assert.equal(r.requestId, 'req_unreadable'); assert.equal(calls, 1);
    assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
  }
});

test('timeout while reading the body preserves received HTTP metadata and does not retry', async () => {
  let calls = 0;
  const r = await probe({ approval: APPROVAL, apiKey: TEST_KEY, timeoutMs: 5,
    fetchImpl: async (_, { signal }) => {
      calls++;
      return { status: 200, ok: true, headers: new Headers({ 'x-request-id': 'req_body_timeout' }),
        json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(TEST_KEY)), { once: true })),
      };
    },
  });
  assert.equal(r.category, 'timeout'); assert.equal(r.httpStatus, 200);
  assert.equal(r.requestId, 'req_body_timeout'); assert.equal(r.costStatus, 'unknown');
  assert.equal(calls, 1); assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
});

test('an HTTP 200 failed response retains available measured usage alongside its safe error', async () => {
  const f = fake(success({ status: 'failed', output: [], error: { code: 'server_error', message: TEST_KEY } }));
  const r = await run(f);
  assert.equal(r.outcome, 'failed'); assert.equal(r.errorCode, 'server_error');
  assert.equal(r.category, 'provider_response_failed'); assert.equal(r.costUsd, .00018);
  assert.equal(r.costStatus, 'measured'); assert.equal(f.calls, 1);
  assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
});

test('incomplete, refusal and empty outputs do not report success; measured charges remain', async () => {
  for (const [extra, category] of [
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'output_limit'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'incomplete_response'],
    [{ output: [] }, 'empty_output'],
    [{ status: 'failed', output: [] }, 'provider_response_failed'],
    [{ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: TEST_KEY }] }] }, 'refusal'],
  ]) {
    const f = fake(success(extra)); const r = await run(f);
    assert.equal(r.outcome, 'failed'); assert.equal(r.category, category);
    assert.equal(r.costStatus, 'measured'); assert.equal(r.costUsd, .00018);
    assert.equal(f.calls, 1);
  }
});

test('missing or inconsistent usage never becomes a zero-dollar success', async () => {
  for (const raw of [null, {}, usage(-1), usage(1, 2), usage(1, 0, 2), usage(1, 0, 0, 1, 2),
    { ...usage(), total_tokens: 999 }, { ...usage(), output_tokens: TEST_KEY },
    { ...usage(), input_tokens_details: { cached_tokens: 0 } }]) {
    const r = await run(fake(success({ usage: raw })));
    assert.equal(r.category, 'missing_or_invalid_usage');
    assert.equal(r.usage, null); assert.equal(r.costUsd, null);
    assert.equal(JSON.stringify(r).includes(TEST_KEY), false);
  }
});

test('unknown models, tiers, cache TTLs, long contexts and new billing fields suppress cost', async () => {
  for (const extra of [
    { model: 'other-model' }, { service_tier: 'priority' }, { service_tier: undefined },
    { reasoning: { mode: 'pro' } }, { prompt_cache_options: { mode: 'implicit', ttl: '24h' } },
    { usage: usage(272001) }, { usage: usage(1, 0, 0, 513) },
    { usage: { ...usage(), new_billable_tokens: 1 } },
    { usage: { ...usage(), input_tokens_details: { ...usage().input_tokens_details, new_tokens: 1 } } },
    { usage: { ...usage(), output_tokens_details: { reasoning_tokens: 8, new_tokens: 1 } } },
    { output: [{ type: 'web_search_call' }] },
  ]) {
    const r = await run(fake(success(extra)));
    assert.equal(r.category, 'unsupported_pricing'); assert.equal(r.costUsd, null);
    assert.equal(r.costStatus, 'unknown');
  }
});

test('hidden entry supports backspace, never echoes, and restores raw mode/listeners', async () => {
  const t = terminal();
  const pending = hiddenLine('Key (hidden): ', t.input, t.output);
  assert.equal(t.input.isRaw, true);
  t.input.emit('data', Buffer.from(TEST_KEY + 'x\x7f\r'));
  assert.equal(await pending, TEST_KEY);
  assert.equal(t.text.includes(TEST_KEY), false);
  assert.equal(t.input.isRaw, false);
  for (const name of ['data', 'end', 'error']) assert.equal(t.input.listenerCount(name), 0);
});

test('hidden entry handles cancellation, EOF, stream errors and overlong input without leaking', async () => {
  for (const action of ['\x03', '\x04', '\x1a', 'x'.repeat(513), 'end', 'error']) {
    const t = terminal(); t.input.isRaw = true;
    const pending = hiddenLine('Key (hidden): ', t.input, t.output);
    if (action === 'end' || action === 'error') t.input.emit(action, new Error(TEST_KEY));
    else t.input.emit('data', Buffer.from(action));
    await assert.rejects(pending, { message: 'Entry cancelled.' });
    assert.equal(t.input.isRaw, true); assert.equal(t.text.includes(TEST_KEY), false);
    for (const name of ['data', 'end', 'error']) assert.equal(t.input.listenerCount(name), 0);
  }
});

test('CLI refuses unapproved, piped, malformed and cancelled runs before fetching', async () => {
  const f = fake();
  for (const [args, answers, tty] of [
    [['--paid'], ['no\r'], true], [['--paid'], [APPROVAL + '\r', '\x03'], true],
    [['--paid'], [], false], [['--paid', TEST_KEY], [], true], [['--api-key', TEST_KEY], [], true],
  ]) {
    const t = terminal(answers); t.input.isTTY = tty;
    assert.equal(await main(args, { ...t, fetchImpl: f.fetchImpl }), 1);
    assert.equal(t.text.includes(TEST_KEY), false);
  }
  assert.equal(f.calls, 0);
});

test('full approved CLI path uses a hidden key once and prints only sanitized diagnostics', async () => {
  const t = terminal([APPROVAL + '\r', TEST_KEY + '\r']); const f = fake();
  assert.equal(await main(['--paid'], { ...t, fetchImpl: f.fetchImpl }), 0);
  assert.equal(f.calls, 1); assert.equal(t.input.isRaw, false);
  assert.match(t.text, /"outcome": "success"/);
  assert.match(t.text, /"costUsd": 0.00018/);
  assert.equal(t.text.includes(TEST_KEY), false);
  assert.equal(t.text.includes('Authorization'), false);
});
