import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as models from '../src/models.js';
import * as data from '../src/data.js';
import { buildPlan } from '../lib/benchmark.mjs';

const source = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const call = (model, cost, output) => ({ model, returnedModel: model, cost, output, complete: true, usage: { inputTokens: 1000, cachedInputTokens: 0, cachedInputReported: true, outputTokens: 100 }, latencyMs: 1200 });
function resultFixture() {
  const baseline = { ...call('gpt-4o', .0108, 'Baseline output'), displayOutput: 'Baseline output', outputSource: 'benchmark' };
  const candidates = [call('gpt-4.1-mini', .00351, 'First configured answer'), call('gpt-4o-mini', .00288, 'Cheaper fallback answer')].map(c => ({ ...c, reduction: models.costReduction(baseline.cost, c.cost) }));
  return { baseline, candidates, measured: [baseline, ...candidates], failures: [], plan: buildPlan(data.DEMO_INPUT), pricing: models.PRICING, measuredBenchmarkCost: .01719 };
}
function app(initialHash = '', fetchImpl = async () => { throw new Error('Unexpected network call'); }) {
  const handlers = {};
  const screen = { innerHTML: '', addEventListener: (name, handler) => { handlers[name] = handler; } };
  const listeners = {};
  const fields = new Map();
  const location = new URL(`http://localhost/${initialHash}`);
  const element = () => ({ value: '', innerHTML: '', textContent: '', checked: false, isConnected: true, focus() {}, setAttribute() {} });
  const context = vm.createContext({
    ...models, ...data, structuredClone, Intl, location, AbortController, TextDecoder,
    fetch: fetchImpl, JSON, Number,
    document: { querySelector: selector => { if (selector === '#root') return screen; if (!fields.has(selector)) fields.set(selector, element()); return fields.get(selector); } },
    window: { addEventListener: (name, handler) => { listeners[name] = handler; }, scrollTo() {} },
    history: { replaceState: (_, __, hash) => { location.hash = hash; } },
  });
  vm.runInContext(source, context);
  return {
    get html() { return screen.innerHTML; },
    get hash() { return location.hash; },
    run: code => vm.runInContext(code, context),
    change: () => listeners.hashchange(),
    event: name => listeners[name]({ persisted: true }),
    field: selector => context.document.querySelector(selector),
    showResult(result = resultFixture()) {
      context.fixture = result;
      vm.runInContext("input = structuredClone(DEMO_INPUT); submitted = structuredClone(input); benchmark = fixture; location.hash = '#results'; render();", context);
    },
  };
}

test('approved landing stays intact and input adds only the key as a requirement', () => {
  const ui = app();
  assert.match(ui.html, /Cut your/);
  assert.doesNotMatch(ui.html, /73%|367|Mock preview/);
  ui.run("location.hash = '#input'"); ui.change();
  assert.equal((ui.html.match(/\brequired\b/g) || []).length, 3);
  assert.match(ui.html, /Used only to run this benchmark. Not stored./);
  assert.match(ui.html, /type="password"/);
  assert.doesNotMatch(ui.html, /monthlySpend|feature description|Example 2/);
});

test('review starts with the configured first candidate and reveals the cheaper fallback only after rejection', () => {
  const ui = app(); ui.showResult();
  assert.match(ui.html, /68%<\/span> cheaper/);
  assert.match(ui.html, /First configured answer/);
  assert.doesNotMatch(ui.html, /Cheaper fallback answer/);
  ui.run("location.hash = '#estimate'"); ui.change();
  assert.equal(ui.hash, '#results');
  ui.run('tryNextCandidate()');
  assert.match(ui.html, /Cheaper fallback answer/);
  assert.doesNotMatch(ui.html, /First configured answer/);
  assert.match(ui.html, /73%<\/span> cheaper/);
  assert.equal(ui.run('acceptedIndex'), null);
  ui.run('tryNextCandidate()');
  assert.match(ui.html, /Your current model may be worth the extra cost/);
  assert.match(ui.html, /No change recommended/);
  assert.doesNotMatch(ui.html, /data-action="accept"|<span>73%/);
  ui.run('acceptCandidate()'); assert.equal(ui.run('acceptedIndex'), null);
});

