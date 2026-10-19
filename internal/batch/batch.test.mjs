import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createBatch, durableJson, FINGERPRINT } from './runner.mjs';
import { main } from './cli.mjs';
import { loadSuite, createManifest, executeCase, casePlan, caseInput, digest, verifyManifest } from '../benchmark/runner.mjs';
import { requestPayload } from '../../src/data.js';
import { BenchmarkError } from '../../lib/errors.mjs';

const suite = loadSuite();
const KEY = 'synthetic-batch-test-key-not-a-credential';
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error('Unmocked network is forbidden.'); }; });
after(() => { globalThis.fetch = originalFetch; });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const fileHash = path => digest(readFileSync(path, 'utf8'));
const ledgerPath = root => join(root, 'outputs/internal-batch/smb-v1-cases-02-12');
const experimentPath = root => join(root, 'outputs/internal-benchmark/smb-v1');
const resultPath = (root, id) => join(experimentPath(root), id, 'result.json');
const usage = (input = 50, output = 10, reasoning = 5) => ({
  input_tokens: input, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
});
const apiData = (payload, extra = {}) => ({
  ...payload, status: 'completed', usage: usage(),
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic benchmark output.' }] }], ...extra,
});
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bill-doctor-batch-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = suite.fixtures.cases[0];
  mkdirSync(join(experimentPath(root), first.id), { recursive: true });
  durableJson(join(experimentPath(root), 'manifest.json'), createManifest(suite, 'smb-v1'));
  const result = await executeCase({ suite, caseId: first.id, apiKey: KEY, paid: true,
    approvedMaxCost: casePlan(first).maxCost, provider: async () => { throw new BenchmarkError('rate_limit', 'Synthetic.'); } });
  durableJson(resultPath(root, first.id), result);
  return root;
}
function fakeNetwork(t, handler = () => ({})) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    const c = suite.fixtures.cases.find(c => c.request === payload.input?.[0]?.content?.[0]?.text)
      || suite.fixtures.cases.find(c => JSON.stringify(requestPayload(caseInput(c), payload.model)) === options.body);
    assert.ok(c, 'Only exact frozen requests can reach the provider.');
    assert.deepEqual(payload, requestPayload(caseInput(c), payload.model));
    calls.push({ caseId: c.id, model: payload.model });
    const reply = await handler({ c, payload, count: calls.length, options });
    return new Response(JSON.stringify(reply.body ?? apiData(payload, reply.extra)), { status: reply.status ?? 200 });
  });
  return calls;
}
const paid = batch => batch.run({ paid: true, approvedUsd: 1.50, apiKey: KEY });
const noLeaks = value => {
  const text = JSON.stringify(value);
  assert.equal(text.includes(KEY), false);
  assert.doesNotMatch(text, /gpt-|baselineModel|reduction|rubric|criticalOmissions|ground_truth|Synthetic benchmark output/);
};

test('plan verifies the existing lock and computes exactly $1.448278 / 30 calls without creating a batch', async t => {
  const root = await setup(t); const batch = createBatch({ root }); const plan = batch.preview();
  assert.equal(plan.fingerprint, FINGERPRINT);
  assert.equal(plan.conservativeReservationUsd, 1.448278);
  assert.equal(plan.batchCeilingUsd, 1.50); assert.equal(plan.maximumApiCalls, 30);
  assert.deepEqual(plan.caseIds, suite.fixtures.cases.slice(1).map(c => c.id));
  assert.equal(existsSync(ledgerPath(root)), false);
  assert.deepEqual(batch.status().unstartedCases, plan.caseIds); noLeaks(plan);
});

