import test from 'node:test';
import assert from 'node:assert/strict';
import { costFromUsage, costReduction, CANDIDATES, MODELS, LIMITS, pricingForUsage } from '../src/models.js';
import { calculateSavings, makeSetup, requestPayload, DEMO_INPUT } from '../src/data.js';
import { buildPlan, getReviewCandidates, validateInput } from '../lib/benchmark.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

const usage = (overrides = {}) => ({ inputTokens: 2000, cachedInputTokens: 1000, cacheWriteTokens: 500, outputTokens: 300, reasoningTokens: 200, ...overrides });

test('GPT-6 costs partition ordinary input, cache reads/writes, and output including reasoning once', () => {
  for (const [model, expected] of [['gpt-6-astra', .02725], ['gpt-6.1-sol', .00535], ['gpt-6-luna', .0002725]]) {
    close(costFromUsage(model, usage()), expected);
    close(costFromUsage(model, usage({ reasoningTokens: 0 })), expected);
  }
  for (const invalid of [
    { cachedInputTokens: 2001 }, { cacheWriteTokens: 1001 }, { inputTokens: 1.5 }, { inputTokens: NaN },
    { outputTokens: -1 }, { reasoningTokens: 301 }, { cachedInputTokens: undefined }, { cacheWriteTokens: undefined },
    { reasoningTokens: undefined }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => costFromUsage('gpt-6-astra', usage(invalid)));
  assert.throws(() => costFromUsage('invented', usage()));
  for (const tier of ['fast', 'priority', 'ultrafast', 'flex', 'batch', 'auto', 'custom', null]) {
    assert.throws(() => costFromUsage('gpt-6-astra', usage(), tier));
  }
});

test('long-context rates start strictly above 272,000 TOTAL input tokens and apply to the full request', () => {
  const expected = [
    ['gpt-6-astra', 2.7635, 5.50202],
    ['gpt-6.1-sol', .5526, 1.100204],
    ['gpt-6-luna', .027635, .0550202],
  ];
  for (const [model, shortCost, longCost] of expected) {
    const at = usage({ inputTokens: 272000, cachedInputTokens: 1000, cacheWriteTokens: 1000, outputTokens: 1000 });
    close(costFromUsage(model, at), shortCost);
    close(costFromUsage(model, { ...at, inputTokens: 272001 }), longCost);
    assert.equal(pricingForUsage(model, 271999).contextBand, 'short');
    assert.equal(pricingForUsage(model, 272000).contextBand, 'short');
    assert.equal(pricingForUsage(model, 272001).contextBand, 'long');
    // Cached tokens count toward the threshold even when ordinary input is tiny.
    const cached = usage({ inputTokens: 272001, cachedInputTokens: 272000, cacheWriteTokens: 0, outputTokens: 1000 });
    const rates = { 'gpt-6-astra': [20, 2, 75], 'gpt-6.1-sol': [4, .2, 15], 'gpt-6-luna': [.2, .02, .75] }[model];
    close(costFromUsage(model, cached), (rates[0] + 272000 * rates[1] + 1000 * rates[2]) / 1e6);
  }
});

test('reduction includes zero/no savings and never fabricates a positive result', () => {
  close(costReduction(.01, .002), .8);
  assert.equal(costReduction(.01, .01), 0);
  assert.equal(costReduction(.01, .02), -1);
  assert.throws(() => costReduction(0, .1));
  assert.throws(() => costReduction(.1, NaN));
});

test('monthly and annual scenarios use full precision and explicit shares', () => {
  const estimate = calculateSavings(1000, 'half', .0108, .00288);
  assert.equal(Math.round(estimate.monthly), 367);
  close(estimate.annual, 4400);
  for (const [id, share] of [['little', .25], ['half', .5], ['most', .75]]) {
    const value = calculateSavings(1000, id, .01, .002);
    close(value.monthly, 1000 * share * .8);
    close(value.annual, value.monthly * 12);
  }
  assert.equal(calculateSavings(0, 'half', .01, .002).monthly, 0);
  for (const args of [[-1, 'half', .01, .002], [1, '', .01, .002], [1, 'half', .01, .02], [NaN, 'half', .01, .002]]) assert.throws(() => calculateSavings(...args));
});

test('explicit candidates are cheaper in all published rate categories and capped', () => {
  for (const [model, ids] of Object.entries(CANDIDATES)) {
    assert.ok(ids.length <= LIMITS.maxCandidates);
    for (const id of ids) for (const band of ['short', 'long']) for (const rate of ['input', 'cached', 'cacheWrite', 'output']) assert.ok(MODELS[id].pricing[band][rate] < MODELS[model].pricing[band][rate]);
  }
});

test('review candidates preserve input order and exclude failed, equal, expensive, invalid calls', () => {
  const candidates = getReviewCandidates([
    { model: 'a', complete: true, cost: .004 }, { model: 'b', complete: true, cost: .002 },
    { model: 'c', complete: false, cost: .001 }, { model: 'd', complete: true, cost: .01 },
    { model: 'e', complete: true, cost: .02 }, { model: 'f', complete: true, cost: NaN },
  ], .01);
  assert.deepEqual(candidates.map(c => c.model), ['a', 'b']);
  assert.deepEqual(candidates.map(c => c.cost), [.004, .002]);
  close(candidates[0].reduction, .6);
  close(candidates[1].reduction, .8);
});

test('setup contains the exact unchanged prompts and tested API settings, no key', () => {
  const input = { ...DEMO_INPUT, system: '  Preserve whitespace.\n', apiKey: 'not-for-copying' };
  const candidate = { model: 'gpt-6-luna' };
  const payload = JSON.parse(makeSetup(input, candidate));
  assert.equal(payload.input[0].content, input.system);
  assert.equal(payload.input[1].content, input.request);
  assert.deepEqual(payload, requestPayload(input, candidate.model));
  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 2048);
  assert.equal(makeSetup(input, candidate, 'model'), candidate.model);
  assert.doesNotMatch(makeSetup(input, candidate, 'codex'), /not-for-copying/);
  assert.match(makeSetup(input, candidate, 'cursor'), /Keep the request and system instructions unchanged/);
});