test('accepted candidate controls exact monthly/annual math and copied model', () => {
  for (const [index, monthly, annual, model] of [[0, '338', '4,050', 'gpt-4.1-mini'], [1, '367', '4,400', 'gpt-4o-mini']]) {
    const ui = app(); ui.showResult();
    if (index) ui.run('tryNextCandidate()');
    ui.run('acceptCandidate()'); ui.change();
    assert.match(ui.html, /What's your monthly AI bill/);
    ui.run("spending = {monthlySpend: '1000', share: 'half'}; saveEstimate()"); ui.change();
    assert.ok(ui.html.includes(`~$${monthly}<small>/month`));
    assert.ok(ui.html.includes(`~$${annual}<span>/year`));
    assert.ok(ui.html.includes(`<code>${model}</code>`));
    assert.match(ui.html, /Keep your prompt as it is/);
    assert.match(ui.html, /not validated production savings/);
    assert.doesNotMatch(ui.html, /mock sample|Shorter prompt/);
  }
});

test('results and savings disclose both token pricing and actual output length in the reduction', () => {
  const ui = app(); ui.showResult();
  const disclosure = /includes both differences in model token pricing and differences in the actual number of output tokens generated in this sample/;
  assert.match(ui.html, disclosure);
  assert.match(ui.html, /preset order, chosen to prioritize likely quality/);
  assert.doesNotMatch(ui.html, /ordered by measured sample cost/);
  ui.run('acceptCandidate()'); ui.change();
  ui.run("spending = {monthlySpend: '1000', share: 'half'}; saveEstimate()"); ui.change();
  assert.match(ui.html, disclosure);
});

test('provider output is escaped and a pasted baseline is clearly distinguished from measured replay', () => {
  const result = resultFixture();
  result.candidates[0].output = '<img src=x onerror=alert(1)>';
  result.baseline.outputSource = 'pasted';
  result.baseline.displayOutput = 'Original user answer';
  const ui = app(); ui.showResult(result);
  assert.match(ui.html, /&lt;img src=x/);
  assert.doesNotMatch(ui.html, /<img src=x/);
  assert.match(ui.html, /current cost measured on a fresh replay/);
  assert.match(ui.html, /See the baseline answer we measured/);
});

test('no cheaper output and failed alternatives have honest terminal states', () => {
  const result = resultFixture(); result.candidates = [];
  const ui = app(); ui.showResult(result);
  assert.match(ui.html, /No cheaper result this time/);
  assert.doesNotMatch(ui.html, /data-action="accept"/);
  result.measured = [result.baseline];
  result.failures = [{ model: 'gpt-4o-mini', message: 'Model unavailable.' }];
  ui.showResult(result);
  assert.match(ui.html, /No comparison yet/);
  assert.match(ui.html, /Model unavailable/);
});

test('refresh gates late routes and pagehide clears in-memory inputs/results/key', () => {
  for (const hash of ['#results', '#estimate', '#savings']) assert.match(app(hash).html, /id="request-form"/);
  const ui = app(); ui.showResult(); ui.field('#apiKey').value = 'private';
  ui.event('pagehide');
  assert.equal(ui.field('#apiKey').value, '');
  assert.equal(ui.run('submitted'), null);
  assert.equal(ui.run('benchmark'), null);
  assert.equal(ui.run('input.request'), '');
});

test('browser uses local POST, clears key immediately, processes fragmented progress/results, and never persists it', async () => {
  const sent = [];
  const result = resultFixture();
  const text = `${JSON.stringify({ type: 'progress', index: 0, model: 'gpt-4o', role: 'baseline', state: 'complete' })}\n${JSON.stringify({ type: 'result', result })}\n`;
  const chunks = [text.slice(0, 19), text.slice(19, 131), text.slice(131)];
  const fetchImpl = async (url, options) => {
    sent.push({ url, method: options.method, body: JSON.parse(options.body) });
    if (url === '/api/plan') return { ok: true, json: async () => buildPlan(data.DEMO_INPUT) };
    return { ok: true, body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: new TextEncoder().encode(chunks.shift()) } : { done: true } }) } };
  };
  const ui = app('#input', fetchImpl);
  ui.run('input = structuredClone(DEMO_INPUT)');
  ui.field('#apiKey').value = 'test-private-key';
  await ui.run('startAnalysis()');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, '/api/plan');
  assert.equal(sent[1].url, '/api/benchmark');
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].body.apiKey, 'test-private-key');
  assert.equal(ui.field('#apiKey').value, '');
  assert.doesNotMatch(JSON.stringify(sent[0]), /test-private-key/);
  assert.doesNotMatch(ui.run('JSON.stringify({ input, submitted, benchmark, spending, estimate })'), /test-private-key/);
  assert.equal(ui.hash, '#results');
  ui.change(); assert.match(ui.html, /First configured answer/);
  assert.doesNotMatch(ui.html, /Cheaper fallback answer/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|https:\/\/api\.openai/);
});

test('over-budget browser flow waits for explicit checkbox consent before transmitting a key', async () => {
  const sent = [];
  const longInput = { ...data.DEMO_INPUT, request: 'x'.repeat(30000) };
  const fetchImpl = async (url, options) => {
    sent.push(url);
    assert.equal(url, '/api/plan');
    assert.doesNotMatch(options.body, /test-private-key/);
    return { ok: true, json: async () => buildPlan(longInput) };
  };
  const ui = app('#input', fetchImpl);
  ui.run("input = { ...DEMO_INPUT, request: 'x'.repeat(30000) }");
  ui.field('#apiKey').value = 'test-private-key';
  await ui.run('startAnalysis()');
  assert.deepEqual(sent, ['/api/plan']);
  assert.match(ui.field('#budget-confirmation').innerHTML, /I approve up to/);
  assert.equal(ui.run('submitted'), null);
  assert.equal(ui.field('#run-button').disabled, false);
});
