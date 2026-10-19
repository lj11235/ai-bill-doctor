import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildPlan, validateInput } from '../lib/benchmark.mjs';

export const POLICY = Object.freeze({
  perRun: 250000000,
  daily: 5000000000,
  lifetime: 50000000000,
  concurrency: 2,
  visitorDaily: 3,
  ipDaily: 3,
  requestsPerMinute: 30,
  maxBodyBytes: 180000,
  runTimeoutMs: 150000,
});
export const pricingHash = createHash('sha256')
  .update(readFileSync(new URL('../src/models.js', import.meta.url)))
  .digest('hex');
export const units = (usd) => {
  if (!Number.isFinite(usd) || usd < 0 || usd > 100) throw new BetaError('pricing');
  return Math.ceil(usd * 1e9);
};
const messages = {
  unavailable: [503, 'The beta is temporarily unavailable. No automatic retry was made.'],
  paused: [503, 'The beta is paused. Please check back later.'],
  budget: [429, 'The beta has reached its spending limit. Please check back later.'],
  busy: [429, 'Two benchmarks are already in progress. Please try again later.'],
  quota: [429, 'Today’s free benchmark limit has been reached for this browser or network.'],
  throttle: [429, 'Too many requests. Please wait a minute.'],
  duplicate: [
    409,
    'This submission has already been admitted. It will not run again. Results are not stored for replay.',
  ],
  conflict: [409, 'This submission ID is already in use. Start a new benchmark explicitly.'],
  input: [400, 'Choose a supported model and paste one text request within the size limit.'],
  verification: [403, 'Verification failed or expired. Complete the check again.'],
  origin: [403, 'Please use the AI Bill Doctor page to make this request.'],
  session: [403, 'Reload this page to start a fresh anonymous session.'],
  pricing: [503, 'The returned pricing or usage could not be verified. No comparison was made.'],
  provider: [502, 'The model call could not finish. No automatic retry was made.'],
  incomplete: [422, 'The current model did not complete this sample. Try a smaller request.'],
  cancelled: [409, 'The benchmark stopped. A submitted call may still have incurred a cost.'],
};
export class BetaError extends Error {
  constructor(code) {
    const [status, message] = messages[code] ?? messages.unavailable;
    super(message);
    this.code = Object.hasOwn(messages, code) ? code : 'unavailable';
    this.status = status;
  }
}
export const requireThat = (condition, code = 'input') => {
  if (!condition) throw new BetaError(code);
};
export function exactKeys(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every((k) => keys.includes(k)));
}
export const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function planInput(raw) {
  exactKeys(raw, ['model', 'system', 'request', 'response']);
  try {
    const input = validateInput(raw);
    return { input, plan: buildPlan(input, 0.25) };
  } catch {
    throw new BetaError('input');
  }
}
