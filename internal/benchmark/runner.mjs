import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildPlan, runBenchmark } from '../../lib/benchmark.mjs';
import { callOpenAI } from '../../lib/provider.mjs';
import { CANDIDATES, LIMITS, costReduction } from '../../src/models.js';

export const schemaVersion = 2;
export const replacementQuestion = 'Would you replace the baseline with this candidate for this workload?';
export const projectRoot = new URL('../../', import.meta.url);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const categories = ['extraction_classification', 'structured_transformation', 'customer_feedback_summarization', 'rewrite_copy', 'medium_business_reasoning', 'longer_context_synthesis'];
const lockedFiles = [
  'internal/benchmark/fixtures.json', 'internal/benchmark/rubrics.json',
  'internal/benchmark/runner.mjs', 'internal/benchmark/cli.mjs',
  'src/models.js', 'src/data.js', 'src/app.js', 'src/styles.css',
  'lib/benchmark.mjs', 'lib/provider.mjs', 'lib/errors.mjs',
  'server.mjs', 'package.json', 'index.html', 'public/favicon.svg',
];
const safeCodes = new Set(['invalid_key', 'model_unavailable', 'context_too_long', 'quota', 'rate_limit', 'provider_error', 'unsupported_pricing', 'incomparable_settings', 'missing_usage', 'cancelled', 'timeout', 'baseline_incomplete', 'budget_limit', 'budget_confirmation']);
const safeCode = error => safeCodes.has(error?.code) ? error.code : 'provider_error';
const choice = (value, values) => { if (!values.includes(value)) throw new Error(`Expected ${values.join(' / ')}.`); return value; };

export function validateDefinitions(fixtures, rubrics) {
  if (fixtures.suiteId !== rubrics.suiteId || fixtures.cases.length !== 12) throw new Error('Suite needs 12 matching fixtures and rubrics.');
  const ids = fixtures.cases.map(c => c.id);
  if (new Set(ids).size !== 12 || Object.keys(rubrics.cases).length !== 12) throw new Error('Case IDs must be unique and rubrics one-to-one.');
  for (const c of fixtures.cases) {
    if (!/^[a-z0-9-]+$/.test(c.id) || !c.title || !c.system || !c.request) throw new Error('Invalid case definition.');
    if (!categories.includes(c.category) || !Object.hasOwn(CANDIDATES, c.baselineModel)) throw new Error('Unsupported category or baseline.');
    const rubric = rubrics.cases[c.id];
    if (!rubric || rubric.type !== c.evaluationType) throw new Error('Evaluation definition mismatch.');
    choice(rubric.type, ['exact_json', 'manual_rubric']);
    if (rubric.type === 'exact_json' && !Object.hasOwn(rubric, 'expected')) throw new Error('Missing ground truth.');
    if (rubric.type === 'manual_rubric' && (!rubric.criteria?.length || !rubric.criticalOmissions || new Set(rubric.criteria.map(r => r.id)).size !== rubric.criteria.length || rubric.criteria.some(r => !r.id || !r.requirement || !['critical', 'secondary'].includes(r.severity)))) throw new Error('Incomplete manual rubric: every criterion needs a critical/secondary severity.');
    buildPlan(caseInput(c)); // Every fixture must fit the frozen engine's guardrails.
  }
  for (const category of categories) if (fixtures.cases.filter(c => c.category === category).length !== 2) throw new Error('Need two cases per category.');
  if (fixtures.cases.filter(c => c.baselineModel === 'gpt-6-astra').length !== 8 || fixtures.cases.filter(c => c.baselineModel === 'gpt-6.1-sol').length !== 4) throw new Error('Need eight Astra and four Sol baselines.');
}

export function loadSuite() {
  const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', import.meta.url), 'utf8'));
  const rubrics = JSON.parse(readFileSync(new URL('rubrics.json', import.meta.url), 'utf8'));
  validateDefinitions(fixtures, rubrics);
  const sourceHashes = Object.fromEntries(lockedFiles.map(path => [path, digest(readFileSync(new URL(path, projectRoot), 'utf8'))]));
  return { fixtures, rubrics, sourceHashes, fingerprint: digest(sourceHashes) };
}

