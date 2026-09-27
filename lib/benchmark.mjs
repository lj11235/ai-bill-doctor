import { MODELS, CANDIDATES, LIMITS, PRICING, costFromUsage, costReduction } from '../src/models.js';
import { BenchmarkError, publicError } from './errors.mjs';
import { callOpenAI } from './provider.mjs';

export function validateInput(value) {
  if (!value || !Object.hasOwn(CANDIDATES, value.model)) throw new BenchmarkError('unsupported_model', 'This V0 supports GPT-4o, GPT-4.1, and GPT-4.1 mini as current models. Choose the model you actually use.');
  const input = {};
  for (const field of ['model', 'request', 'system', 'response']) {
    const text = value[field] ?? '';
    if (typeof text !== 'string') throw new BenchmarkError('invalid_input', 'Please paste plain text for this benchmark.');
    input[field] = text;
  }
  if (!input.request.trim()) throw new BenchmarkError('invalid_input', 'Paste one real request to continue.');
  if (Buffer.byteLength(input.system + input.request, 'utf8') > LIMITS.maxInputBytes || Buffer.byteLength(input.response, 'utf8') > LIMITS.maxResponseBytes) {
    throw new BenchmarkError('context_too_long', 'This example is too large for a quick benchmark. Shorten it and try again.');
  }
  return input;
}

export function buildPlan(value, budgetUsd = LIMITS.budgetUsd) {
  const input = validateInput(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > LIMITS.hardBudgetUsd) throw new BenchmarkError('configuration', 'The local benchmark budget is not configured correctly.', 500);
  // Conservative text estimate: one token per UTF-8 byte plus 512 tokens of
  // message overhead. No cache discount; reserve the entire output allowance.
  // This is intentionally an upper estimate, not an exact tokenizer count.
  const inputTokenBound = Buffer.byteLength(input.system + input.request, 'utf8') + 512;
  const ids = [input.model, ...CANDIDATES[input.model].slice(0, LIMITS.maxCandidates)].slice(0, LIMITS.maxCalls);
  const calls = ids.map((model, index) => {
    if (inputTokenBound + LIMITS.maxOutputTokens > MODELS[model].context) throw new BenchmarkError('context_too_long', 'This request is too long for one of the smaller models.');
    return { model, role: index === 0 ? 'baseline' : 'candidate', maxCost: costFromUsage(model, { inputTokens: inputTokenBound, outputTokens: LIMITS.maxOutputTokens }) };
  });
  const maxCost = Math.ceil(calls.reduce((total, call) => total + call.maxCost, 0) * 1e6) / 1e6;
  if (maxCost > LIMITS.hardBudgetUsd) throw new BenchmarkError('budget_limit', 'This benchmark is too expensive for V0. Use a smaller request.');
  return { calls, maxCost, budgetUsd, requiresConfirmation: maxCost > budgetUsd, inputTokenBound, maxOutputTokens: LIMITS.maxOutputTokens, pricing: PRICING };
}

export function rankCandidates(candidates, baselineCost) {
  return candidates.filter(item => item.complete && Number.isFinite(item.cost) && item.cost >= 0 && item.cost < baselineCost)
    .map(item => ({ ...item, reduction: costReduction(baselineCost, item.cost) }))
    .sort((a, b) => a.cost - b.cost || a.model.localeCompare(b.model));
}

export async function runBenchmark({ input: rawInput, apiKey, approvedMaxCost, budgetUsd = LIMITS.budgetUsd, signal, emit = () => {}, provider = callOpenAI }) {
  try {
    const input = validateInput(rawInput);
    const plan = buildPlan(input, budgetUsd);
    if (plan.requiresConfirmation && !(typeof approvedMaxCost === 'number' && approvedMaxCost >= plan.maxCost && approvedMaxCost <= LIMITS.hardBudgetUsd)) {
      throw new BenchmarkError('budget_confirmation', `This benchmark needs your approval for up to $${plan.maxCost.toFixed(4)}. No model calls were made.`);
    }
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(apiKey)) throw new BenchmarkError('invalid_key', 'Enter a valid OpenAI API key.', 401);
    const measured = [];
    const failures = [];
    let baseline;
    let reserved = 0;
    for (const [index, call] of plan.calls.entries()) {
      if (signal?.aborted) throw new BenchmarkError('cancelled', 'Benchmark cancelled.', 499);
      // Reserve the whole allowance even for failed/ambiguous calls. Never retry.
      if (reserved + call.maxCost > plan.maxCost + 1e-9) throw new BenchmarkError('budget_limit', 'Stopped at the benchmark spending limit.');
      reserved += call.maxCost;
      emit({ type: 'progress', index, total: plan.calls.length, model: call.model, role: call.role, state: 'running' });
      try {
        const result = await provider({ model: call.model, input, apiKey, signal });
        measured.push(result);
        if (!result.complete) {
          const message = result.issue === 'output_limit'
            ? 'The answer hit the benchmark output limit. It is excluded from savings comparisons.'
            : 'This model did not return a usable answer. It is excluded from savings comparisons.';
          if (index === 0) throw new BenchmarkError('baseline_incomplete', `${message} Try a request with a shorter expected answer.`, 422);
          failures.push({ model: call.model, code: result.issue, message });
        } else if (index === 0) {
          if (result.cost <= 0) throw new BenchmarkError('missing_usage', 'The baseline could not be priced reliably.', 502);
          baseline = { ...result, displayOutput: input.response.trim() ? input.response : result.output, outputSource: input.response.trim() ? 'pasted' : 'benchmark' };
        }
        emit({ type: 'progress', index, total: plan.calls.length, model: call.model, role: call.role, state: result.complete ? 'complete' : 'failed' });
        if (result.cost > call.maxCost + 1e-9) throw new BenchmarkError('budget_limit', 'Actual usage exceeded our conservative estimate. Further calls were stopped.', 422);
      } catch (error) {
        if (index === 0 || ['invalid_key', 'quota', 'cancelled', 'budget_limit'].includes(error.code)) throw error;
        failures.push({ model: call.model, ...publicError(error) });
        emit({ type: 'progress', index, total: plan.calls.length, model: call.model, role: call.role, state: 'failed' });
        // Stop following calls on timeout/transport errors with uncertain charges.
        if (['timeout', 'provider_error', 'rate_limit'].includes(error.code)) break;
      }
    }
    const candidates = rankCandidates(measured.slice(1), baseline.cost);
    return {
      baseline, candidates, measured, failures, plan,
      measuredBenchmarkCost: measured.reduce((sum, item) => sum + item.cost, 0),
      costMayBeIncomplete: failures.some(item => !measured.some(call => call.model === item.model)),
      pricing: PRICING,
    };
  } finally {
    apiKey = '';
  }
}