test('approval, key validation and the fixed $1.50 ceiling fail before dispatch or creating reservations', async t => {
  const root = await setup(t); const batch = createBatch({ root }); const calls = fakeNetwork(t);
  for (const options of [{}, { paid: true }, { paid: true, approvedUsd: .01 }, { paid: true, approvedUsd: 1.49 }, { paid: true, approvedUsd: 1.51 }]) {
    await assert.rejects(batch.run({ apiKey: KEY, ...options }), { code: 'approval_required' });
  }
  await assert.rejects(batch.run({ paid: true, approvedUsd: 1.50, apiKey: '' }), { code: 'invalid_key_format' });
  assert.equal(calls.length, 0); assert.equal(existsSync(ledgerPath(root)), false);
});

test('all 11 cases execute sequentially with frozen plans, durable reservations, no review and no overwrites', async t => {
  const root = await setup(t); const progress = [];
  const oldManifest = fileHash(join(experimentPath(root), 'manifest.json'));
  const oldFirst = fileHash(resultPath(root, suite.fixtures.cases[0].id));
  let active = 0, peak = 0;
  const calls = fakeNetwork(t, async ({ c, count }) => {
    peak = Math.max(peak, ++active);
    const ledger = ledgerPath(root);
    const reservations = readdirSync(ledger).filter(n => n.startsWith('reserve-')).map(n => read(join(ledger, n)));
    assert.ok(reservations.some(r => r.caseId === c.id));
    assert.ok(reservations.reduce((n, r) => n + r.reservedMicros, 0) <= 1500000);
    assert.equal(readdirSync(ledger).filter(n => n.startsWith('dispatch-')).length, count);
    assert.equal(read(resultPath(root, c.id)).calls.filter(c => c.attempted).length,
      readdirSync(ledger).filter(n => n.startsWith(`dispatch-${c.id.slice(0, 2)}-`)).length);
    assert.ok(suite.fixtures.cases.slice(1).every(c => existsSync(join(experimentPath(root), c.id))));
    await new Promise(resolve => setImmediate(resolve)); active--; return {};
  });
  const batch = createBatch({ root });
  const result = await batch.run({ paid: true, approvedUsd: 1.50, apiKey: KEY, progress: e => progress.push(e) });
  assert.equal(result.state, 'complete'); assert.equal(result.accountingUncertain, false);
  assert.equal(peak, 1); assert.equal(calls.length, 30); assert.equal(result.apiCallsAttempted, 30);
  assert.equal(result.conservativeBudgetReservedUsd, 1.448278);
  assert.equal(result.completedCases.length, 11); assert.deepEqual(result.inconclusiveCases, []);
  assert.equal(result.chargesMayBeUnknown, false); assert.ok(result.knownMeasuredSpendingUsd > 0);
  assert.deepEqual(calls, suite.fixtures.cases.slice(1).flatMap(c => casePlan(c).calls.map(p => ({ caseId: c.id, model: p.model }))));
  for (const c of suite.fixtures.cases.slice(1)) {
    const record = read(resultPath(root, c.id)); assert.deepEqual(record.plan, casePlan(c));
    assert.equal(record.schemaVersion, 2); assert.equal(record.state, 'finished');
    assert.deepEqual(readdirSync(join(experimentPath(root), c.id)), ['result.json']);
    assert.equal(statSync(resultPath(root, c.id)).mode & 0o777, 0o600);
  }
  noLeaks(result); noLeaks(progress);
  assert.equal(fileHash(join(experimentPath(root), 'manifest.json')), oldManifest);
  assert.equal(fileHash(resultPath(root, suite.fixtures.cases[0].id)), oldFirst);
  assert.deepEqual(batch.status(), result);
  await assert.rejects(paid(batch), { code: 'existing_attempt' }); assert.equal(calls.length, 30);
});

test('existing case directories/results and a concurrent batch are never reset or retried', async t => {
  const root = await setup(t); const c = suite.fixtures.cases[2];
  mkdirSync(join(experimentPath(root), c.id)); writeFileSync(resultPath(root, c.id), 'Existing evidence');
  const batch = createBatch({ root }); const calls = fakeNetwork(t);
  await assert.rejects(paid(batch), { code: 'existing_attempt' });
  assert.equal(readFileSync(resultPath(root, c.id), 'utf8'), 'Existing evidence');
  assert.equal(existsSync(ledgerPath(root)), false); assert.equal(calls.length, 0);
});

