// Pricing reverified against official OpenAI docs on 2026-10-04. USD per 1M text tokens.
// Public Standard rates only: no regional/custom pricing, tools, or other tiers.
export const PRICING = {
  checkedAt: '2026-10-04',
  source: 'https://developers.openai.com/api/docs/pricing',
  cacheSource: 'https://developers.openai.com/api/docs/guides/prompt-caching',
  responseSource: 'https://developers.openai.com/api/reference/cli/resources/responses/methods/create',
  reasoningSource: 'https://developers.openai.com/api/docs/guides/reasoning',
};

function modelMetadata(id, name, short, long, reasoningEfforts) {
  return {
    id, name, context: 1050000, maxOutputTokens: 128000, reasoningEfforts,
    // Only aliases currently documented on the model pages; never infer snapshots.
    returnedModels: [id],
    source: `https://developers.openai.com/api/docs/models/${id}`,
    pricing: {
      modelId: id, checkedAt: PRICING.checkedAt, source: PRICING.source,
      serviceTier: 'default', longContextAbove: 272000,
      // Strictly MORE than 272,000 total input tokens, including reads/writes.
      // Long rates apply to the FULL request, not just the excess tokens.
      short, long,
    },
  };
}

export const MODELS = {
  'gpt-6-astra': modelMetadata('gpt-6-astra', 'GPT-6 Astra',
    { input: 10, cached: 1, cacheWrite: 12.5, output: 50 },
    { input: 20, cached: 2, cacheWrite: 25, output: 75 },
    ['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6.1-sol': modelMetadata('gpt-6.1-sol', 'GPT-6.1 Sol',
    { input: 2, cached: .1, cacheWrite: 2.5, output: 10 },
    { input: 4, cached: .2, cacheWrite: 5, output: 15 },
    ['low', 'medium', 'high', 'xhigh', 'max']),
  'gpt-6-luna': modelMetadata('gpt-6-luna', 'GPT-6 Luna',
    { input: .1, cached: .01, cacheWrite: .125, output: .5 },
    { input: .2, cached: .02, cacheWrite: .25, output: .75 },
    ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
};

// Execution and user review follow this quality-prioritized order. Never sort by cost.
export const CANDIDATES = {
  'gpt-6-astra': ['gpt-6.1-sol', 'gpt-6-luna'],
  'gpt-6.1-sol': ['gpt-6-luna'],
};

// One configuration for every comparable call and the copied suggested setup.
// This V0 has no user-configurable reasoning or pricing overrides.
export const BENCHMARK_SETTINGS = {
  reasoning: { effort: 'medium', mode: 'standard', context: 'current_turn' },
  text: { format: { type: 'text' }, verbosity: 'medium' },
  prompt_cache_options: { mode: 'implicit', ttl: '30m' },
};

export const LIMITS = {
  budgetUsd: 0.05,
  hardBudgetUsd: 0.25,
  maxCandidates: 2,
  maxCalls: 3,
  // Includes visible output AND reasoning. 4,096 would exceed the $0.25
  // three-call Astra budget even for the supplied sample; see README.
  maxOutputTokens: 2048,
  maxInputBytes: 48000,
  maxResponseBytes: 100000,
  timeoutMs: 45000,
  retries: 0,
};

export const MODEL_OPTIONS = Object.keys(CANDIDATES).map(id => ({ id, name: MODELS[id].name }));
export const modelName = id => MODELS[id]?.name || id;
const tokenCount = n => Number.isSafeInteger(n) && n >= 0;

export function pricingForUsage(model, inputTokens, serviceTier = 'default') {
  const metadata = Object.hasOwn(MODELS, model) && MODELS[model];
  if (!metadata || serviceTier !== 'default') throw new RangeError('Unsupported model pricing or service tier.');
  if (!tokenCount(inputTokens)) throw new RangeError('Invalid input usage.');
  const { short, long, ...pricing } = metadata.pricing;
  const contextBand = inputTokens > pricing.longContextAbove ? 'long' : 'short';
  return { ...pricing, contextBand, rates: contextBand === 'long' ? long : short };
}

export function costFromUsage(model, usage, serviceTier = 'default') {
  const { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens } = usage;
  if (![inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens].every(tokenCount)
      || cachedInputTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens) {
    throw new RangeError('Missing or invalid token usage.');
  }
  const { rates } = pricingForUsage(model, inputTokens, serviceTier);
  const ordinaryInput = inputTokens - cachedInputTokens - cacheWriteTokens;
  // Reasoning tokens are a SUBSET of output_tokens, already billed here once.
  return (ordinaryInput * rates.input + cachedInputTokens * rates.cached
    + cacheWriteTokens * rates.cacheWrite + outputTokens * rates.output) / 1e6;
}

export function costReduction(baselineCost, candidateCost) {
  if (!Number.isFinite(baselineCost) || baselineCost <= 0 || !Number.isFinite(candidateCost) || candidateCost < 0) throw new RangeError('Invalid benchmark costs.');
  return (baselineCost - candidateCost) / baselineCost;
}
