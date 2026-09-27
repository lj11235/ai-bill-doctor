import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHandler } from '../server.mjs';
import { BenchmarkError } from '../lib/errors.mjs';
import { DEMO_INPUT } from '../src/data.js';
import { buildPlan } from '../lib/benchmark.mjs';

const TEST_KEY = 'test-secret-only-in-memory';
function request(body, overrides = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = '/api/benchmark'; req.socket = { localPort: 5173 };
  req.headers = { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
  return Object.assign(req, overrides);
}
class Response extends EventEmitter {
  constructor() { super(); this.chunks = []; this.headersSent = false; this.writableEnded = false; this.destroyed = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; return this; }
  flushHeaders() {}
  write(text) { this.chunks.push(text); }
  end(text) { if (text) this.chunks.push(String(text)); this.writableEnded = true; }
  get text() { return this.chunks.join(''); }
}
const successful = async ({ model }) => ({ model, returnedModel: model, output: `Answer ${model}`, complete: true, cost: model === 'gpt-4o' ? .001 : .0001, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, latencyMs: 10 });
const body = () => ({ input: { ...DEMO_INPUT }, apiKey: TEST_KEY });

test('HTTP boundary streams real handler results, with no credential in progress, response, or logs', async t => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args));
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const handler = createHandler({ provider: async args => { assert.equal(args.apiKey, TEST_KEY); return successful(args); } });
  const res = new Response(); await handler(request(body()), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Content-Type'], 'application/x-ndjson; charset=utf-8');
  const events = res.text.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'result');
  assert.doesNotMatch(res.text, new RegExp(TEST_KEY));
  assert.deepEqual(logs, []);
});

test('HTTP errors scrub raw provider exceptions and release the busy lock', async () => {
  let calls = 0;
  const handler = createHandler({ provider: async () => { calls++; throw new Error(TEST_KEY); } });
  for (let i = 0; i < 2; i++) {
    const res = new Response(); await handler(request(body()), res);
    assert.match(res.text, /provider_error/);
    assert.doesNotMatch(res.text, new RegExp(TEST_KEY));
  }
  assert.equal(calls, 2);
});

test('local server rejects foreign origins, DNS-rebinding hosts, non-JSON, and query strings before any calls', async () => {
  let calls = 0;
  const handler = createHandler({ provider: async () => { calls++; } });
  for (const overrides of [
    { headers: { host: 'localhost:5173', origin: 'https://evil.example', 'content-type': 'application/json' } },
    { headers: { host: 'evil.example:5173', origin: 'http://evil.example:5173', 'content-type': 'application/json' } },
    { headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'text/plain' } },
    { url: '/api/benchmark?apiKey=not-allowed' },
  ]) {
    const res = new Response(); await handler(request(body(), overrides), res); assert.equal(res.status, 403);
  }
  assert.equal(calls, 0);
});

test('static file allowlist never serves server code, tests, or env files; CSP keeps browser calls local', async () => {
  const handler = createHandler();
  for (const path of ['/server.mjs', '/lib/provider.mjs', '/tests/server.test.mjs', '/.env', '/src/../server.mjs']) {
    const res = new Response(); await handler(request({}, { method: 'GET', url: path }), res); assert.equal(res.status, 404);
  }
  const res = new Response(); await handler(request({}, { method: 'GET', url: '/' }), res);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Security-Policy'], /connect-src 'self'/);
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('HTTP plan never calls provider; budget is enforced again at execution', async () => {
  let calls = 0;
  const handler = createHandler({ provider: async args => { calls++; return successful(args); } });
  const input = { ...DEMO_INPUT, request: 'x'.repeat(30000) };
  const planResponse = new Response(); await handler(request({ input }, { url: '/api/plan' }), planResponse);
  assert.equal(JSON.parse(planResponse.text).requiresConfirmation, true);
  const blocked = new Response(); await handler(request({ input, apiKey: TEST_KEY }), blocked);
  assert.equal(blocked.status, 400); assert.equal(calls, 0);
  const approved = new Response(); await handler(request({ input, apiKey: TEST_KEY, approvedMaxCost: buildPlan(input).maxCost }), approved);
  assert.match(approved.text, /"type":"result"/); assert.equal(calls, 3);
});

test('only one benchmark runs at a time; disconnect aborts and releases it', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const handler = createHandler({ provider: ({ signal }) => new Promise((_, reject) => {
    started(); signal.addEventListener('abort', () => reject(new BenchmarkError('cancelled', 'Cancelled.', 499)), { once: true });
  }) });
  const first = new Response(); const pending = handler(request(body()), first); await ready;
  const second = new Response(); await handler(request(body()), second); assert.equal(second.status, 409);
  first.destroyed = true; first.emit('close'); await pending;
  const plan = new Response(); await handler(request({ input: DEMO_INPUT }, { url: '/api/plan' }), plan); assert.equal(plan.status, 200);
});

test('credential handling has no filesystem writes, persistence APIs, or provider/request logging', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const provider = await readFile(new URL('../lib/provider.mjs', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../lib/benchmark.mjs', import.meta.url), 'utf8');
  for (const source of [server, provider, runner]) assert.doesNotMatch(source, /writeFile|appendFile|localStorage|sessionStorage|indexedDB/);
  for (const source of [provider, runner]) assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(server, /console\.(?:log|error)\([^\n]*(?:apiKey|body|error\.|req\.)/);
  assert.match(server, /delete body.apiKey/);
  assert.match(provider, /apiKey = ''/);
});
