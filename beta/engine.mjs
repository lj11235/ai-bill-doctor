import { getReviewCandidates } from '../lib/benchmark.mjs';
import { callProvider } from './provider.mjs';
import { costFromUsage, LIMITS, PRICING } from '../src/models.js';
import { BetaError, POLICY, requireThat, units } from './policy.mjs';

// All provider calls pass through durable dispatch/usage checkpoints. There is no retry path.
export async function benchmark({
  ledger,
  reservation,
  input,
  plan,
  apiKey,
  signal,
  emit = () => {},
  provider = callProvider,
  guardIntervalMs = 1000,
}) {
  const { id, owner } = reservation;
  const measured = [];
  const failures = [];
  let baseline;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(abort, POLICY.runTimeoutMs);
  let uncertain = false,
    settled = false;
  try {
    for (const [index, call] of plan.calls.entries()) {
      requireThat(!controller.signal.aborted, 'cancelled');
      await ledger.dispatch(id, owner, index); // COMMIT must be acknowledged before dispatch.
      uncertain = true;
      requireThat(!controller.signal.aborted, 'cancelled');
      emit({
        type: 'progress',
        index,
        total: plan.calls.length,
        model: call.model,
        role: call.role,
        state: 'running',
      });
      let guardBusy = false,
        guardError;
      const interval = setInterval(async () => {
        if (guardBusy) return;
        guardBusy = true;
        try {
          await ledger.guard(id, owner);
        } catch (error) {
          guardError = error;
          controller.abort();
        } finally {
          guardBusy = false;
        }
      }, guardIntervalMs);
      let rejectAbort;
      const cancelled = new Promise((_, reject) => {
        rejectAbort = () => reject(guardError ?? new BetaError('cancelled'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      let result;
      try {
        result = await Promise.race([
          provider({ model: call.model, input, apiKey, signal: controller.signal }),
          cancelled,
        ]);
        requireThat(!controller.signal.aborted, 'cancelled');
        requireThat(
          result.model === call.model && Number.isFinite(result.cost) && result.cost >= 0,
          'pricing',
        );
        requireThat(
          result.usage?.inputTokens <= plan.inputTokenBound &&
            result.usage?.outputTokens <= LIMITS.maxOutputTokens,
          'pricing',
        );
        let recalculated;
        try {
          recalculated = costFromUsage(call.model, result.usage);
        } catch {
          throw new BetaError('pricing');
        }
        requireThat(
          Math.abs(recalculated - result.cost) < 1e-12 && units(result.cost) <= units(call.maxCost),
          'pricing',
        );
        await ledger.recordCall(id, owner, index, result);
        uncertain = false;
      } finally {
        clearInterval(interval);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
      measured.push(result);
      emit({
        type: 'progress',
        index,
        total: plan.calls.length,
        model: call.model,
        role: call.role,
        state: result.complete ? 'complete' : 'failed',
      });
      if (index === 0) {
        if (!result.complete || result.cost <= 0) {
          await ledger.settle(id, owner);
          settled = true;
          throw new BetaError('incomplete');
        }
        baseline = {
          ...result,
          displayOutput: input.response.trim() ? input.response : result.output,
          outputSource: input.response.trim() ? 'pasted' : 'benchmark',
        };
      } else if (!result.complete)
        failures.push({
          model: call.model,
          code: 'incomplete',
          message: 'This answer did not complete and is excluded from savings comparisons.',
        });
    }
    requireThat(!controller.signal.aborted, 'cancelled');
    await ledger.settle(id, owner, { complete: true });
    settled = true;
    return {
      baseline,
      candidates: getReviewCandidates(measured.slice(1), baseline.cost),
      measured,
      failures,
      plan,
      measuredBenchmarkCost: measured.reduce((n, c) => n + c.cost, 0),
      costMayBeIncomplete: false,
      pricing: PRICING,
      runId: id,
    };
  } catch (error) {
    const trip =
      error instanceof RangeError ||
      [
        'pricing',
        'unsupported_pricing',
        'missing_usage',
        'incomparable_settings',
        'budget_limit',
        'invalid_key',
        'quota',
        'rate_limit',
        'model_unavailable',
      ].includes(error?.code);
    if (!settled) {
      try {
        if (uncertain || trip) await ledger.hold(id, owner, trip);
        else await ledger.settle(id, owner);
      } catch {
        try {
          await ledger.hold(id, owner, trip);
        } catch {
          /* Existing reservation and slot remain held. */
        }
      }
    }
    if (error instanceof BetaError) throw error;
    const unpriceable = [
      'unsupported_pricing',
      'missing_usage',
      'incomparable_settings',
      'budget_limit',
    ].includes(error?.code);
    throw new BetaError(unpriceable ? 'pricing' : 'provider');
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    apiKey = '';
  }
}