test('invalid manifest or changed locked source hashes blocks dispatch', async t => {
  const root = await setup(t); const path = join(experimentPath(root), 'manifest.json');
  const manifest = read(path); manifest.sourceHashes['src/models.js'] = 'changed';
  writeFileSync(path, JSON.stringify(manifest));
  const calls = fakeNetwork(t); await assert.rejects(paid(createBatch({ root })), { code: 'lock_mismatch' });
  assert.equal(calls.length, 0); assert.equal(existsSync(ledgerPath(root)), false);
});

test('billing, throttling, access failures and server errors stop the whole batch without retries', async t => {
  for (const [status, code, at] of [
    [429, 'rate_limit_exceeded', 1], [429, 'credit_balance_exhausted', 2], [429, 'project_spend_limit_exceeded', 2],
    [429, 'organization_spend_limit_exceeded', 1], [429, 'insufficient_quota', 2],
    [401, 'invalid_api_key', 1], [404, 'model_not_found', 2], [500, 'server_error', 2],
  ]) {
    const root = await setup(t);
    const calls = fakeNetwork(t, ({ count }) => count === at ? { status, body: { error: { code, message: KEY } } } : {});
    const batch = createBatch({ root }); const result = await paid(batch);
    assert.equal(result.state, 'stopped'); assert.equal(calls.length, at);
    assert.equal(result.apiCallsAttempted, at); assert.equal(result.chargesMayBeUnknown, true);
    assert.equal(result.conservativeBudgetReservedUsd, .149163);
    assert.equal(result.unstartedCases.length, 10); noLeaks(result);
    await assert.rejects(paid(batch), { code: 'existing_attempt' });
    assert.equal(calls.length, at);
    t.mock.restoreAll();
  }
});

test('timeout and transport exceptions stop after one attempt and do not expose exception contents', async t => {
  for (const code of ['timeout', 'provider_error']) {
    const root = await setup(t);
    const calls = fakeNetwork(t, () => { throw code === 'timeout' ? new BenchmarkError(code, KEY) : new Error(KEY); });
    const result = await paid(createBatch({ root }));
    assert.equal(calls.length, 1); assert.equal(result.stopReason, code);
    assert.equal(result.chargesMayBeUnknown, true); assert.equal(result.conservativeBudgetReservedUsd, .149163);
    noLeaks(result); t.mock.restoreAll();
  }
});

test('a priced refusal preserves the existing runner status without automatically grading it', async t => {
  const root = await setup(t);
  const calls = fakeNetwork(t, ({ count }) => count === 1 ? { extra: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Synthetic refusal.' }] }],
  } } : {});
  const result = await paid(createBatch({ root }));
  assert.equal(calls.length, 28); assert.equal(result.state, 'complete');
  const record = read(resultPath(root, '02-contracted-arr'));
  assert.equal(record.calls[0].status, 'quality_failure'); assert.equal(record.engineOutcome, 'baseline_incomplete');
  assert.equal(existsSync(join(experimentPath(root), '02-contracted-arr/rubric.json')), false);
});

test('nonfatal frozen adapter errors cannot dispatch an extra candidate or fabricate an attempt', async t => {
  for (const extra of [{ service_tier: 'priority' }, { model: 'unknown' }, { usage: null }, { reasoning: { effort: 'none' } }]) {
    const root = await setup(t); const calls = fakeNetwork(t, ({ count }) => count === 2 ? { extra } : {});
    const result = await paid(createBatch({ root })); const record = read(resultPath(root, '02-contracted-arr'));
    assert.equal(result.state, 'stopped'); assert.equal(calls.length, 2);
    assert.equal(record.calls[1].status, 'inconclusive_technical');
    assert.equal(record.calls[2].attempted, false); assert.equal(record.calls[2].status, 'not_run');
    assert.equal(record.state, 'running'); // Last truthful snapshot; never fabricated completion.
    assert.equal(result.apiCallsAttempted, 2); noLeaks(result); t.mock.restoreAll();
  }
});

