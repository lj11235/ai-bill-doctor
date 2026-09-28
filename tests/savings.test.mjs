import test from 'node:test';
import assert from 'node:assert/strict';
import { costFromUsage, costReduction, CANDIDATES, MODELS, LIMITS } from '../src/models.js';
import { calculateSavings, makeSetup, requestPayload, DEMO_INPUT } from '../src/data.js';
import { buildPlan, getReviewCandidates, validateInput } from '../lib/benchmark.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('cost uses uncached input, cached input, and output once each', () => {
  close(costFromUsage('gpt-4o', { inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 300 }), .00675);
  close(costFromUsage('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 100 }), .00056);
  for (const usage of [{ inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 }, { inputTokens: 1.5, outputTokens: 1 }, { inputTokens: NaN, outputTokens: 1 }, { inputTokens: 1, outputTokens: -1 }]) assert.throws(() => costFromUsage('gpt-4o', usage));
  assert.throws(() => costFromUsage('invented', { inputTokens: 1, outputTokens: 1 }));
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
    for (const id of ids) for (const rate of ['input', 'cached', 'output']) assert.ok(MODELS[id][rate] < MODELS[model][rate]);
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
  const candidate = { model: 'gpt-4o-mini' };
  const payload = JSON.parse(makeSetup(input, candidate));
  assert.equal(payload.input[0].content, input.system);
  assert.equal(payload.input[1].content, input.request);
  assert.deepEqual(payload, requestPayload(input, candidate.model));
  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 1024);
  assert.equal(makeSetup(input, candidate, 'model'), candidate.model);
  assert.doesNotMatch(makeSetup(input, candidate, 'codex'), /not-for-copying/);
  assert.match(makeSetup(input, candidate, 'cursor'), /Keep the request and system instructions unchanged/);
});

test('preflight is conservative, counts UTF-8 bytes, excludes pasted response, and gates large requests', () => {
  const plan = buildPlan(DEMO_INPUT);
  assert.equal(plan.calls.length, 3);
  assert.ok(plan.maxCost < .05);
  assert.equal(plan.requiresConfirmation, false);
  assert.equal(buildPlan({ ...DEMO_INPUT, response: 'x'.repeat(50000) }).maxCost, plan.maxCost);
  assert.equal(buildPlan({ ...DEMO_INPUT, system: '', request: '你好' }).inputTokenBound, 518);
  assert.equal(buildPlan({ ...DEMO_INPUT, request: 'x'.repeat(30000) }).requiresConfirmation, true);
  assert.throws(() => validateInput({ ...DEMO_INPUT, model: 'gpt-5' }), /supports/);
  assert.throws(() => buildPlan({ ...DEMO_INPUT, request: '你'.repeat(20000) }), /too large/);
  assert.throws(() => buildPlan({ ...DEMO_INPUT, model: '__proto__' }));
  assert.equal(buildPlan({ ...DEMO_INPUT, model: 'gpt-4.1-mini' }).calls.length, 2);
});
