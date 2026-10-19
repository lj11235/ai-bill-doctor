import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReview, parseReviewJson, publishNew, readReviewJson } from './runner.mjs';
import { main } from './cli.mjs';
import { casePlan, createManifest, digest, executeCase, grade, loadSuite, recordHuman, verifyReview } from '../benchmark/runner.mjs';

const suite = loadSuite();
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error('Unmocked network forbidden.'); }; });
after(() => { globalThis.fetch = originalFetch; });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const base = root => join(root, 'outputs/internal-benchmark/smb-v1');
const rubricPath = (root, id) => join(base(root), id, 'rubric.json');
const manual = suite.fixtures.cases.filter(c => c.evaluationType === 'manual_rubric');
const paths = root => readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? paths(join(root, e.name)) : [join(root, e.name)]);
const snapshot = root => new Map(paths(root).map(p => [p, digest(readFileSync(p, 'utf8'))]));
const unchanged = before => { for (const [path, hash] of before) assert.equal(digest(readFileSync(path, 'utf8')), hash); };
const noNewGrades = root => assert.ok(manual.every(c => !existsSync(rubricPath(root, c.id))));

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bill-doctor-review-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(base(root), { recursive: true });
  write(join(base(root), 'manifest.json'), createManifest(suite, 'smb-v1'));
  for (const c of suite.fixtures.cases) {
    const directory = join(base(root), c.id); mkdirSync(directory);
    const result = await executeCase({ suite, caseId: c.id, apiKey: 'synthetic-review-test-not-a-key', paid: true,
      approvedMaxCost: casePlan(c).maxCost,
      provider: async ({ model }) => ({ model, complete: true, output: 'Synthetic output only.\n"Quoted" and \\escaped text.\n', cost: .0001,
        usage: { inputTokens: 1, outputTokens: 1 }, settings: { synthetic: true } }),
    });
    const human = recordHuman(result, Object.fromEntries(result.calls.slice(1).map(call => [call.label, 'yes'])));
    write(join(directory, 'result.json'), result); write(join(directory, 'human.json'), human);
    if (c.evaluationType === 'exact_json') write(rubricPath(root, c.id), grade(result, suite.rubrics.cases[c.id], human));
  }
  return root;
}
function filled(review) {
  const packet = review.packet();
  for (const c of packet.cases) for (const o of c.outputs) for (const criterion of o.criteria) {
    if (criterion.result === null) { criterion.result = 'pass'; criterion.evidence = 'Synthetic test evidence; no external call.'; }
  }
  return packet;
}
function existingGrade(root, c, judgments) {
  const result = read(join(base(root), c.caseId, 'result.json'));
  const human = read(join(base(root), c.caseId, 'human.json'));
  const checks = Object.fromEntries(c.outputs.map(o => [o.label, o.criteria.map(v => ({ id: v.id, result: v.result, evidence: v.evidence }))]));
  const record = grade(result, suite.rubrics.cases[c.caseId], human, checks);
  if (judgments) judgments(record);
  return record;
}

test('export contains exact instructions, outputs and 98 criterion rows with no identity, cost or human judgments', async t => {
  const root = await setup(t); const before = snapshot(base(root));
  const review = createReview({ root }); const path = join(root, 'review.json');
  assert.deepEqual(review.export(path), { cases: 6, outputs: 16, criteria: 98 });
  const packet = readReviewJson(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const c of packet.cases) {
    const fixture = manual.find(f => f.id === c.caseId);
    assert.equal(c.system, fixture.system); assert.equal(c.request, fixture.request);
    const result = read(join(base(root), c.caseId, 'result.json'));
    c.outputs.forEach((o, i) => {
      assert.equal(o.text, result.calls[i].output); assert.equal(o.label, result.calls[i].label);
      assert.equal(o.outputId.split('/')[0], c.caseId);
      assert.deepEqual(o.criteria.map(v => [v.id, v.severity, v.text]), suite.rubrics.cases[c.caseId].criteria.map(v => [v.id, v.severity, v.requirement]));
      assert.ok(o.criteria.every(v => v.result === null && v.evidence === ''));
    });
  }
  assert.doesNotMatch(JSON.stringify(packet), /gpt-|synthetic-review-test-not-a-key|"(?:model|usage|pricing|settings|measuredCost|cost|decisions|expected|criticalOmissions|rationale)":/);
  assert.throws(() => review.export(path), /already exists/);
  unchanged(before);
});