test('priced output exhaustion stays inconclusive and permits safely budgeted later cases', async t => {
  for (const at of [1, 2]) {
    const root = await setup(t);
    const calls = fakeNetwork(t, ({ count }) => count === at ? { extra: {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: usage(50, 2048, 2048),
    } } : {});
    const result = await paid(createBatch({ root }));
    assert.equal(result.state, 'complete'); assert.equal(result.chargesMayBeUnknown, false);
    assert.equal(calls.length, at === 1 ? 28 : 30); assert.equal(result.conservativeBudgetReservedUsd, 1.448278);
    assert.deepEqual(result.inconclusiveCases, ['02-contracted-arr']); assert.equal(result.completedCases.length, 10);
    const record = read(resultPath(root, '02-contracted-arr'));
    assert.equal(record.calls[at - 1].status, 'inconclusive_output_budget');
    assert.ok(record.calls[at - 1].cost > 0); t.mock.restoreAll();
  }
});

test('unclassified incomplete provider behavior stops despite known charges', async t => {
  const root = await setup(t); const calls = fakeNetwork(t, ({ count }) => count === 2 ? {
    extra: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] },
  } : {});
  const result = await paid(createBatch({ root }));
  assert.equal(result.state, 'stopped'); assert.equal(result.stopReason, 'unexpected_provider_behavior');
  assert.equal(calls.length, 2); assert.equal(result.chargesMayBeUnknown, false);
  assert.ok(result.knownMeasuredSpendingUsd > 0);
});

test('actual usage beyond a conservative call reservation stops further spending', async t => {
  const root = await setup(t); const calls = fakeNetwork(t, () => ({ extra: { usage: usage(100000) } }));
  const result = await paid(createBatch({ root }));
  assert.equal(result.state, 'stopped'); assert.equal(result.stopReason, 'budget_limit');
  assert.equal(calls.length, 1); assert.ok(result.knownMeasuredSpendingUsd > result.conservativeBudgetReservedUsd);
});

test('reservation, dispatch-journal and checkpoint persistence failures stop before any later call', async t => {
  for (const stage of ['reservation', 'dispatch', 'initial', 'after_call']) {
    const root = await setup(t); const calls = fakeNetwork(t); let failed = false;
    const batch = createBatch({ root, write: (path, value, replace) => {
      const hit = stage === 'reservation' ? path.endsWith('reserve-02.json')
        : stage === 'dispatch' ? path.endsWith('dispatch-02-0.json')
          : path.endsWith('02-contracted-arr/result.json') && (stage === 'initial' || value.calls[0].status === 'complete');
      if (hit && !failed) { failed = true; throw new Error(KEY); }
      durableJson(path, value, replace);
    } });
    const result = await paid(batch);
    assert.ok(failed); assert.notEqual(result.state, 'complete');
    assert.equal(calls.length, stage === 'after_call' ? 1 : 0); noLeaks(result);
    if (stage === 'after_call') {
      const record = read(resultPath(root, '02-contracted-arr'));
      assert.equal(record.calls[0].status, 'running'); assert.equal(result.chargesMayBeUnknown, true);
    }
    await assert.rejects(paid(batch), { code: 'existing_attempt' }); t.mock.restoreAll();
  }
});