export function createManifest(suite, experimentId) {
  return { schemaVersion, experimentId, suiteId: suite.fixtures.suiteId, createdAt: new Date().toISOString(), fingerprint: suite.fingerprint, sourceHashes: suite.sourceHashes, caseIds: suite.fixtures.cases.map(c => c.id) };
}

export function verifyManifest(suite, manifest) {
  if (manifest.schemaVersion !== schemaVersion || manifest.suiteId !== suite.fixtures.suiteId || manifest.fingerprint !== suite.fingerprint || !isDeepStrictEqual(manifest.sourceHashes, suite.sourceHashes) || !isDeepStrictEqual(manifest.caseIds, suite.fixtures.cases.map(c => c.id))) throw new Error('Precommit lock mismatch. Do not revise criteria or settings after seeing outputs. Keep this experiment and review changes as a new suite/experiment.');
}

export function caseInput(c) { return { model: c.baselineModel, system: c.system, request: c.request, response: '' }; }
export function findCase(suite, id) { const c = suite.fixtures.cases.find(item => item.id === id); if (!c) throw new Error('Unknown case ID.'); return c; }
export function casePlan(c) { return buildPlan(caseInput(c)); }
export function assertPaidApproval(plan, paid, approvedMaxCost) {
  if (paid !== true || !Number.isFinite(approvedMaxCost) || approvedMaxCost < plan.maxCost || approvedMaxCost > LIMITS.hardBudgetUsd) throw new Error(`No calls made. Explicit --paid --approve ${plan.maxCost.toFixed(6)} required (hard ceiling $${LIMITS.hardBudgetUsd}).`);
}

// Observe only the incomplete reason discarded by the frozen adapter. The
// production request, provider validation, settings, usage and cost stay intact.
export async function observedProvider(args) {
  let incompleteReason = null;
  try {
    const result = await callOpenAI({ ...args, fetchImpl: async (...fetchArgs) => {
      const response = await fetch(...fetchArgs);
      return { ok: response.ok, status: response.status, json: async () => {
        const data = await response.json();
        incompleteReason = ['max_output_tokens', 'content_filter'].includes(data?.incomplete_details?.reason) ? data.incomplete_details.reason : null;
        return data;
      } };
    } });
    return { ...result, incompleteReason };
  } catch (error) {
    // An output limit is still inconclusive if later usage validation fails.
    if (incompleteReason === 'max_output_tokens') error.benchmarkOutputBudget = true;
    throw error;
  }
}

