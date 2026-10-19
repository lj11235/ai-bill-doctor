import { readFileSync, readdirSync, mkdirSync, lstatSync, existsSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, linkSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { loadSuite, verifyManifest, casePlan, caseInput, executeCase, observedProvider, digest, projectRoot } from '../benchmark/runner.mjs';
import { costFromUsage } from '../../src/models.js';

export const FINGERPRINT = 'a23797b9ab0c372ce014b64a0eda22c1751da4726f129486f4ef9f2e6dcfdd70';
export const CEILING_MICROS = 1500000;
const defaultRoot = fileURLToPath(projectRoot);
const safeReasons = new Set(['rate_limit', 'quota', 'invalid_key', 'model_unavailable', 'context_too_long', 'provider_error', 'unsupported_pricing', 'incomparable_settings', 'missing_usage', 'timeout', 'cancelled', 'budget_limit', 'budget_confirmation', 'unknown_charges', 'unexpected_provider_behavior', 'accounting_uncertain', 'lock_mismatch', 'existing_attempt', 'approval_required', 'invalid_key_format']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const reason = error => safeReasons.has(error?.code) ? error.code : 'accounting_uncertain';
const hashFile = path => digest(readFileSync(path, 'utf8'));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const regular = path => { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('accounting_uncertain'); };
const directory = path => { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('accounting_uncertain'); };
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

// New journal files are immutable. A leftover temporary file fails closed.
// Case checkpoints replace only files owned and hash-checked by this process.
export function durableJson(path, value, replace = false) {
  const temporary = path + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (replace) renameSync(temporary, path);
  else { linkSync(temporary, path); unlinkSync(temporary); }
  syncDirectory(dirname(path));
}

function originalFiles(path, prefix = '') {
  directory(path);
  return Object.fromEntries(readdirSync(path).sort().flatMap(name => {
    const relative = prefix + name; const full = join(path, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) fail('accounting_uncertain');
    if (stat.isDirectory()) return Object.entries(originalFiles(full, relative + '/'));
    regular(full); return [[relative, hashFile(full)]];
  }));
}
const micros = usd => {
  const value = Math.round(usd * 1e6);
  if (!Number.isSafeInteger(value) || value <= 0 || Math.abs(value / 1e6 - usd) > 1e-12) fail('accounting_uncertain');
  return value;
};

function snapshotValid(record, c, suite) {
  const plan = casePlan(c);
  if (record?.schemaVersion !== 2 || record.suiteFingerprint !== suite.fingerprint || record.caseId !== c.id
      || record.category !== c.category || record.baselineModel !== c.baselineModel
      || !isDeepStrictEqual(record.plan, plan) || !Array.isArray(record.calls)
      || !isDeepStrictEqual(record.calls.map(call => [call.model, call.role]), plan.calls.map(call => [call.model, call.role]))
      || !['running', 'finished'].includes(record.state)) fail('accounting_uncertain');
}

function stopFor(record, c) {
  const plan = casePlan(c);
  for (const [i, call] of record.calls.entries()) {
    if (!call.attempted || call.status === 'running') continue;
    if (call.cost === null) return safeReasons.has(call.reason) ? call.reason : 'unknown_charges';
    try {
      if (!Number.isFinite(call.cost) || call.cost < 0 || Math.abs(costFromUsage(call.model, call.usage) - call.cost) > 1e-12) return 'accounting_uncertain';
    } catch { return 'accounting_uncertain'; }
    if (call.cost > plan.calls[i].maxCost + 1e-9) return 'budget_limit';
    if (!['complete', 'inconclusive_output_budget', 'quality_failure'].includes(call.status)) return 'unexpected_provider_behavior';
    if (!isDeepStrictEqual(call.settings, plan.settings)) return 'unexpected_provider_behavior';
  }
  if (record.state === 'finished' && !['complete', 'baseline_incomplete'].includes(record.engineOutcome)) {
    return safeReasons.has(record.engineOutcome) ? record.engineOutcome : 'unexpected_provider_behavior';
  }
  return null;
}

// root/provider/write are dependency-injection seams for offline tests. The CLI
// always uses the repository, observedProvider, and durableJson without overrides.
export function createBatch({ root = defaultRoot, provider = observedProvider, write = durableJson, suiteLoader = loadSuite } = {}) {
  const experiment = join(root, 'outputs/internal-benchmark/smb-v1');
  const batchParent = join(root, 'outputs/internal-batch');
  const batch = join(batchParent, 'smb-v1-cases-02-12');
  const manifestPath = join(experiment, 'manifest.json');
  const resultPath = c => join(experiment, c.id, 'result.json');

  function inspect() {
    let suite, manifest;
    try {
      directory(experiment); regular(manifestPath);
      suite = suiteLoader(); manifest = json(manifestPath); verifyManifest(suite, manifest);
      if (manifest.experimentId !== 'smb-v1' || suite.fingerprint !== FINGERPRINT) fail('lock_mismatch');
    } catch { fail('lock_mismatch'); }
    const first = suite.fixtures.cases[0];
    regular(resultPath(first));
    const prior = json(resultPath(first)); snapshotValid(prior, first, suite);
    if (prior.state !== 'finished' || prior.calls[0].status !== 'inconclusive_technical') fail('existing_attempt');
    const cases = suite.fixtures.cases.slice(1);
    const plans = cases.map(c => ({ caseId: c.id, reservedMicros: micros(casePlan(c).maxCost), maximumCalls: casePlan(c).calls.length }));
    if (plans.some(p => p.reservedMicros > 250000 || p.maximumCalls < 2 || p.maximumCalls > 3)) fail('budget_limit');
    const totalMicros = plans.reduce((n, p) => n + p.reservedMicros, 0);
    if (totalMicros > CEILING_MICROS) fail('budget_limit');
    return { suite, cases, plans, totalMicros, preserved: {
      manifest: hashFile(manifestPath), case01: originalFiles(join(experiment, first.id)),
    } };
  }

  function fresh(spec) {
    if (existsSync(batch) || spec.cases.some(c => existsSync(join(experiment, c.id)))) fail('existing_attempt');
  }

  function preview() {
    const spec = inspect(); fresh(spec);
    return { experiment: 'smb-v1', caseIds: spec.cases.map(c => c.id), fingerprint: FINGERPRINT,
      conservativeReservationUsd: spec.totalMicros / 1e6, batchCeilingUsd: CEILING_MICROS / 1e6,
      maximumApiCalls: spec.plans.reduce((n, p) => n + p.maximumCalls, 0), retries: 0,
      priorCase01: 'Preserved and excluded from new batch totals; its charge remains unknown.' };
  }

  function status() {
    const spec = inspect();
    const result = { experiment: 'smb-v1', state: 'not_started', stopReason: null,
      completedCases: [], inconclusiveCases: [], unstartedCases: [],
      apiCallsAttempted: 0, conservativeBudgetReservedUsd: 0, knownMeasuredSpendingUsd: 0,
      chargesMayBeUnknown: false, accountingUncertain: false, batchCeilingUsd: CEILING_MICROS / 1e6,
      attemptCountMayBeUpperBound: false };
    if (!existsSync(batch)) { result.unstartedCases = spec.cases.map(c => c.id); return result; }
    try {
      directory(batch);
      const authorization = json(join(batch, 'authorization.json'));
      if (!isDeepStrictEqual(authorization, authorizationFor(spec))) fail('accounting_uncertain');
      const names = readdirSync(batch);
      const allowed = new Set(['authorization.json', 'claimed.json', 'finish.json', ...spec.plans.flatMap(p => {
        const n = p.caseId.slice(0, 2);
        return [`reserve-${n}.json`, `record-${n}.json`, ...Array.from({ length: p.maximumCalls }, (_, i) => `dispatch-${n}-${i}.json`)];
      })]);
      if (names.some(name => !allowed.has(name))) fail('accounting_uncertain');
      if (!isDeepStrictEqual(json(join(batch, 'claimed.json')), { caseIds: spec.cases.map(c => c.id) })) fail('accounting_uncertain');
      let reserved = 0, known = 0;
      let gap = false;
      for (const [i, c] of spec.cases.entries()) {
        const n = c.id.slice(0, 2);
        const reservation = join(batch, `reserve-${n}.json`);
        if (!existsSync(reservation)) {
          if (names.some(name => name.startsWith(`dispatch-${n}-`) || name === `record-${n}.json`)) fail('accounting_uncertain');
          gap = true; result.unstartedCases.push(c.id); continue;
        }
        if (gap || !isDeepStrictEqual(json(reservation), spec.plans[i])) fail('accounting_uncertain');
        reserved += spec.plans[i].reservedMicros;
        let attempts = 0;
        for (let index = 0; index < spec.plans[i].maximumCalls; index++) {
          const path = join(batch, `dispatch-${n}-${index}.json`);
          if (!existsSync(path)) continue;
          if (index !== attempts || !isDeepStrictEqual(json(path), { caseId: c.id, index })) fail('accounting_uncertain');
          attempts++;
        }
        result.apiCallsAttempted += attempts;
        result.conservativeBudgetReservedUsd = reserved / 1e6;
        if (!existsSync(resultPath(c))) {
          result.inconclusiveCases.push(c.id); result.accountingUncertain = true;
          if (attempts) { result.chargesMayBeUnknown = true; result.attemptCountMayBeUpperBound = true; }
          continue;
        }
        regular(resultPath(c)); const record = json(resultPath(c)); snapshotValid(record, c, spec.suite);
        const receipt = join(batch, `record-${n}.json`);
        if (existsSync(receipt) && !isDeepStrictEqual(json(receipt), { caseId: c.id, resultHash: hashFile(resultPath(c)) })) fail('accounting_uncertain');
        if (record.calls.filter(call => call.attempted).length !== attempts) result.attemptCountMayBeUpperBound = true;
        for (const call of record.calls) {
          if (call.attempted && call.cost === null) result.chargesMayBeUnknown = true;
          if (call.cost !== null) {
            if (!Number.isFinite(call.cost) || call.cost < 0 || Math.abs(costFromUsage(call.model, call.usage) - call.cost) > 1e-12) fail('accounting_uncertain');
            known += call.cost;
          }
        }
        result.knownMeasuredSpendingUsd = Number(known.toFixed(12));
        if (record.state === 'finished' && record.calls.every(call => call.status === 'complete')) result.completedCases.push(c.id);
        else result.inconclusiveCases.push(c.id);
        if (!existsSync(receipt)) result.accountingUncertain = true;
      }
      if (reserved > CEILING_MICROS) fail('accounting_uncertain');
      if (existsSync(join(batch, 'finish.json'))) {
        const finish = json(join(batch, 'finish.json'));
        if (!['complete', 'stopped'].includes(finish.state) || (finish.stopReason !== null && !safeReasons.has(finish.stopReason))) fail('accounting_uncertain');
        result.state = finish.state; result.stopReason = finish.stopReason;
        if (finish.state === 'complete' && result.unstartedCases.length) fail('accounting_uncertain');
      } else {
        result.state = 'running_or_interrupted'; result.attemptCountMayBeUpperBound = true;
      }
      if (result.chargesMayBeUnknown) result.attemptCountMayBeUpperBound = true;
    } catch {
      result.state = 'accounting_uncertain'; result.stopReason = 'accounting_uncertain';
      result.accountingUncertain = true; result.chargesMayBeUnknown = true; result.attemptCountMayBeUpperBound = true;
      result.apiCallsAttempted = null; result.conservativeBudgetReservedUsd = null; result.knownMeasuredSpendingUsd = null;
    }
    return result;
  }

  function authorizationFor(spec) {
    return { version: 1, experiment: 'smb-v1', fingerprint: FINGERPRINT, ceilingMicros: CEILING_MICROS,
      totalReservationMicros: spec.totalMicros, plans: spec.plans, preserved: spec.preserved };
  }

  async function run({ paid = false, approvedUsd, apiKey, signal, progress = () => {} } = {}) {
    const spec = inspect(); fresh(spec);
    if (paid !== true || approvedUsd !== CEILING_MICROS / 1e6) fail('approval_required');
    if (typeof apiKey !== 'string' || !/^[\x21-\x7e]{10,512}$/.test(apiKey)) fail('invalid_key_format');
    if (signal?.aborted) fail('cancelled');
    mkdirSync(batchParent, { recursive: true, mode: 0o700 }); directory(batchParent);
    mkdirSync(batch, { mode: 0o700 }); syncDirectory(batchParent); // Permanent single-use gate.
    const owned = new Map();
    const recordHashes = new Map();
    const dispatches = new Map(spec.cases.map(c => [c.id, 0]));
    let reserved = 0, stopReason = null;
    const remember = (name, data) => {
      const path = join(batch, name); write(path, data); owned.set(name, hashFile(path));
    };
    const guard = () => {
      const now = inspect();
      if (!isDeepStrictEqual(now.preserved, spec.preserved) || !isDeepStrictEqual(now.plans, spec.plans)) fail('lock_mismatch');
      if (!isDeepStrictEqual(readdirSync(batch).sort(), [...owned.keys()].sort())) fail('accounting_uncertain');
      for (const [name, hash] of owned) { regular(join(batch, name)); if (hashFile(join(batch, name)) !== hash) fail('accounting_uncertain'); }
      for (const c of spec.cases) {
        const path = join(experiment, c.id); directory(path);
        const files = recordHashes.has(c.id) ? ['result.json'] : [];
        if (!isDeepStrictEqual(readdirSync(path).sort(), files)) fail('accounting_uncertain');
        if (recordHashes.has(c.id)) { regular(resultPath(c)); if (hashFile(resultPath(c)) !== recordHashes.get(c.id)) fail('accounting_uncertain'); }
      }
      const persistedReserved = [...owned.keys()].filter(n => n.startsWith('reserve-')).reduce((sum, name) => sum + json(join(batch, name)).reservedMicros, 0);
      if (persistedReserved !== reserved || reserved > CEILING_MICROS) fail('accounting_uncertain');
      if (signal?.aborted) fail('cancelled');
    };
    try {
      remember('authorization.json', authorizationFor(spec));
      // Claim every remaining case before any calls. The frozen single-case CLI
      // also uses exclusive mkdir, so a concurrent operator cannot run one twice.
      for (const c of spec.cases) mkdirSync(join(experiment, c.id), { mode: 0o700 });
      syncDirectory(experiment); remember('claimed.json', { caseIds: spec.cases.map(c => c.id) });
      for (const [i, c] of spec.cases.entries()) {
        guard();
        const p = spec.plans[i];
        if (p.reservedMicros > 250000 || reserved + p.reservedMicros > CEILING_MICROS) fail('budget_limit');
        remember(`reserve-${c.id.slice(0, 2)}.json`, p); reserved += p.reservedMicros;
        const plan = casePlan(c); let lastRecord;
        const checkpoint = record => {
          try {
            guard(); snapshotValid(record, c, spec.suite);
            // The frozen engine may try another candidate after some errors.
            // Refuse its next write-ahead checkpoint BEFORE an extra attempt is
            // persisted or dispatched. Keep the last truthful runner snapshot.
            if (stopReason && record.calls.filter(call => call.attempted).length > dispatches.get(c.id)) fail(stopReason);
            write(resultPath(c), record, recordHashes.has(c.id));
            recordHashes.set(c.id, hashFile(resultPath(c))); lastRecord = record;
            stopReason ||= stopFor(record, c);
          } catch (error) { stopReason ||= reason(error); throw error; }
        };
        try {
          await executeCase({ suite: spec.suite, caseId: c.id, apiKey, paid: true, approvedMaxCost: plan.maxCost, checkpoint,
            provider: async args => {
              try {
                guard(); if (stopReason) fail(stopReason);
                const index = dispatches.get(c.id);
                if (index >= plan.calls.length || args.model !== plan.calls[index].model || !isDeepStrictEqual(args.input, caseInput(c))) fail('unexpected_provider_behavior');
                if (!owned.has(`reserve-${c.id.slice(0, 2)}.json`) || reserved > CEILING_MICROS) fail('budget_limit');
                remember(`dispatch-${c.id.slice(0, 2)}-${index}.json`, { caseId: c.id, index });
                dispatches.set(c.id, index + 1);
              } catch (error) { stopReason ||= reason(error); throw error; }
              try { return await provider({ ...args, signal }); }
              catch (error) { stopReason ||= safeReasons.has(error?.code) ? error.code : 'provider_error'; throw error; }
            },
          });
        } catch (error) { stopReason ||= reason(error); }
        if (lastRecord) remember(`record-${c.id.slice(0, 2)}.json`, { caseId: c.id, resultHash: hashFile(resultPath(c)) });
        progress({ caseId: c.id, state: 'recorded' });
        if (stopReason) break;
      }
    } catch (error) { stopReason ||= reason(error); }
    finally { apiKey = ''; }
    try { remember('finish.json', { state: stopReason ? 'stopped' : 'complete', stopReason }); }
    catch { /* Failed persistence leaves the permanent gate and last durable evidence. */ }
    try { return status(); }
    catch (error) {
      return { state: 'stopped', stopReason: reason(error),
        apiCallsAttempted: [...dispatches.values()].reduce((n, count) => n + count, 0),
        conservativeBudgetReservedUsd: reserved / 1e6, knownMeasuredSpendingUsd: null,
        chargesMayBeUnknown: true, accountingUncertain: true, message: 'Lock verification failed; preserve all records for inspection.' };
    }
  }
  return { preview, run, status };
}

export const safeFailure = error => ({ state: 'blocked', reason: reason(error), message: 'Stopped. No automatic retry; use status to inspect any existing batch.' });