test('preflight is conservative, counts UTF-8 bytes, excludes pasted response, and gates large requests', () => {
  const plan = buildPlan(DEMO_INPUT);
  assert.equal(plan.calls.length, 3);
  assert.ok(plan.maxCost > .05 && plan.maxCost < .25);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(LIMITS.budgetUsd, .05);
  assert.equal(LIMITS.hardBudgetUsd, .25);
  // Three full output caps plus input entirely billed as cache writes.
  close(plan.maxCost, Math.ceil((plan.inputTokenBound * 15.125 + 2048 * 60.5)) / 1e6);
  assert.equal(buildPlan({ model: 'gpt-6-astra', request: 'Hi' }).requiresConfirmation, true);
  assert.equal(buildPlan({ ...DEMO_INPUT, model: 'gpt-6.1-sol' }).requiresConfirmation, false);
  assert.throws(() => buildPlan({ ...DEMO_INPUT, request: 'x'.repeat(30000) }), { code: 'budget_limit' });
  assert.equal(buildPlan({ ...DEMO_INPUT, response: 'x'.repeat(50000) }).maxCost, plan.maxCost);
  assert.equal(buildPlan({ ...DEMO_INPUT, system: '', request: '你好' }).inputTokenBound, 518);
  assert.equal(buildPlan({ ...DEMO_INPUT, request: 'x'.repeat(5000) }).requiresConfirmation, true);
  assert.throws(() => validateInput({ ...DEMO_INPUT, model: 'gpt-5' }), /supports/);
  assert.throws(() => buildPlan({ ...DEMO_INPUT, request: '你'.repeat(20000) }), /too large/);
  assert.throws(() => buildPlan({ ...DEMO_INPUT, model: '__proto__' }));
  assert.equal(buildPlan({ ...DEMO_INPUT, model: 'gpt-6.1-sol' }).calls.length, 2);
});

test('sample reserves $0.140754 at 2,048 tokens; 4,096 would exceed the unchanged $0.25 ceiling', () => {
  const plan = buildPlan(DEMO_INPUT);
  assert.equal(plan.inputTokenBound, 1114);
  assert.equal(plan.maxOutputTokens, 2048);
  assert.deepEqual(plan.calls.map(call => call.maxCost), [.116325, .023265, .00116325]);
  assert.equal(plan.maxCost, .140754);
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(buildPlan({ ...DEMO_INPUT, model: 'gpt-6.1-sol' }).maxCost, .024429);

  const costsAt4096 = plan.calls.map(({ model }) => costFromUsage(model, usage({
    inputTokens: plan.inputTokenBound, cachedInputTokens: 0, cacheWriteTokens: plan.inputTokenBound,
    outputTokens: 4096, reasoningTokens: 0,
  })));
  assert.deepEqual(costsAt4096, [.218725, .043745, .00218725]);
  const totalAt4096 = Math.ceil(costsAt4096.reduce((total, cost) => total + cost, 0) * 1e6) / 1e6;
  assert.equal(totalAt4096, .264658);
  assert.ok(totalAt4096 > LIMITS.hardBudgetUsd);
});