test('journal corruption or prior-result tampering prevents dispatch of the next case', async t => {
  for (const target of ['reservation', 'result']) {
    const root = await setup(t); const calls = fakeNetwork(t);
    const result = await createBatch({ root }).run({ paid: true, approvedUsd: 1.50, apiKey: KEY, progress: () => {
      const path = target === 'reservation' ? join(ledgerPath(root), 'reserve-02.json') : resultPath(root, '02-contracted-arr');
      const value = read(path); if (target === 'reservation') value.reservedMicros = 0; else value.measuredCost = 0;
      writeFileSync(path, JSON.stringify(value));
    } });
    assert.equal(calls.length, 3); assert.equal(result.state, 'accounting_uncertain');
    assert.equal(result.accountingUncertain, true); assert.equal(result.conservativeBudgetReservedUsd, null);
    t.mock.restoreAll();
  }
});

test('lock drift during a call stops the batch without overwriting prior evidence', async t => {
  const root = await setup(t); const original = fileHash(resultPath(root, '01-billing-triage'));
  const calls = fakeNetwork(t, () => {
    const path = join(experimentPath(root), 'manifest.json'); const value = read(path);
    value.fingerprint = 'changed'; writeFileSync(path, JSON.stringify(value)); return {};
  });
  const result = await paid(createBatch({ root }));
  assert.equal(calls.length, 1); assert.equal(result.stopReason, 'lock_mismatch');
  assert.equal(result.apiCallsAttempted, 1); assert.equal(result.chargesMayBeUnknown, true);
  assert.equal(fileHash(resultPath(root, '01-billing-triage')), original);
});

test('second process cannot start a batch while the first is in flight', async t => {
  const root = await setup(t); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const calls = fakeNetwork(t, async ({ count }) => { if (count === 1) { entered(); await waiting; } return {}; });
  const first = paid(createBatch({ root })); await started;
  await assert.rejects(paid(createBatch({ root })), { code: 'existing_attempt' });
  release(); assert.equal((await first).state, 'complete'); assert.equal(calls.length, 30);
});

test('cancellation aborts the active provider call and preserves uncertain charges', async t => {
  const root = await setup(t); const controller = new AbortController();
  const calls = fakeNetwork(t, ({ options }) => {
    controller.abort(); assert.equal(options.signal.aborted, true); throw new Error(KEY);
  });
  const result = await createBatch({ root }).run({ paid: true, approvedUsd: 1.50, apiKey: KEY, signal: controller.signal });
  assert.equal(calls.length, 1); assert.equal(result.stopReason, 'cancelled'); assert.equal(result.chargesMayBeUnknown, true);
  assert.equal(result.conservativeBudgetReservedUsd, .149163); noLeaks(result);
});