export async function executeCase({ suite, caseId, apiKey, paid = false, approvedMaxCost, provider = observedProvider, checkpoint = () => {} }) {
  const c = findCase(suite, caseId);
  const plan = casePlan(c);
  assertPaidApproval(plan, paid, approvedMaxCost);
  if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(apiKey)) throw new Error('A temporary API key is required.');
  const result = {
    schemaVersion, suiteFingerprint: suite.fingerprint, caseId: c.id, category: c.category,
    baselineModel: c.baselineModel, startedAt: new Date().toISOString(), finishedAt: null,
    state: 'running', plan, engineOutcome: null, measuredCost: 0, costMayBeIncomplete: false,
    calls: plan.calls.map((call, i) => ({ label: i === 0 ? 'Baseline' : `Candidate ${String.fromCharCode(64 + i)}`, role: call.role, model: call.model, attempted: false, status: 'not_run', reason: null, output: null, usage: null, cost: null, reduction: null, latencyMs: null, pricing: null, settings: null })),
  };
  const clean = value => typeof value === 'string' ? value.replaceAll(apiKey, '[REDACTED]')
    : Array.isArray(value) ? value.map(clean)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) : value;
  let persistenceError;
  const save = () => {
    result.measuredCost = result.calls.reduce((total, call) => total + (call.cost ?? 0), 0);
    result.costMayBeIncomplete = result.calls.some(call => call.attempted && call.cost === null);
    try { checkpoint(clean(result)); } catch { persistenceError = true; throw new Error('Checkpoint failed.'); }
  };
  save();
  try {
    await runBenchmark({ input: caseInput(c), apiKey, approvedMaxCost, provider: async args => {
      const record = result.calls.find(call => call.model === args.model);
      record.attempted = true; record.status = 'running'; save();
      let returned;
      try { returned = await provider(args); }
      catch (error) {
        record.status = error?.benchmarkOutputBudget ? 'inconclusive_output_budget' : 'inconclusive_technical';
        record.reason = error?.benchmarkOutputBudget ? 'max_output_tokens' : safeCode(error);
        save(); throw error;
      }
      record.status = returned.complete ? 'complete'
        : returned.incompleteReason === 'max_output_tokens' ? 'inconclusive_output_budget'
          : returned.issue === 'refusal' ? 'quality_failure' : 'inconclusive_technical';
      record.reason = returned.complete ? null
        : returned.incompleteReason === 'max_output_tokens' ? 'max_output_tokens'
          : returned.issue === 'refusal' ? 'refusal' : 'unusable_or_unclassified_incomplete_output';
      for (const field of ['output', 'usage', 'cost', 'latencyMs', 'pricing', 'settings']) record[field] = clean(returned[field] ?? null);
      save();
      return returned;
    } });
    result.engineOutcome = 'complete';
  } catch (error) { result.engineOutcome = safeCode(error); }
  if (persistenceError) throw new Error('Checkpoint failed; run stopped. Inspect the existing record before any new experiment.');
  for (const call of result.calls) if (!call.attempted) call.reason = `engine_stopped:${result.engineOutcome}`;
  const baseline = result.calls[0];
  for (const call of result.calls.slice(1)) if (result.engineOutcome === 'complete' && baseline.status === 'complete' && call.status === 'complete') call.reduction = costReduction(baseline.cost, call.cost);
  result.measuredCost = result.calls.reduce((total, call) => total + (call.cost ?? 0), 0);
  result.costMayBeIncomplete = result.calls.some(call => call.attempted && call.cost === null);
  result.state = 'finished'; result.finishedAt = new Date().toISOString();
  const sanitized = clean(result); checkpoint(sanitized); apiKey = '';
  return sanitized;
}

export function blindView(c, result) {
  return { caseId: c.id, title: c.title, system: c.system, request: c.request, question: replacementQuestion,
    outputs: result.calls.map(call => ({ label: call.label, output: call.output,
      reviewable: call.role === 'candidate' && call.status === 'complete',
      availability: call.status !== 'complete' ? 'No complete, usable output; no replacement decision requested.'
        : call.role === 'baseline' ? 'Reference output; no human decision requested.' : replacementQuestion })) };
}

export function recordHuman(result, decisions) {
  if (result.state !== 'finished') throw new Error('An interrupted run cannot be reviewed as complete.');
  const labels = result.calls.filter(c => c.role === 'candidate' && c.status === 'complete').map(c => c.label);
  if (!isDeepStrictEqual(Object.keys(decisions).sort(), [...labels].sort())) throw new Error('Record independent replacement yes/no for every complete candidate, and no baseline decision.');
  for (const value of Object.values(decisions)) choice(value, ['yes', 'no']);
  return { schemaVersion, decisionType: 'baseline_replacement', resultHash: digest(result), recordedAt: new Date().toISOString(), decisions: { ...decisions } };
}

export function verifyHuman(result, human) {
  if (!human || human.schemaVersion !== schemaVersion || human.decisionType !== 'baseline_replacement' || human.resultHash !== digest(result)) throw new Error('Record blind human replacement decisions before revealing prices or grading.');
  recordHuman(result, human.decisions);
}

export function reveal(result, human) {
  verifyHuman(result, human);
  return result.calls.map(call => ({ label: call.label, model: call.model, status: call.status, humanReplacement: human.decisions[call.label] ?? null, measuredCost: call.cost, measuredReduction: call.reduction }));
}