test('import uses the existing grader, preserves all existing evidence, and supports an identical resume', async t => {
  const root = await setup(t); const before = snapshot(base(root)); const review = createReview({ root });
  const packet = filled(review);
  // Exercise the unchanged distinction between strict, acceptable and inconclusive.
  packet.cases[0].outputs[0].criteria.find(c => c.severity === 'secondary').result = 'fail';
  packet.cases[0].outputs[1].criteria.find(c => c.severity === 'critical').result = 'inconclusive';
  const report = review.import(packet);
  assert.equal(report.writtenCases.length, 6); assert.equal(report.preservedCases.length, 0);
  const first = read(rubricPath(root, packet.cases[0].caseId));
  assert.equal(first.judgments.Baseline.strict_pass, false); assert.equal(first.judgments.Baseline.acceptable_pass, true);
  assert.equal(first.judgments['Candidate A'].acceptable_pass, 'inconclusive');
  for (const c of packet.cases) {
    const record = read(rubricPath(root, c.caseId));
    verifyReview(read(join(base(root), c.caseId, 'result.json')), suite.rubrics.cases[c.caseId], read(join(base(root), c.caseId, 'human.json')), record);
    assert.equal(statSync(rubricPath(root, c.caseId)).mode & 0o777, 0o600);
  }
  unchanged(before);
  const all = snapshot(base(root));
  const resume = review.import(packet);
  assert.equal(resume.writtenCases.length, 0); assert.equal(resume.preservedCases.length, 6); unchanged(all);
});

test('check-only validates all judgments without writing grades', async t => {
  const root = await setup(t); const review = createReview({ root }); const before = snapshot(base(root));
  assert.equal(review.import(filled(review), { checkOnly: true }).validatedCases, 6);
  noNewGrades(root); unchanged(before);
  assert.throws(() => review.import(review.packet(), { checkOnly: true }), /Every criterion requires/);
});

for (const [name, mutate] of [
  ['missing case', p => p.cases.pop()],
  ['duplicate case', p => p.cases.push(p.cases[0])],
  ['unknown case', p => { p.cases[0].caseId = 'unknown'; }],
  ['missing output', p => p.cases[5].outputs.pop()],
  ['duplicate output', p => p.cases[0].outputs.push(p.cases[0].outputs[0])],
  ['unknown output', p => { p.cases[0].outputs[0].outputId = 'unknown'; }],
  ['missing criterion', p => p.cases[5].outputs[0].criteria.pop()],
  ['duplicate criterion', p => p.cases[0].outputs[0].criteria.push(p.cases[0].outputs[0].criteria[0])],
  ['unknown criterion', p => { p.cases[0].outputs[0].criteria[0].id = 'unknown'; }],
  ['invalid verdict', p => { p.cases[5].outputs[0].criteria[0].result = 'yes'; }],
  ['missing verdict', p => { delete p.cases[0].outputs[0].criteria[0].result; }],
  ['empty evidence', p => { p.cases[5].outputs[0].criteria[0].evidence = ' \n '; }],
  ['invalid evidence', p => { p.cases[0].outputs[0].criteria[0].evidence = 42; }],
  ['extra field', p => { p.cases[0].outputs[0].criteria[0].score = 1; }],
  ['changed severity', p => { p.cases[0].outputs[0].criteria[0].severity = 'secondary'; }],
  ['changed criterion text', p => { p.cases[0].outputs[0].criteria[0].text += ' altered'; }],
  ['changed instructions', p => { p.cases[0].system += ' altered'; }],
  ['changed output', p => { p.cases[0].outputs[0].text += ' altered'; }],
  ['changed source hash', p => { p.cases[0].sourceHash = 'changed'; }],
  ['changed fingerprint', p => { p.fingerprint = 'changed'; }],
]) test(`rejects ${name} before any case is written`, async t => {
  const root = await setup(t); const review = createReview({ root }); const before = snapshot(base(root));
  const packet = filled(review); mutate(packet);
  assert.throws(() => review.import(packet)); noNewGrades(root); unchanged(before);
});

