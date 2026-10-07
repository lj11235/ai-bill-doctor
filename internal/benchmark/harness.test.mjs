import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Interface } from 'node:readline/promises';
import { BENCHMARK_SETTINGS, LIMITS, CANDIDATES } from '../../src/models.js';
import { requestPayload } from '../../src/data.js';
import { callOpenAI } from '../../lib/provider.mjs';
import { BenchmarkError } from '../../lib/errors.mjs';
import { createHandler } from '../../server.mjs';
import { loadSuite, validateDefinitions, createManifest, verifyManifest, findCase, casePlan, caseInput, executeCase, observedProvider, blindView, recordHuman, reveal, grade, verifyReview, summarize, catalog, projectRoot, digest, replacementQuestion } from './runner.mjs';
import { main } from './cli.mjs';

const suite = loadSuite();
const TEST_KEY = 'synthetic-test-key-never-real';
const fixture = id => findCase(suite, id);
const expectedText = id => JSON.stringify(suite.rubrics.cases[id].expected ?? { test: 'manual review needed' });
const rawResponse = (model, output, extra = {}) => ({
  model, service_tier: 'default', status: 'completed', ...structuredClone(BENCHMARK_SETTINGS), max_output_tokens: 2048,
  usage: { input_tokens: 600, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 100 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 700 },
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }], ...extra,
});
function adapter(id, changes = {}, payloads = []) {
  return args => callOpenAI({ ...args, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); payloads.push(payload);
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${TEST_KEY}`);
    return { ok: true, status: 200, json: async () => rawResponse(payload.model, expectedText(id), changes[payload.model]) };
  } });
}
const run = (id, options = {}) => executeCase({ suite, caseId: id, apiKey: TEST_KEY, paid: true, approvedMaxCost: casePlan(fixture(id)).maxCost, provider: adapter(id), ...options });
const decisions = (result, value = 'yes') => Object.fromEntries(result.calls.filter(c => c.role === 'candidate' && c.status === 'complete').map(c => [c.label, value]));
const passingChecks = (result, rubric) => Object.fromEntries(result.calls.filter(c => c.status === 'complete').map(call => [call.label,
  rubric.criteria.map(c => ({ id: c.id, result: 'pass', evidence: 'Synthetic test evidence; no model was called.' })),
]));

test('12 cases cover each requested category twice, with eight Astra and four Sol baselines', () => {
  validateDefinitions(suite.fixtures, suite.rubrics);
  assert.equal(suite.fixtures.cases.length, 12);
  assert.equal(suite.fixtures.cases.filter(c => c.baselineModel === 'gpt-6-astra').length, 8);
  assert.equal(suite.fixtures.cases.filter(c => c.evaluationType === 'exact_json').length, 6);
  for (const c of suite.fixtures.cases) assert.ok(casePlan(c).maxCost < .25);
  assert.ok(Buffer.byteLength(fixture('11-launch-synthesis').request) > 6000);
  assert.ok(Buffer.byteLength(fixture('12-pilot-synthesis').request) > 5000);
  const duplicate = structuredClone(suite.fixtures); duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateDefinitions(duplicate, suite.rubrics), /unique/);
  const missing = structuredClone(suite.rubrics); delete missing.cases['01-billing-triage'];
  assert.throws(() => validateDefinitions(suite.fixtures, missing), /one-to-one/);
});

test('precommitted financial answers independently reconcile with the supplied inputs', () => {
  const get = id => suite.rubrics.cases[id].expected;
  assert.equal(get('02-contracted-arr').total_contracted_arr_usd, 24000 + 1200 * 12);
  assert.equal(get('02-contracted-arr').accounts[0].unsigned_incremental_arr_usd, 6000 * 12 - 24000);
  const invoice = get('03-invoice-json');
  assert.equal(invoice.subtotal, 12 * 29 + 1500 * .004 - 35);
  assert.equal(invoice.total, invoice.subtotal * 1.2);
  assert.equal(invoice.balance_due, invoice.total - 100);
  const units = get('05-unit-economics');
  assert.equal(units.monthly_requests, 240 * 300);
  assert.equal(units.inference_savings, units.monthly_requests * (.008 - .0025));
  assert.equal(units.net_monthly_improvement, units.inference_savings - 45 * 12);
  assert.equal(units.support_after, (36 + 45) * 12);
  assert.equal(units.margin_before_pct, Number((units.contribution_before / (240 * 49) * 100).toFixed(2)));
  assert.equal(units.margin_after_pct, Number((units.contribution_after / (240 * 49) * 100).toFixed(2)));
  const experiment = get('06-experiment-economics');
  assert.equal(experiment.A.total_cost, 1000 * .012 + 18 * 5);
  assert.equal(experiment.B.total_cost, 1000 * .0045 + 31 * 5);
  assert.equal(experiment.B_max_whole_tickets_to_match_A_cost_per_success, Math.floor((102 / 920 * 860 - 4.5) / 5));
  assert.equal(Number((62 / 840).toFixed(4)), .0738);
  assert.equal(Number((106 / 899).toFixed(4)), .1179);
  assert.equal(Number((874 / 950 * 80 + 25 / 50 * 20).toFixed(1)), 83.6);
});

test('approved prompts, assignments, exact answers and criterion wording are unchanged; all severities are precommitted', () => {
  assert.equal(digest(readFileSync(new URL('fixtures.json', import.meta.url), 'utf8')), '6957dfd64f5f76d37cf080828bcef7442ee8e2b5f97671e0b0b8a5ef467464ca');
  const originalCases = structuredClone(suite.rubrics.cases);
  const secondary = {
    '07-feedback-reliability': ['actions'], '08-feedback-conflicts': ['experiment'],
    '09-outage-rewrite': ['voice_format'], '10-onboarding-copy': ['distinct_variants', 'format'],
    '11-launch-synthesis': ['owners'], '12-pilot-synthesis': ['format_sources'],
  };
  for (const [id, rubric] of Object.entries(originalCases)) {
    if (rubric.type !== 'manual_rubric') continue;
    assert.deepEqual(rubric.criteria.filter(c => c.severity === 'secondary').map(c => c.id), secondary[id]);
    for (const criterion of rubric.criteria) {
      assert.ok(['critical', 'secondary'].includes(criterion.severity));
      delete criterion.severity;
    }
  }
  assert.equal(digest(originalCases), '8814835252f012502605a78bf8b26ca660200828f4ff0f9700edac20f28eaaff');
  for (const severity of [undefined, 'minor']) {
    const invalid = structuredClone(suite.rubrics);
    invalid.cases['07-feedback-reliability'].criteria[0].severity = severity;
    assert.throws(() => validateDefinitions(suite.fixtures, invalid), /severity/);
  }
});

test('only explicit per-case paid approval can reach the provider', async () => {
  let calls = 0;
  for (const options of [{ paid: false }, { approvedMaxCost: undefined }, { approvedMaxCost: .001 }, { approvedMaxCost: .251 }, { apiKey: 'bad' }]) {
    await assert.rejects(run('01-billing-triage', { ...options, provider: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
  assert.equal(LIMITS.budgetUsd, .05); assert.equal(LIMITS.hardBudgetUsd, .25);
});

test('wrapper invokes the frozen engine/adapter with both ladders, identical settings and no rubric leakage', async () => {
  for (const id of ['01-billing-triage', '02-contracted-arr']) {
    const c = fixture(id); const payloads = []; const checkpoints = [];
    const result = await run(id, { provider: adapter(id, {}, payloads), checkpoint: record => checkpoints.push(record) });
    assert.deepEqual(payloads.map(p => p.model), [c.baselineModel, ...CANDIDATES[c.baselineModel]]);
    for (const payload of payloads) {
      assert.deepEqual(payload, requestPayload(caseInput(c), payload.model));
      assert.equal(payload.max_output_tokens, 2048);
      assert.deepEqual(payload.reasoning, { effort: 'medium', mode: 'standard', context: 'current_turn' });
      assert.doesNotMatch(JSON.stringify(payload), /unsigned_incremental_arr_usd":48000|ground_truth|criticalOmissions|rationale|test-key/);
    }
    assert.equal(result.engineOutcome, 'complete');
    assert.equal(result.calls.length, payloads.length);
    assert.ok(checkpoints.some(r => r.calls.some(call => call.status === 'running')));
    assert.ok(checkpoints.some(r => r.calls.some(call => call.status === 'running') && r.costMayBeIncomplete));
    assert.ok(checkpoints.some(r => r.state === 'running' && r.calls[0].cost > 0 && r.measuredCost > 0));
    assert.equal(checkpoints.at(-1).state, 'finished');
    assert.doesNotMatch(JSON.stringify(checkpoints), new RegExp(TEST_KEY));
  }
});

test('confirmed output exhaustion is inconclusive, priced, and distinct from other incomplete reasons', async t => {
  const id = '02-contracted-arr';
  let reason = 'max_output_tokens'; let limitedModel = 'gpt-6.1-sol'; let requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const model = JSON.parse(options.body).model; requests.push(model);
    const extra = model === limitedModel ? {
      status: 'incomplete', incomplete_details: { reason }, output: [],
      usage: { input_tokens: 600, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 100 }, output_tokens: 2048, output_tokens_details: { reasoning_tokens: 2048 }, total_tokens: 2648 },
    } : {};
    return { ok: true, status: 200, json: async () => rawResponse(model, expectedText(id), extra) };
  });
  const limited = await run(id, { provider: observedProvider });
  assert.equal(limited.calls[1].status, 'inconclusive_output_budget');
  assert.ok(limited.calls[1].cost > 0);
  assert.equal(limited.calls[2].status, 'complete');
  const human = recordHuman(limited, decisions(limited));
  assert.equal(grade(limited, suite.rubrics.cases[id], human).judgments['Candidate A'].acceptable_pass, 'inconclusive');
  reason = 'content_filter';
  const other = await run(id, { provider: observedProvider });
  assert.equal(other.calls[1].status, 'inconclusive_technical');
  reason = 'max_output_tokens'; limitedModel = 'gpt-6-astra'; requests = [];
  const baseline = await run(id, { provider: observedProvider });
  assert.equal(baseline.engineOutcome, 'baseline_incomplete');
  assert.equal(baseline.calls[0].status, 'inconclusive_output_budget');
  assert.ok(baseline.calls[0].cost > 0);
  assert.deepEqual(requests, ['gpt-6-astra']);
  assert.equal(baseline.calls[1].status, 'not_run');
});

test('technical errors keep only safe codes, and refusal is a separate quality failure', async () => {
  const id = '01-billing-triage';
  const failed = await run(id, { provider: async () => { throw new Error(TEST_KEY); } });
  assert.equal(failed.calls[0].status, 'inconclusive_technical');
  assert.equal(failed.calls[0].reason, 'provider_error');
  assert.equal(failed.costMayBeIncomplete, true);
  assert.equal(failed.calls[1].attempted, false);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(TEST_KEY));
  const refused = await run(id, { provider: adapter(id, { 'gpt-6-luna': { output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] } }) });
  assert.equal(refused.calls[1].status, 'quality_failure');
  const human = recordHuman(refused, decisions(refused));
  assert.equal(grade(refused, suite.rubrics.cases[id], human).judgments['Candidate A'].acceptable_pass, false);
});

test('confirmed budget exhaustion remains identifiable when usage validation also fails', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => ({ ok: true, status: 200, json: async () => rawResponse(JSON.parse(options.body).model, '', {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: null, output: [],
  }) }));
  const result = await run('01-billing-triage', { provider: observedProvider });
  assert.equal(result.calls[0].status, 'inconclusive_output_budget');
  assert.equal(result.calls[0].cost, null);
  assert.equal(result.costMayBeIncomplete, true);
  assert.equal(result.calls[1].status, 'not_run');
});

test('credential echoes are redacted from recorded output and checkpoints, including quote characters', async () => {
  const key = 'synthetic-"quoted-secret'; const saved = [];
  const result = await run('01-billing-triage', { apiKey: key, checkpoint: r => saved.push(r), provider: async ({ model }) => ({ model, complete: true, output: `Unexpected echo ${key}`, cost: model === 'gpt-6.1-sol' ? .01 : .001, usage: {}, latencyMs: 1 }) });
  assert.equal(result.calls[0].output, 'Unexpected echo [REDACTED]');
  assert.ok(!JSON.stringify(saved).includes(JSON.stringify(key).slice(1, -1)));
});

test('blind view hides identities, costs, savings and ground truth; reveal requires locked human decisions', async () => {
  const id = '02-contracted-arr'; const result = await run(id);
  const view = JSON.stringify(blindView(fixture(id), result));
  assert.doesNotMatch(view, /gpt-6|measuredCost|reduction|pricing|ground_truth|rationale/);
  assert.deepEqual(blindView(fixture(id), result).outputs.map(o => o.label), ['Baseline', 'Candidate A', 'Candidate B']);
  const outputs = blindView(fixture(id), result).outputs;
  assert.equal(outputs[0].output, result.calls[0].output);
  assert.deepEqual(outputs.map(o => o.reviewable), [false, true, true]);
  assert.equal(blindView(fixture(id), result).question, replacementQuestion);
  assert.throws(() => reveal(result, null), /blind human/);
  assert.throws(() => recordHuman(result, { 'Candidate A': 'yes' }), /every complete candidate/);
  assert.throws(() => recordHuman(result, { ...decisions(result), Baseline: 'yes' }), /no baseline decision/);
  const human = recordHuman(result, { 'Candidate A': 'yes', 'Candidate B': 'no' });
  assert.deepEqual(human.decisions, { 'Candidate A': 'yes', 'Candidate B': 'no' });
  assert.equal(human.decisionType, 'baseline_replacement');
  assert.deepEqual(reveal(result, human).map(c => c.humanReplacement), [null, 'yes', 'no']);
  assert.equal(reveal(result, human)[1].model, 'gpt-6.1-sol');
  assert.ok(reveal(result, human)[1].measuredCost > 0);
  assert.throws(() => reveal(result, { ...human, schemaVersion: 1 }), /blind human/);
  assert.throws(() => reveal(result, { ...human, decisionType: 'ship' }), /blind human/);
  const altered = structuredClone(result); altered.calls[1].output += ' changed';
  assert.throws(() => reveal(altered, human), /before revealing/);
});

test('human yes can fail exact ground truth; strict JSON and semantic object comparison are independent', async () => {
  const id = '02-contracted-arr';
  const wrong = structuredClone(suite.rubrics.cases[id].expected); wrong.accounts[0].contracted_arr_usd = 72000;
  const result = await run(id, { provider: adapter(id, { 'gpt-6.1-sol': { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(wrong) }] }] } }) });
  const human = recordHuman(result, decisions(result));
  const review = grade(result, suite.rubrics.cases[id], human);
  assert.equal(human.decisions['Candidate A'], 'yes');
  assert.equal(review.judgments['Candidate A'].acceptable_pass, false);
  assert.equal(review.judgments['Candidate B'].acceptable_pass, true);
  assert.equal(review.judgments.Baseline.strict_pass, true);
  assert.equal(human.decisions.Baseline, undefined);
  for (const judgment of Object.values(review.judgments)) assert.equal(judgment.strict_pass, judgment.acceptable_pass);
  verifyReview(result, suite.rubrics.cases[id], human, review);
  for (const [text, expected] of [
    [JSON.stringify(Object.fromEntries(Object.entries(suite.rubrics.cases[id].expected).reverse())), 'pass'],
    [JSON.stringify({ ...suite.rubrics.cases[id].expected, extra: true }), 'fail'],
    ['```json\n' + expectedText(id) + '\n```', 'fail'],
  ]) {
    const copy = structuredClone(result); copy.calls[1].output = text;
    const judgment = grade(copy, suite.rubrics.cases[id], recordHuman(copy, decisions(copy))).judgments['Candidate A'];
    assert.equal(judgment.acceptable_pass, expected === 'pass');
    assert.equal(judgment.strict_pass, judgment.acceptable_pass);
  }
});

test('baseline is independently graded even when no candidate is available for human review', async () => {
  const id = '01-billing-triage';
  const result = await run(id, { provider: async args => {
    if (args.model === 'gpt-6-luna') throw new BenchmarkError('timeout', 'Synthetic timeout.');
    return adapter(id)(args);
  } });
  const human = recordHuman(result, {});
  const review = grade(result, suite.rubrics.cases[id], human);
  assert.equal(review.judgments.Baseline.strict_pass, true);
  assert.equal(review.judgments.Baseline.acceptable_pass, true);
  assert.equal(review.judgments['Candidate A'].strict_pass, 'inconclusive');
  assert.equal(review.judgments['Candidate A'].acceptable_pass, 'inconclusive');
  assert.equal(summarize(suite, [{ result, human, review }]).overall.pendingHumanOutputs, 0);
});

test('manual rubric requires all precommitted checks with evidence; no canonical prose or acceptance shortcut', async () => {
  const id = '07-feedback-reliability'; const result = await run(id);
  const rubric = suite.rubrics.cases[id]; const human = recordHuman(result, decisions(result));
  assert.equal(Object.hasOwn(rubric, 'expected'), false);
  assert.throws(() => grade(result, rubric, human), /Every precommitted/);
  const checks = Object.fromEntries(result.calls.map(call => [call.label, rubric.criteria.map(c => ({ id: c.id, result: 'pass', evidence: 'Reviewer cites source/output evidence here.' }))]));
  checks['Candidate A'][1].result = 'fail'; checks['Candidate A'][1].evidence = 'Counts the forwarded Orchard complaint as another customer.';
  const review = grade(result, rubric, human, checks);
  assert.equal(review.judgments['Candidate A'].acceptable_pass, false);
  assert.equal(human.decisions['Candidate A'], 'yes');
  checks['Candidate A'][1].result = 'inconclusive';
  assert.equal(grade(result, rubric, human, checks).judgments['Candidate A'].acceptable_pass, 'inconclusive');
  checks['Baseline'][0].evidence = '';
  assert.throws(() => grade(result, rubric, human, checks), /written evidence/);
});

test('acceptable rubric tolerates secondary failures only at or above 80%, while strict requires every criterion', async () => {
  for (const id of ['07-feedback-reliability', '08-feedback-conflicts', '09-outage-rewrite', '10-onboarding-copy', '11-launch-synthesis', '12-pilot-synthesis']) {
    const result = await run(id); const rubric = suite.rubrics.cases[id];
    const human = recordHuman(result, decisions(result, 'no'));
    const checks = passingChecks(result, rubric);
    const secondary = rubric.criteria.find(c => c.severity === 'secondary').id;
    checks['Candidate A'].find(c => c.id === secondary).result = 'fail';
    const review = grade(result, rubric, human, checks);
    assert.equal(review.judgments.Baseline.strict_pass, true);
    assert.equal(review.judgments['Candidate A'].strict_pass, false);
    assert.equal(review.judgments['Candidate A'].acceptable_pass, true, id);
    assert.deepEqual(review.judgments['Candidate A'].checks.map(c => [c.id, c.severity]), rubric.criteria.map(c => [c.id, c.severity]));
    verifyReview(result, rubric, human, review);
    // A severity change in a saved review cannot downgrade the locked criterion.
    review.judgments['Candidate A'].checks[0].severity = 'secondary';
    assert.throws(() => verifyReview(result, rubric, human, review), /evidence/);
  }
  const id = '10-onboarding-copy'; const rubric = suite.rubrics.cases[id]; const result = await run(id);
  const human = recordHuman(result, decisions(result)); const checks = passingChecks(result, rubric);
  for (const c of rubric.criteria.filter(c => c.severity === 'secondary')) checks['Candidate A'].find(item => item.id === c.id).result = 'fail';
  const judgment = grade(result, rubric, human, checks).judgments['Candidate A'];
  assert.equal(judgment.strict_pass, false);
  assert.equal(judgment.acceptable_pass, false); // 4/6 fails; 5/6 passed above.
});

test('critical failure or uncertainty cannot be outweighed by the overall pass percentage', async () => {
  const id = '11-launch-synthesis'; const result = await run(id); const rubric = suite.rubrics.cases[id];
  const human = recordHuman(result, decisions(result)); const checks = passingChecks(result, rubric);
  for (const [verdict, expected] of [['fail', false], ['inconclusive', 'inconclusive']]) {
    checks['Candidate A'].find(c => c.id === 'gates').result = verdict;
    const judgment = grade(result, rubric, human, checks).judgments['Candidate A'];
    assert.equal(judgment.acceptable_pass, expected); // Other 6/7 criteria pass (>80%).
    assert.equal(judgment.strict_pass, expected);
  }
  checks['Candidate A'].find(c => c.id === 'decision').result = 'fail';
  assert.equal(grade(result, rubric, human, checks).judgments['Candidate A'].acceptable_pass, false);
});

test('secondary uncertainty is resolved only when it cannot change the acceptable threshold', async () => {
  const id = '10-onboarding-copy'; const result = await run(id); const rubric = suite.rubrics.cases[id];
  const human = recordHuman(result, decisions(result)); const checks = passingChecks(result, rubric);
  checks['Candidate A'].find(c => c.id === 'format').result = 'inconclusive';
  let judgment = grade(result, rubric, human, checks).judgments['Candidate A'];
  assert.equal(judgment.strict_pass, 'inconclusive');
  assert.equal(judgment.acceptable_pass, true); // Five known passes out of six suffice.
  checks['Candidate A'].find(c => c.id === 'distinct_variants').result = 'fail';
  judgment = grade(result, rubric, human, checks).judgments['Candidate A'];
  assert.equal(judgment.strict_pass, false);
  assert.equal(judgment.acceptable_pass, 'inconclusive'); // Could reach 5/6 if the unknown passes.
  checks['Candidate A'].find(c => c.id === 'format').result = 'fail';
  assert.equal(grade(result, rubric, human, checks).judgments['Candidate A'].acceptable_pass, false);
});

test('precommit locks reject definition/config drift and adjudication edits', async () => {
  const manifest = createManifest(suite, 'test-only'); verifyManifest(suite, manifest);
  for (const path of ['internal/benchmark/rubrics.json', 'internal/benchmark/fixtures.json', 'src/models.js', 'lib/benchmark.mjs']) {
    const changed = structuredClone(manifest); changed.sourceHashes[path] = 'changed';
    assert.throws(() => verifyManifest(suite, changed), /Precommit lock mismatch/);
  }
  const id = '01-billing-triage'; const result = await run(id); const human = recordHuman(result, decisions(result));
  const review = grade(result, suite.rubrics.cases[id], human);
  review.judgments['Candidate A'].acceptable_pass = false;
  assert.throws(() => verifyReview(result, suite.rubrics.cases[id], human, review), /evidence/);
});

test('metrics use distinct human/rubric denominators, quality order, actual savings and category breakdowns', async () => {
  const ids = ['01-billing-triage', '02-contracted-arr', '03-invoice-json', '04-multi-team-routing'];
  const entries = [];
  for (const id of ids) {
    const c = fixture(id);
    const result = await run(id, { provider: async ({ model }) => {
      if (id === ids[3]) throw new BenchmarkError('timeout', 'Do not persist raw messages.');
      const capped = id === ids[2] && model === 'gpt-6-luna';
      const wrong = id === ids[0] && model === 'gpt-6-luna';
      return { model, complete: !capped, issue: capped ? 'output_limit' : null, incompleteReason: capped ? 'max_output_tokens' : null,
        output: wrong ? '[]' : expectedText(id), cost: model === c.baselineModel ? .01 : model === 'gpt-6.1-sol' ? .004 : .001, usage: {}, latencyMs: 1 };
    } });
    const answers = decisions(result);
    if (id === ids[1]) answers['Candidate A'] = 'no';
    const human = recordHuman(result, answers);
    entries.push({ result, human, review: grade(result, suite.rubrics.cases[id], human) });
  }
  const summary = summarize(suite, entries); const m = summary.overall;
  assert.equal(summary.unrunWorkloads, 8);
  assert.equal(m.cheaperModelAcceptance.percent, 50);
  assert.equal(m.acceptableRubricQualifiedReplacement.percent, 25);
  assert.equal(m.acceptableLunaReplacement.percent, 25);
  assert.equal(m.acceptableSolReplacementAmongAstra.percent, 50);
  assert.deepEqual(m.strictRubricQualifiedReplacement, m.acceptableRubricQualifiedReplacement);
  assert.deepEqual(m.strictLunaReplacement, m.acceptableLunaReplacement);
  assert.deepEqual(m.strictSolReplacementAmongAstra, m.acceptableSolReplacementAmongAstra);
  assert.equal(m.falseConfidence.percent, 50);
  assert.deepEqual(m.strictFalseConfidence, m.falseConfidence);
  assert.deepEqual(m.falseConfidence.affectedWorkloads, [ids[0]]);
  assert.ok(Math.abs(m.medianMeasuredSavingsAmongHumanAccepted.percent - 90) < 1e-10);
  assert.ok(Math.abs(m.medianMeasuredSavingsAmongAcceptableRubricPassed.percent - 60) < 1e-10);
  assert.equal(m.inconclusive.percent, 50);
  assert.equal(m.outputBudgetCalls, 1); assert.equal(m.technicalFailureCalls, 1);
  assert.equal(m.provisional, false);
  assert.equal(summary.byCategory.extraction_classification.cheaperModelAcceptance.percent, 100);
  assert.equal(summary.byCategory.structured_transformation.inconclusive.percent, 100);
  assert.equal(summary.byCategory.rewrite_copy.cheaperModelAcceptance.percent, null);
  assert.throws(() => summarize(suite, [entries[0], entries[0]]), /Duplicate/);
});

test('aggregates report strict and acceptable Luna/Sol rates and distinguish primary from strict false confidence', async () => {
  const entries = [];
  for (const id of ['07-feedback-reliability', '08-feedback-conflicts', '10-onboarding-copy']) {
    const result = await run(id, { provider: async ({ model }) => ({
      complete: true, output: 'Synthetic manual-grading test output.', usage: {}, latencyMs: 1,
      cost: model === fixture(id).baselineModel ? .01 : model === 'gpt-6.1-sol' ? .004 : .001,
    }) });
    const rubric = suite.rubrics.cases[id]; const human = recordHuman(result, decisions(result));
    const checks = passingChecks(result, rubric);
    if (id === '07-feedback-reliability') checks['Candidate A'].find(c => c.id === 'actions').result = 'fail';
    if (id === '08-feedback-conflicts') {
      checks['Candidate A'].find(c => c.id === 'experiment').result = 'fail';
      checks['Candidate B'].find(c => c.id === 'ownership').result = 'fail';
    }
    if (id === '10-onboarding-copy') checks['Candidate A'].find(c => c.id === 'control').result = 'inconclusive';
    entries.push({ result, human, review: grade(result, rubric, human, checks) });
  }
  const summary = summarize(suite, entries); const m = summary.overall;
  assert.equal(m.cheaperModelAcceptance.numerator, 3);
  assert.equal(m.strictRubricQualifiedReplacement.numerator, 1);
  assert.equal(m.acceptableRubricQualifiedReplacement.numerator, 3);
  assert.equal(m.strictLunaReplacement.numerator, 1);
  assert.equal(m.acceptableLunaReplacement.numerator, 2);
  assert.equal(m.strictSolReplacementAmongAstra.percent, 0);
  assert.equal(m.acceptableSolReplacementAmongAstra.percent, 50);
  assert.equal(m.acceptableSolReplacementAmongAstra.denominator, 2);
  assert.equal(m.falseConfidence.numerator, 1);
  assert.equal(m.falseConfidence.denominator, 4); // Critical inconclusive is excluded, not a pass/fail.
  assert.equal(m.strictFalseConfidence.numerator, 3);
  assert.equal(m.strictFalseConfidence.denominator, 4);
  assert.deepEqual(m.falseConfidence.outputs, [{ caseId: '08-feedback-conflicts', label: 'Candidate B' }]);
  assert.deepEqual(m.strictFalseConfidence.affectedWorkloads, ['07-feedback-reliability', '08-feedback-conflicts']);
  assert.equal(m.qualityFailureOutputs, 1);
  assert.equal(m.strictFailureOutputs, 3);
  assert.equal(m.inconclusive.numerator, 1);
  assert.equal(m.medianMeasuredSavingsAmongStrictRubricPassed.workloads, 1);
  assert.equal(m.medianMeasuredSavingsAmongAcceptableRubricPassed.workloads, 3);
  assert.ok(Math.abs(m.medianMeasuredSavingsAmongAcceptableRubricPassed.percent - 90) < 1e-10);
  const feedback = summary.byCategory.customer_feedback_summarization;
  assert.equal(feedback.strictRubricQualifiedReplacement.percent, 0);
  assert.equal(feedback.acceptableRubricQualifiedReplacement.percent, 100);
  assert.equal(feedback.acceptableSolReplacementAmongAstra.percent, 100);
  assert.ok(Math.abs(feedback.medianMeasuredSavingsAmongAcceptableRubricPassed.percent - 75) < 1e-10);
});

test('negative savings are excluded from medians; pending and interrupted work stays visible', async () => {
  const id = '01-billing-triage';
  const result = await run(id, { provider: adapter(id, { 'gpt-6.1-sol': { usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } }) });
  assert.ok(result.calls[1].reduction < 0);
  const pending = summarize(suite, [{ result }]);
  assert.equal(pending.overall.provisional, true);
  assert.equal(pending.overall.pendingHumanOutputs, 1);
  const human = recordHuman(result, decisions(result));
  const review = grade(result, suite.rubrics.cases[id], human);
  const graded = summarize(suite, [{ result, human, review }]);
  assert.equal(graded.overall.cheaperModelAcceptance.percent, 100);
  assert.equal(graded.overall.medianMeasuredSavingsAmongHumanAccepted.percent, null);
  assert.equal(graded.overall.medianMeasuredSavingsAmongHumanAccepted.workloads, 0);
  const interrupted = structuredClone(result); interrupted.state = 'running'; interrupted.calls[1].status = 'running';
  const interruptedMetrics = summarize(suite, [{ result: interrupted }]).overall;
  assert.equal(interruptedMetrics.inconclusive.percent, 100);
  assert.equal(interruptedMetrics.interruptedWorkloads, 1);
  assert.equal(interruptedMetrics.pendingHumanOutputs, 0);
  assert.equal(interruptedMetrics.provisional, false);
  assert.throws(() => recordHuman(interrupted, {}), /interrupted/);
  assert.equal(summarize(suite, []).overall.falseConfidence.percent, null);
});

test('CLI safe commands cannot spend, init cannot overwrite, and approval is required before key entry', async t => {
  const id = `test-${randomUUID()}`;
  const directory = fileURLToPath(new URL(`outputs/internal-benchmark/${id}/`, projectRoot));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No network permitted.'); });
  t.mock.method(console, 'log', () => {});
  await main(['list']); await main(['plan', '01-billing-triage']); await main(['init', id]);
  assert.ok(existsSync(`${directory}/manifest.json`));
  await assert.rejects(main(['init', id]));
  await assert.rejects(main(['run', id, '01-billing-triage']), /No calls made/);
  await assert.rejects(main(['run', id, '01-billing-triage', '--paid', '--approve', '.001']), /No calls made/);
  await main(['summary', id]);
  assert.equal(calls, 0);
  assert.equal(existsSync(`${directory}/01-billing-triage`), false);
});

test('CLI asks both candidates independently about replacement, preserves visible baseline and grades it separately', async t => {
  const id = `test-${randomUUID()}`; const caseId = '10-onboarding-copy';
  const directory = fileURLToPath(new URL(`outputs/internal-benchmark/${id}/`, projectRoot));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  t.after(() => { if (tty) Object.defineProperty(process.stdin, 'isTTY', tty); else delete process.stdin.isTTY; });
  const printed = []; const questions = []; const answers = ['yes', 'no'];
  t.mock.method(console, 'log', value => printed.push(value));
  t.mock.method(Interface.prototype, 'question', async question => { questions.push(question); return answers.shift(); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed in CLI review.'); });
  await main(['init', id]);
  const result = await run(caseId);
  mkdirSync(`${directory}/${caseId}`);
  writeFileSync(`${directory}/${caseId}/result.json`, JSON.stringify(result));
  printed.length = 0;
  await main(['human', id, caseId]);
  assert.deepEqual(questions, [
    `Candidate A: ${replacementQuestion} [yes/no]: `,
    `Candidate B: ${replacementQuestion} [yes/no]: `,
  ]);
  assert.match(printed.join('\n'), /Baseline\nReference output/);
  assert.doesNotMatch(printed.join('\n'), /gpt-6|measuredCost|measuredReduction|criticalOmissions|PRECOMMITTED RUBRIC/);
  const human = JSON.parse(readFileSync(`${directory}/${caseId}/human.json`, 'utf8'));
  assert.deepEqual(human.decisions, { 'Candidate A': 'yes', 'Candidate B': 'no' });
  // Objective grading still requests every criterion for all three complete outputs.
  questions.length = 0;
  for (let i = 0; i < suite.rubrics.cases[caseId].criteria.length * 3; i++) answers.push('pass', 'Synthetic test evidence.');
  await main(['rubric', id, caseId]);
  assert.equal(answers.length, 0);
  assert.equal(questions.length, suite.rubrics.cases[caseId].criteria.length * 3 * 2);
  const review = JSON.parse(readFileSync(`${directory}/${caseId}/rubric.json`, 'utf8'));
  assert.deepEqual(Object.keys(review.judgments), ['Baseline', 'Candidate A', 'Candidate B']);
  assert.equal(review.judgments.Baseline.acceptable_pass, true);
  assert.equal(review.judgments['Candidate B'].acceptable_pass, true); // Independent of human no.
  assert.match(printed.join('\n'), /Baseline \/ free_plan \(critical\)/);
  assert.match(printed.join('\n'), /Candidate B \/ format \(secondary\)/);
});

test('CLI grades an independently recorded human decision, refuses overwrites and checks output hashes before reveal', async t => {
  const id = `test-${randomUUID()}`; const caseId = '01-billing-triage';
  const directory = fileURLToPath(new URL(`outputs/internal-benchmark/${id}/`, projectRoot));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  await main(['init', id]);
  const result = await run(caseId);
  mkdirSync(`${directory}/${caseId}`);
  const save = (file, value) => writeFileSync(`${directory}/${caseId}/${file}`, JSON.stringify(value));
  save('result.json', result);
  await assert.rejects(main(['reveal', id, caseId]));
  await assert.rejects(main(['rubric', id, caseId]));
  save('human.json', recordHuman(result, decisions(result)));
  await main(['rubric', id, caseId]);
  assert.equal(JSON.parse(readFileSync(`${directory}/${caseId}/rubric.json`, 'utf8')).judgments['Candidate A'].acceptable_pass, true);
  await main(['reveal', id, caseId]);
  await assert.rejects(main(['rubric', id, caseId]), /already locked/);
  await assert.rejects(main(['human', id, caseId]), /already locked/);
  await assert.rejects(main(['run', id, caseId, '--paid', '--approve', String(result.plan.maxCost)]), /already has an attempt/);
  result.calls[1].output += ' tampered'; save('result.json', result);
  await assert.rejects(main(['reveal', id, caseId]), /blind human/);
});

test('production does not serve internal fixtures/rubrics/results and all frozen product files are unchanged', async () => {
  const handler = createHandler();
  for (const url of ['/internal/benchmark/fixtures.json', '/internal/benchmark/rubrics.json', '/outputs/internal-benchmark/pilot/manifest.json']) {
    const response = { writeHead(status) { this.status = status; }, end() {} };
    await handler({ method: 'GET', url, headers: { host: 'localhost:5173' }, socket: { localPort: 5173 } }, response);
    assert.equal(response.status, 404);
  }
  const frozen = {
    '.gitignore':'a2c110d7ba81d1abc242190e2470dd8219555412', 'README.md':'ec64868e59cbd212c74ac13072a4c8f463d48dc1',
    'index.html':'f71bbbb1f442a6d2f3217e84b87dd9a3e85336c7', 'lib/benchmark.mjs':'851df5a488e15a2a9da382345426853ff6bf15d3',
    'lib/errors.mjs':'2368c6a0194763ea2131a992cc04f010663671ac', 'lib/provider.mjs':'98ce986f10aafa87d400cfb0e3b0cf1145e4162d',
    'package.json':'9ac4a09139008db881c6bba989956f83ae22c7c7', 'server.mjs':'10334caec0885c105385f17040f485d954713786',
    'public/favicon.svg':'5f2a788a9d5e9a56230afe31638fa727316c094f', 'src/app.js':'de0d71f7b50d85ba1573ff8a2ea36acd50ab8219',
    'src/data.js':'a24846c4517e0a2ff90aa4fdfe80e155dc61de76', 'src/models.js':'5aa8019de2ac1773c27f7f30758f3eab87ac1260',
    'src/styles.css':'d3ceb5ab54c04ef73cc664fbb588d033dec48ae3', 'tests/benchmark.test.mjs':'474338fa7ea2e70849c4fe0687786aeade09a9a7',
    'tests/flow.test.mjs':'378e1314fda64aec5386205d14843bfad69b23d2', 'tests/savings.test.mjs':'121e068c4f6a9bca5a0514aa59f514c477e52e05', 'tests/server.test.mjs':'f33be2e6e2fdf77dc231ef6cce7b9deb121a879f',
  };
  for (const [path, expected] of Object.entries(frozen)) {
    const bytes = readFileSync(new URL(path, projectRoot));
    const actual = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    assert.equal(actual, expected, `Frozen file changed: ${path}`);
  }
});

test('human-readable catalog contains every exact prompt and precommitted evaluation', () => {
  const text = catalog(suite);
  assert.equal(readFileSync(new URL('CASES.md', import.meta.url), 'utf8'), text);
  for (const c of suite.fixtures.cases) { assert.ok(text.includes(c.system)); assert.ok(text.includes(c.request)); assert.ok(text.includes(`## ${c.id}`)); }
});