function manualOutcomes(checks) {
  const strict = checks.some(c => c.result === 'fail') ? false : checks.some(c => c.result === 'inconclusive') ? 'inconclusive' : true;
  const critical = checks.filter(c => c.severity === 'critical');
  let acceptable;
  if (critical.some(c => c.result === 'fail')) acceptable = false;
  else if (critical.some(c => c.result === 'inconclusive')) acceptable = 'inconclusive';
  else {
    const required = Math.ceil(checks.length * .8);
    const passed = checks.filter(c => c.result === 'pass').length;
    const unknown = checks.filter(c => c.result === 'inconclusive').length;
    acceptable = passed >= required ? true : passed + unknown >= required ? 'inconclusive' : false;
  }
  return { strict_pass: strict, acceptable_pass: acceptable };
}

export function grade(result, rubric, human, manualChecks = {}) {
  verifyHuman(result, human);
  const judgments = {};
  for (const call of result.calls) {
    if (call.status !== 'complete') {
      const outcome = call.status === 'quality_failure' ? false : 'inconclusive';
      judgments[call.label] = { strict_pass: outcome, acceptable_pass: outcome, reason: call.reason ?? call.status, checks: [] };
    } else if (rubric.type === 'exact_json') {
      let matches = false; let reason = 'ground_truth_mismatch';
      try { matches = isDeepStrictEqual(JSON.parse(call.output), rubric.expected); } catch { reason = 'invalid_json'; }
      judgments[call.label] = { strict_pass: matches, acceptable_pass: matches, reason: matches ? 'exact_json_match' : reason, checks: [] };
    } else {
      const checks = manualChecks[call.label];
      if (!Array.isArray(checks) || !isDeepStrictEqual(checks.map(c => c.id).sort(), rubric.criteria.map(c => c.id).sort())) throw new Error('Every precommitted criterion needs one judgment.');
      for (const check of checks) { choice(check.result, ['pass', 'fail', 'inconclusive']); if (typeof check.evidence !== 'string' || !check.evidence.trim()) throw new Error('Every criterion needs written evidence.'); }
      // Severity comes only from the precommitted rubric, never the reviewer input.
      const classified = rubric.criteria.map(criterion => {
        const check = checks.find(c => c.id === criterion.id);
        return { id: criterion.id, severity: criterion.severity, result: check.result, evidence: check.evidence };
      });
      judgments[call.label] = { ...manualOutcomes(classified), reason: 'precommitted_manual_rubric', checks: classified };
    }
  }
  return { schemaVersion, resultHash: digest(result), humanHash: digest(human), rubricHash: digest(rubric), recordedAt: new Date().toISOString(), judgments };
}

export function verifyReview(result, rubric, human, review) {
  verifyHuman(result, human);
  if (review.schemaVersion !== schemaVersion || review.resultHash !== digest(result) || review.humanHash !== digest(human) || review.rubricHash !== digest(rubric)) throw new Error('Review does not match the locked outputs/criteria.');
  const rebuilt = grade(result, rubric, human, Object.fromEntries(Object.entries(review.judgments).map(([label, value]) => [label, value.checks])));
  if (!isDeepStrictEqual(rebuilt.judgments, review.judgments)) throw new Error('Review judgments do not match their evidence.');
}

const fraction = (numerator, denominator) => ({ numerator, denominator, percent: denominator ? 100 * numerator / denominator : null });
const median = values => { const ordered = [...values].sort((a, b) => a - b); const n = ordered.length; return n ? (ordered[Math.floor((n - 1) / 2)] + ordered[Math.floor(n / 2)]) / 2 : null; };