test('allows reordered lists without changing identifier-to-judgment matching', async t => {
  const root = await setup(t); const review = createReview({ root }); const packet = filled(review);
  packet.cases.reverse(); for (const c of packet.cases) { c.outputs.reverse(); for (const o of c.outputs) o.criteria.reverse(); }
  assert.equal(review.import(packet).writtenCases.length, 6);
});

test('rejects repeated JSON properties including escaped equivalents, malformed and oversized JSON', () => {
  for (const raw of ['{"result":"pass","result":"fail"}', '{"a":{"x":1,"\\u0078":2}}', '[{"evidence":"a","evidence":"b"}]']) {
    assert.throws(() => parseReviewJson(raw), /Duplicate JSON/);
  }
  for (const raw of ['{', '"unterminated', '"' + 'x'.repeat(6 * 1024 * 1024) + '"', '['.repeat(65) + '1' + ']'.repeat(65)]) {
    assert.throws(() => parseReviewJson(raw));
  }
  const valid = { a: ['\"', '\\', '\n', '{"looks":"like JSON"}', null, true, 2.5e3, {}] };
  assert.deepEqual(parseReviewJson(JSON.stringify(valid)), valid);
});

test('partial existing grading is exported filled, preserved byte-for-byte, and remaining cases import', async t => {
  const root = await setup(t); const review = createReview({ root }); const packet = filled(review);
  write(rubricPath(root, packet.cases[0].caseId), existingGrade(root, packet.cases[0]));
  const locked = snapshot(base(root));
  const next = review.packet();
  assert.ok(next.cases[0].outputs.every(o => o.criteria.every(c => c.result === 'pass')));
  assert.equal(next.cases[1].outputs[0].criteria[0].result, null);
  const report = review.import(filled(review));
  assert.equal(report.preservedCases.length, 1); assert.equal(report.writtenCases.length, 5); unchanged(locked);
});

test('conflicts with any locked case reject the whole import before pending cases are written', async t => {
  const root = await setup(t); const review = createReview({ root }); const packet = filled(review);
  write(rubricPath(root, packet.cases[5].caseId), existingGrade(root, packet.cases[5]));
  packet.cases[5].outputs[0].criteria[0].result = 'fail';
  const before = snapshot(base(root));
  assert.throws(() => review.import(packet), /conflict/);
  assert.ok(manual.slice(0, 5).every(c => !existsSync(rubricPath(root, c.id)))); unchanged(before);
});

test('a truncated pre-existing rubric is preserved and fails closed', async t => {
  const root = await setup(t); const review = createReview({ root }); const packet = filled(review);
  const path = rubricPath(root, manual[0].id); writeFileSync(path, '{"judgments":');
  assert.throws(() => review.import(packet), /Invalid JSON/); assert.equal(readFileSync(path, 'utf8'), '{"judgments":');
});

for (const stage of ['staged', 'published', 'case_committed']) test(`interrupted at ${stage}: preserve durable cases and safely resume`, async t => {
  const root = await setup(t); const normal = createReview({ root }); const packet = filled(normal);
  let count = 0;
  const crashing = createReview({ root, checkpoint: point => { if (point === stage && ++count === 2) throw new Error('Simulated crash'); } });
  assert.throws(() => crashing.import(packet), /Simulated crash/);
  const completed = manual.filter(c => existsSync(rubricPath(root, c.id))).length;
  assert.equal(completed, stage === 'staged' ? 1 : 2);
  const beforeResume = snapshot(base(root));
  const report = normal.import(packet);
  assert.equal(report.preservedCases.length, completed); assert.equal(report.writtenCases.length, 6 - completed);
  unchanged(beforeResume);
  assert.ok(paths(base(root)).filter(p => p.endsWith('/rubric.json')).every(p => read(p).judgments));
});