test('crash recovery is read-only, retains full reservations, and never resumes or repeats a case', async t => {
  for (const crash of ['after_reservation', 'in_flight', 'between_cases']) {
    const root = await setup(t);
    const script = `
      import { createBatch, durableJson } from ${JSON.stringify(new URL('./runner.mjs', import.meta.url).href)};
      const crash = ${JSON.stringify(crash)};
      globalThis.fetch = async (_, options) => {
        if (crash === 'in_flight') process.kill(process.pid, 'SIGKILL');
        const p = JSON.parse(options.body);
        return new Response(JSON.stringify({ ...p, status: 'completed', usage: ${JSON.stringify(usage())},
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic.' }] }] }));
      };
      const batch = createBatch({ root: ${JSON.stringify(root)}, write: (path, data, replace) => {
        durableJson(path, data, replace);
        if (crash === 'after_reservation' && path.endsWith('reserve-02.json')) process.kill(process.pid, 'SIGKILL');
      } });
      await batch.run({ paid: true, approvedUsd: 1.50, apiKey: ${JSON.stringify(KEY)},
        progress: () => { if (crash === 'between_cases') process.kill(process.pid, 'SIGKILL'); } });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.signal, 'SIGKILL'); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
    const before = readdirSync(ledgerPath(root)).map(n => [n, fileHash(join(ledgerPath(root), n))]);
    const batch = createBatch({ root }); const result = batch.status();
    assert.equal(result.state, 'running_or_interrupted'); assert.equal(result.conservativeBudgetReservedUsd, .149163);
    assert.equal(result.apiCallsAttempted, crash === 'after_reservation' ? 0 : crash === 'in_flight' ? 1 : 3);
    assert.equal(result.chargesMayBeUnknown, crash === 'in_flight');
    assert.equal(result.attemptCountMayBeUpperBound, true);
    assert.deepEqual(readdirSync(ledgerPath(root)).map(n => [n, fileHash(join(ledgerPath(root), n))]), before);
    await assert.rejects(paid(batch), { code: 'existing_attempt' });
    if (crash === 'between_cases') assert.deepEqual(result.completedCases, ['02-contracted-arr']);
  }
});

test('partial ledger writes and missing receipts fail closed without inventing zero cost', async t => {
  const root = await setup(t); const calls = fakeNetwork(t);
  const batch = createBatch({ root, write: (path, value, replace) => {
    if (path.endsWith('dispatch-02-0.json')) { writeFileSync(path + '.tmp', '{'); throw new Error('Disk full'); }
    durableJson(path, value, replace);
  } });
  const result = await paid(batch); assert.equal(calls.length, 0);
  assert.equal(result.state, 'accounting_uncertain'); assert.equal(result.conservativeBudgetReservedUsd, null);
  assert.equal(result.knownMeasuredSpendingUsd, null); assert.equal(result.chargesMayBeUnknown, true);
  await assert.rejects(paid(batch), { code: 'existing_attempt' });
});

function terminal(answer = KEY + '\r') {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => {};
  let text = '';
  const output = { isTTY: true, write: value => {
    text += value; if (value.includes('Temporary OpenAI API key')) queueMicrotask(() => input.emit('data', Buffer.from(answer)));
  } };
  return { input, output, get text() { return text; } };
}

test('CLI preview and malformed approval make zero calls; secrets in argv are never echoed', async t => {
  const root = await setup(t); const batch = createBatch({ root }); const calls = fakeNetwork(t);
  const term = terminal();
  assert.equal(await main([], { batch, ...term }), 0);
  for (const args of [['run'], ['run', '--paid', '--approve', '1.51'], ['run', '--paid', '--approve', '1.50', KEY]]) {
    assert.equal(await main(args, { batch, ...term }), 1);
  }
  term.input.isTTY = false;
  assert.equal(await main(['run', '--paid', '--approve', '1.50'], { batch, ...term }), 1);
  assert.equal(calls.length, 0); assert.equal(existsSync(ledgerPath(root)), false); assert.equal(term.text.includes(KEY), false);
});

test('approved CLI asks for one hidden key, produces a blind report, and preserves redaction in results', async t => {
  const root = await setup(t); const term = terminal();
  const calls = fakeNetwork(t, () => ({ extra: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Synthetic echoed ${KEY}` }] }],
  } }));
  assert.equal(await main(['run', '--paid', '--approve', '1.50'], { batch: createBatch({ root }), ...term }), 0);
  assert.equal(calls.length, 30); assert.equal(term.input.isRaw, false);
  assert.equal(term.text.split('Temporary OpenAI API key').length - 1, 1); noLeaks(term.text);
  for (const c of suite.fixtures.cases.slice(1)) {
    assert.equal(readFileSync(resultPath(root, c.id), 'utf8').includes(KEY), false);
  }
});

test('cancelling hidden key entry creates no batch and makes no calls', async t => {
  const root = await setup(t); const term = terminal('\x03'); const calls = fakeNetwork(t);
  assert.equal(await main(['run', '--paid', '--approve', '1.50'], { batch: createBatch({ root }), ...term }), 1);
  assert.equal(calls.length, 0); assert.equal(existsSync(ledgerPath(root)), false);
  assert.equal(term.input.isRaw, false); assert.equal(term.text.includes(KEY), false);
});

test('the locked source fingerprint still matches and no production or benchmark code changed', () => {
  const current = loadSuite(); assert.equal(current.fingerprint, FINGERPRINT);
  verifyManifest(current, createManifest(suite, 'smb-v1'));
});
