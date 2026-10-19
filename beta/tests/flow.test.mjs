import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as models from '../../src/models.js';
import * as data from '../../src/data.js';
import { buildPlan } from '../../lib/benchmark.mjs';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(
  /^import .*;\n/gm,
  '',
);
function fixture() {
  const call = (model, cost, output) => ({
    model,
    returnedModel: model,
    cost,
    output,
    complete: true,
    latencyMs: 100,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
    },
    pricing: models.pricingForUsage(model, 100),
    settings: structuredClone(models.BENCHMARK_SETTINGS),
  });
  const baseline = {
    ...call('gpt-6-astra', 0.01, 'Original answer'),
    displayOutput: 'Original answer',
    outputSource: 'benchmark',
  };
  const candidates = [
    call('gpt-6.1-sol', 0.003, 'Quality-prioritized answer'),
    call('gpt-6-luna', 0.001, 'Cheapest answer'),
  ].map((c) => ({ ...c, reduction: models.costReduction(baseline.cost, c.cost) }));
  return {
    baseline,
    candidates,
    measured: [baseline, ...candidates],
    failures: [],
    plan: buildPlan(data.DEMO_INPUT),
    pricing: models.PRICING,
    measuredBenchmarkCost: 0.014,
  };
}
async function app() {
  const events = [];
  const handlers = {};
  const fields = new Map();
  const screen = {
    innerHTML: '',
    addEventListener: (name, fn) => (handlers[name] = fn),
    insertAdjacentHTML(_where, html) {
      this.innerHTML = html + this.innerHTML;
    },
  };
  const location = new URL('http://localhost/');
  const listeners = {};
  const context = vm.createContext({
    ...models,
    ...data,
    structuredClone,
    Intl,
    location,
    AbortController,
    TextDecoder,
    JSON,
    Number,
    crypto: { randomUUID },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelector: (selector) => {
        if (selector === '#root') return screen;
        if (!fields.has(selector))
          fields.set(selector, { textContent: '', isConnected: true, focus() {} });
        return fields.get(selector);
      },
    },
    window: { addEventListener: (name, fn) => (listeners[name] = fn), scrollTo() {} },
    history: { replaceState: (_a, _b, hash) => (location.hash = hash) },
    fetch: async (url, options) => {
      if (url === '/api/config')
        return { ok: true, json: async () => ({ mode: 'demo', csrf: 'test-csrf', siteKey: '' }) };
      assert.equal(url, '/api/events');
      events.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  vm.runInContext(source, context);
  await vm.runInContext('configPromise', context);
  await Promise.resolve();
  return {
    get html() {
      return screen.innerHTML;
    },
    get hash() {
      return location.hash;
    },
    events,
    run: (code) => vm.runInContext(code, context),
    show() {
      context.fixture = fixture();
      vm.runInContext(
        "input=structuredClone(DEMO_INPUT);submitted=structuredClone(input);benchmark=fixture;activeRunId=crypto.randomUUID();location.hash='#results';render();",
        context,
      );
    },
    change: () => listeners.hashchange(),
    click: (action) =>
      handlers.click({ target: { closest: () => ({ dataset: { action }, disabled: false }) } }),
  };
}
test('anonymous beta retains approved landing and input, with no API-key or payment field', async () => {
  const ui = await app();
  assert.match(ui.html, /Cut your/);
  assert.match(ui.html, /\$29\/month/);
  assert.match(ui.html, /No payment collected/);
  ui.run("location.hash='#input'");
  ui.change();
  assert.match(ui.html, /Current model/);
  assert.match(ui.html, /id="turnstile"/);
  assert.doesNotMatch(ui.html, /type="password"|apiKey|card number/i);
});
test('review shows Sol first and only exposes Luna after rejection; rejection does not accept either output', async () => {
  const ui = await app();
  ui.show();
  assert.match(ui.html, /Quality-prioritized answer/);
  assert.doesNotMatch(ui.html, /Cheapest answer/);
  ui.run("location.hash='#estimate'");
  ui.change();
  assert.equal(ui.hash, '#results');
  ui.run('tryNextCandidate()');
  ui.change();
  assert.match(ui.html, /Cheapest answer/);
  assert.equal(ui.run('acceptedIndex'), null);
  ui.run('tryNextCandidate()');
  ui.change();
  assert.match(ui.html, /No change recommended/);
  assert.equal(ui.run('acceptedIndex'), null);
  await new Promise(setImmediate);
  assert.equal(ui.events.filter((e) => e.name === 'candidate_rejected').length, 2);
});
test('only acceptance unlocks estimated monthly/yearly savings and preserves transparent disclosure', async () => {
  const ui = await app();
  ui.show();
  ui.run('acceptCandidate()');
  ui.change();
  assert.equal(ui.hash, '#estimate');
  ui.run("spending={monthlySpend:'1000',share:WORKLOAD_SHARES[1].id};saveEstimate()");
  ui.change();
  assert.equal(ui.hash, '#savings');
  assert.match(ui.html, /~\$350/);
  assert.match(ui.html, /~\$4,200/);
  assert.match(ui.html, /estimated savings opportunity/);
  assert.match(ui.html, /Future savings are not guaranteed/);
  assert.match(
    ui.html,
    /differences in model token pricing and differences in the actual number of output tokens/,
  );
  assert.match(ui.html, /not validated production savings/);
});
test('accept/reject and pricing-interest analytics contain only the approved fields', async () => {
  const ui = await app();
  ui.show();
  ui.run('acceptCandidate()');
  await ui.click('pricing-interest');
  await Promise.resolve();
  assert(ui.events.some((e) => e.name === 'candidate_accepted'));
  assert(ui.events.some((e) => e.name === 'pricing_interest'));
  for (const event of ui.events)
    assert(Object.keys(event).every((k) => ['id', 'name', 'runId', 'candidateIndex'].includes(k)));
  assert(!JSON.stringify(ui.events).includes(data.DEMO_INPUT.request));
});