test('concurrent publication preserves identical grading and rejects a conflicting winner', async t => {
  for (const conflict of [false, true]) {
    const root = await setup(t); const normal = createReview({ root }); const packet = filled(normal); let raced = false;
    const racing = createReview({ root, checkpoint: (point, caseId) => {
      if (point !== 'staged' || raced) return;
      raced = true;
      const c = structuredClone(packet.cases.find(c => c.caseId === caseId));
      if (conflict) c.outputs[0].criteria[0].result = 'fail';
      publishNew(rubricPath(root, caseId), existingGrade(root, c));
    } });
    if (conflict) assert.throws(() => racing.import(packet), /conflict/);
    else assert.equal(racing.import(packet).preservedCases.length, 1);
    assert.equal(read(rubricPath(root, manual[0].id)).judgments.Baseline.strict_pass, !conflict);
  }
});

test('changed manifest, result or human source binding blocks imports without changing evidence', async t => {
  for (const target of ['manifest', 'result', 'human']) {
    const root = await setup(t); const review = createReview({ root }); const packet = filled(review);
    if (target === 'manifest') {
      const path = join(base(root), 'manifest.json'); const m = read(path); m.fingerprint = 'changed'; write(path, m);
    } else {
      const dir = join(base(root), manual[0].id); const result = read(join(dir, 'result.json'));
      const human = read(join(dir, 'human.json'));
      if (target === 'result') { result.calls[0].output += ' changed'; write(join(dir, 'result.json'), result); }
      else human.decisions['Candidate A'] = 'no';
      write(join(dir, 'human.json'), recordHuman(result, human.decisions));
    }
    const before = snapshot(base(root)); assert.throws(() => review.import(packet)); noNewGrades(root); unchanged(before);
  }
});

test('lock is reverified between case commits', async t => {
  const root = await setup(t); const packet = filled(createReview({ root }));
  const review = createReview({ root, checkpoint: (point, caseId) => {
    if (point === 'case_committed' && caseId === manual[0].id) {
      const path = join(base(root), 'manifest.json'); const m = read(path); m.fingerprint = 'changed'; write(path, m);
    }
  } });
  assert.throws(() => review.import(packet), /fingerprint/);
  assert.equal(manual.filter(c => existsSync(rubricPath(root, c.id))).length, 1);
});

test('incomplete outputs carry status but receive no invented criterion judgments', async t => {
  const root = await setup(t); const c = manual[0]; const dir = join(base(root), c.id);
  const result = read(join(dir, 'result.json'));
  result.calls[1].status = 'inconclusive_technical'; result.calls[1].output = null;
  write(join(dir, 'result.json'), result); write(join(dir, 'human.json'), recordHuman(result, {}));
  const review = createReview({ root }); const packet = filled(review);
  assert.equal(packet.cases[0].outputs[1].criteria.length, 0);
  review.import(packet);
  assert.equal(read(rubricPath(root, c.id)).judgments['Candidate A'].acceptable_pass, 'inconclusive');
});

test('CLI exposes offline export, validation, import and safe status only', async t => {
  const root = await setup(t); const logged = []; t.mock.method(console, 'log', value => logged.push(value));
  const path = join(root, 'review.json');
  main(['export', 'smb-v1', path], { root }); write(path, filled(createReview({ root })));
  assert.equal(main(['import', 'smb-v1', path, '--check'], { root }).checkOnly, true); noNewGrades(root);
  assert.equal(main(['import', 'smb-v1', path], { root }).writtenCases.length, 6);
  assert.ok(main(['status', 'smb-v1'], { root }).cases.every(c => c.grading === 'locked'));
  for (const args of [['run', 'smb-v1'], ['reveal', 'smb-v1'], ['import', 'smb-v1', path, '--unknown'], ['status', '../escape']]) {
    assert.throws(() => main(args, { root }));
  }
  assert.doesNotMatch(logged.join('\n'), /gpt-|measuredCost|synthetic-review-test-not-a-key|Synthetic output/);
});