function groupMetrics(entries) {
  const n = entries.length;
  let accepted = 0, astra = 0, pendingHuman = 0, pendingRubric = 0;
  let attemptedCalls = 0, budgetCalls = 0, technicalCalls = 0;
  const humanSavings = [];
  const outcomes = Object.fromEntries(['strict', 'acceptable'].map(name => [name, {
    qualified: 0, luna: 0, sol: 0, assessedYes: 0, falseYes: 0, failureOutputs: 0, inconclusive: 0,
    savings: [], falseCases: [], falseOutputs: [],
  }]));
  for (const { result, human, review } of entries) {
    const candidates = result.calls.slice(1);
    const replace = call => human?.decisions[call.label] === 'yes';
    const isAstra = result.baselineModel === 'gpt-6-astra';
    astra += Number(isAstra);
    accepted += Number(candidates.some(replace));
    // One replacement per workload, in existing quality order; never cheapest-first.
    const humanSelected = candidates.find(c => replace(c) && c.status === 'complete' && c.reduction > 0);
    if (humanSelected) humanSavings.push(humanSelected.reduction * 100);
    for (const call of result.calls) {
      if (call.attempted) attemptedCalls++;
      if (call.status === 'inconclusive_output_budget') budgetCalls++;
      if (['inconclusive_technical', 'running'].includes(call.status)) technicalCalls++;
      if (result.state === 'finished' && call.status === 'complete') {
        if (call.role === 'candidate' && !human?.decisions[call.label]) pendingHuman++;
        if (!review?.judgments[call.label]) pendingRubric++;
      }
    }
    for (const [name, metrics] of Object.entries(outcomes)) {
      const outcome = call => review?.judgments[call.label]?.[`${name}_pass`];
      const pass = call => outcome(call) === true;
      metrics.qualified += Number(candidates.some(pass));
      metrics.luna += Number(candidates.some(c => c.model === 'gpt-6-luna' && pass(c)));
      metrics.sol += Number(isAstra && candidates.some(c => c.model === 'gpt-6.1-sol' && pass(c)));
      const selected = candidates.find(c => pass(c) && c.status === 'complete' && c.reduction > 0);
      if (selected) metrics.savings.push(selected.reduction * 100);
      let caseFalse = false, caseInconclusive = result.state !== 'finished';
      for (const call of result.calls) {
        const judgment = outcome(call);
        if (call.status === 'quality_failure' || judgment === false) metrics.failureOutputs++;
        if (['inconclusive_output_budget', 'inconclusive_technical', 'not_run', 'running'].includes(call.status) || judgment === 'inconclusive') caseInconclusive = true;
        if (call.role === 'candidate' && replace(call) && typeof judgment === 'boolean') {
          metrics.assessedYes++;
          if (judgment === false) { metrics.falseYes++; caseFalse = true; metrics.falseOutputs.push({ caseId: result.caseId, label: call.label }); }
        }
      }
      metrics.inconclusive += Number(caseInconclusive);
      if (caseFalse) metrics.falseCases.push(result.caseId);
    }
  }
  const { strict, acceptable } = outcomes;
  const falseConfidence = metrics => ({ ...fraction(metrics.falseYes, metrics.assessedYes), affectedWorkloads: metrics.falseCases, outputs: metrics.falseOutputs });
  const savingsMedian = values => ({ percent: median(values), workloads: values.length });
  return {
    attemptedWorkloads: n, provisional: pendingHuman > 0 || pendingRubric > 0,
    interruptedWorkloads: entries.filter(e => e.result.state !== 'finished').length,
    cheaperModelAcceptance: fraction(accepted, n),
    strictRubricQualifiedReplacement: fraction(strict.qualified, n), acceptableRubricQualifiedReplacement: fraction(acceptable.qualified, n),
    strictLunaReplacement: fraction(strict.luna, n), acceptableLunaReplacement: fraction(acceptable.luna, n),
    strictSolReplacementAmongAstra: fraction(strict.sol, astra), acceptableSolReplacementAmongAstra: fraction(acceptable.sol, astra),
    falseConfidence: falseConfidence(acceptable), strictFalseConfidence: falseConfidence(strict),
    medianMeasuredSavingsAmongHumanAccepted: savingsMedian(humanSavings),
    medianMeasuredSavingsAmongStrictRubricPassed: savingsMedian(strict.savings),
    medianMeasuredSavingsAmongAcceptableRubricPassed: savingsMedian(acceptable.savings),
    inconclusive: fraction(acceptable.inconclusive, n), strictInconclusive: fraction(strict.inconclusive, n),
    attemptedCalls, outputBudgetCalls: budgetCalls, technicalFailureCalls: technicalCalls,
    qualityFailureOutputs: acceptable.failureOutputs, strictFailureOutputs: strict.failureOutputs,
    pendingHumanOutputs: pendingHuman, pendingRubricOutputs: pendingRubric,
  };
}

