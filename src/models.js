// Manually verified against official OpenAI model pages on 2026-09-26.
// USD per 1 million tokens, standard service tier, text only. No Batch,
// regional uplift, negotiated discounts, taxes, tools, or fine-tuned models.
export const PRICING = {
  checkedAt: '2026-09-26',
  source: 'https://developers.openai.com/api/docs/pricing',
};

export const MODELS = {
  'gpt-4o': {
    name: 'GPT-4o', input: 2.5, cached: 1.25, output: 10, context: 128000,
    snapshots: ['gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
    source: 'https://developers.openai.com/api/docs/models/gpt-4o',
  },
  'gpt-4.1': {
    name: 'GPT-4.1', input: 2, cached: 0.5, output: 8, context: 1047576,
    snapshots: ['gpt-4.1-2025-04-14'],
    source: 'https://developers.openai.com/api/docs/models/gpt-4.1',
  },
  'gpt-4.1-mini': {
    name: 'GPT-4.1 mini', input: 0.4, cached: 0.1, output: 1.6, context: 1047576,
    snapshots: ['gpt-4.1-mini-2025-04-14'],
    source: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
  },
  'gpt-4o-mini': {
    name: 'GPT-4o mini', input: 0.15, cached: 0.075, output: 0.6, context: 128000,
    snapshots: ['gpt-4o-mini-2024-07-18'],
    source: 'https://developers.openai.com/api/docs/models/gpt-4o-mini',
  },
};

// Quality-prioritized order for both execution and user review. Do not sort by cost.
// GPT-4.1 nano is deliberately excluded: scheduled for shutdown 2026-10-23.
// This V0 accepts plain text only; it cannot test tools, images, or JSON schemas.
export const CANDIDATES = {
  'gpt-4o': ['gpt-4.1-mini', 'gpt-4o-mini'],
  'gpt-4.1': ['gpt-4.1-mini', 'gpt-4o-mini'],
  'gpt-4.1-mini': ['gpt-4o-mini'],
};

export const LIMITS = {
  budgetUsd: 0.05,
  hardBudgetUsd: 0.25,
  maxCandidates: 2,
  maxCalls: 3,
  maxOutputTokens: 1024,
  maxInputBytes: 48000,
  maxResponseBytes: 100000,
  timeoutMs: 45000,
  retries: 0,
};

export const MODEL_OPTIONS = Object.keys(CANDIDATES).map(id => ({ id, name: MODELS[id].name }));
export const modelName = id => MODELS[id]?.name || id;

export function costFromUsage(model, usage) {
  const rates = Object.hasOwn(MODELS, model) && MODELS[model];
  if (!rates) throw new RangeError('Unsupported model pricing.');
  const { inputTokens, cachedInputTokens = 0, outputTokens } = usage;
  if (![inputTokens, cachedInputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) || cachedInputTokens > inputTokens) {
    throw new RangeError('Invalid token usage.');
  }
  return ((inputTokens - cachedInputTokens) * rates.input + cachedInputTokens * rates.cached + outputTokens * rates.output) / 1e6;
}

export function costReduction(baselineCost, candidateCost) {
  if (!Number.isFinite(baselineCost) || baselineCost <= 0 || !Number.isFinite(candidateCost) || candidateCost < 0) throw new RangeError('Invalid benchmark costs.');
  return (baselineCost - candidateCost) / baselineCost;
}