export function summarize(suite, entries) {
  const ids = new Set();
  for (const entry of entries) {
    const { result, human, review } = entry;
    const c = findCase(suite, result.caseId);
    if (result.schemaVersion !== schemaVersion || ids.has(c.id) || result.suiteFingerprint !== suite.fingerprint || result.baselineModel !== c.baselineModel || result.category !== c.category) throw new Error('Duplicate or incompatible result.');
    ids.add(c.id);
    const plan = casePlan(c);
    if (!isDeepStrictEqual(result.plan, plan) || !isDeepStrictEqual(result.calls.map(call => [call.model, call.role]), plan.calls.map(call => [call.model, call.role]))) throw new Error('Results do not match the frozen ladder/plan.');
    if (human) verifyHuman(result, human);
    if (review) verifyReview(result, suite.rubrics.cases[c.id], human, review);
  }
  const attempted = entries.filter(e => e.result.calls.some(c => c.attempted));
  return { schemaVersion, suiteId: suite.fixtures.suiteId, plannedWorkloads: suite.fixtures.cases.length,
    unrunWorkloads: suite.fixtures.cases.length - attempted.length,
    definitions: 'Quality rates use attempted workloads (including failures). Human yes means replace the visible baseline, independently for each candidate. Strict/acceptable rubric rates grade candidates independently of human decisions and baseline correctness. Candidate means the configured lower-priced model, not guaranteed lower measured cost. Savings medians require positive observed reduction and choose the first qualifying candidate in quality order. Primary false confidence uses human-yes candidate outputs with acceptable_pass=false; its denominator includes only human-yes outputs with boolean acceptable_pass. Strict false confidence is reported separately. Inconclusive/pending judgments are excluded from the respective false-confidence denominator. Primary inconclusive and quality-failure totals use acceptable results; strict totals are separate. Partial reviews make rates provisional.',
    overall: groupMetrics(attempted),
    byCategory: Object.fromEntries(categories.map(category => [category, groupMetrics(attempted.filter(e => e.result.category === category))])),
  };
}

export function catalog(suite) {
  return '# Precommitted SMB benchmark cases\n\nSynthetic, realistic business records; no real customer data. All prompts and criteria below are fixed before paid calls. Six exact-JSON evaluations and six manual rubrics; no canonical prose answers. Manual criteria retain their approved wording and have precommitted critical/secondary severity. Strict requires every criterion; acceptable requires every critical criterion and at least 80% of all criteria. See README.md for inconclusive handling and classification rationale.\n\n' + suite.fixtures.cases.map(c => {
    const r = suite.rubrics.cases[c.id];
    const evaluation = r.type === 'exact_json' ? `${r.rationale}\n\n\`\`\`json\n${JSON.stringify(r.expected, null, 2)}\n\`\`\`` : r.criteria.map(item => `- **${item.id} (${item.severity}):** ${item.requirement}`).join('\n') + `\n\n**Critical omissions:** ${r.criticalOmissions}`;
    return `## ${c.id} — ${c.title}\n\nCategory: ${c.category} · Baseline: ${c.baselineModel} · Evaluation: ${c.evaluationType}\n\n### System prompt\n\n${c.system}\n\n### User request\n\n${c.request}\n\n### Hidden evaluation (never sent to models)\n\n${evaluation}\n`;
  }).join('\n');
}
