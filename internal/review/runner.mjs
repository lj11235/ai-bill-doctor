import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { digest, grade, loadSuite, projectRoot, summarize, verifyHuman, verifyManifest, verifyReview } from '../benchmark/runner.mjs';

export class ReviewError extends Error {}
const requireReview = (condition, message) => { if (!condition) throw new ReviewError(message); };
const maxBytes = 5 * 1024 * 1024;
const manualIds = ['07-feedback-reliability', '08-feedback-conflicts', '09-outage-rewrite', '10-onboarding-copy', '11-launch-synthesis', '12-pilot-synthesis'];

// JSON.parse silently accepts repeated object keys. Reject them as well as
// duplicate case/output/criterion identifiers; never choose a last-wins verdict.
export function parseReviewJson(text) {
  requireReview(typeof text === 'string' && Buffer.byteLength(text) <= maxBytes, 'Review JSON exceeds the size limit.');
  let value;
  try { value = JSON.parse(text); } catch { throw new ReviewError('Invalid JSON.'); }
  let i = 0;
  const whitespace = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    return JSON.parse(text.slice(start, ++i));
  };
  const visit = depth => {
    requireReview(depth < 64, 'Review JSON is too deeply nested.');
    whitespace();
    if (text[i] === '{') {
      i++; whitespace(); const keys = new Set();
      if (text[i] !== '}') for (;;) {
        whitespace(); const key = string();
        requireReview(!keys.has(key), 'Duplicate JSON property.'); keys.add(key);
        whitespace(); i++; visit(depth + 1); whitespace();
        if (text[i] !== ',') break;
        i++;
      }
      i++;
    } else if (text[i] === '[') {
      i++; whitespace();
      if (text[i] !== ']') for (;;) {
        visit(depth + 1); whitespace(); if (text[i] !== ',') break; i++;
      }
      i++;
    } else if (text[i] === '"') string();
    else { while (i < text.length && !/[\s,}\]]/.test(text[i])) i++; }
  };
  visit(0);
  return value;
}

export function readReviewJson(path) {
  try {
    const info = lstatSync(path);
    requireReview(info.isFile() && info.size <= maxBytes, 'Expected a regular JSON file within the size limit.');
    return parseReviewJson(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError('Could not read the required JSON file. No existing record was replaced.');
  }
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// A hard link publishes a fully written, synced file without replacing an
// existing destination. A crash may leave a private .tmp file, never half a
// rubric.json. Such staging files are ignored and are not grading records.
export function publishNew(path, value, checkpoint = () => {}) {
  const temporary = join(dirname(path), `.review-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  checkpoint('staged');
  try { linkSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
  syncDirectory(dirname(path));
  checkpoint('published');
  unlinkSync(temporary);
  syncDirectory(dirname(path));
}

const same = (a, b, message) => requireReview(isDeepStrictEqual(a, b), message);
const omit = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
function exactKeys(value, keys) {
  requireReview(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object.');
  same(Object.keys(value).sort(), [...keys].sort(), 'Missing or unknown fields.');
}
function index(items, key, ids) {
  requireReview(Array.isArray(items), 'Expected a complete judgment list.');
  const indexed = new Map();
  for (const item of items) {
    requireReview(item && typeof item[key] === 'string' && ids.includes(item[key]), 'Unknown or invalid judgment identifier.');
    requireReview(!indexed.has(item[key]), 'Duplicate judgment identifier.');
    indexed.set(item[key], item);
  }
  requireReview(indexed.size === ids.length, 'Missing judgments. All six manual cases and their complete outputs are required.');
  return indexed;
}

export function createReview({ root = fileURLToPath(projectRoot), experimentId = 'smb-v1', suiteLoader = loadSuite, checkpoint = () => {} } = {}) {
  requireReview(/^[a-z0-9][a-z0-9-]{0,63}$/.test(experimentId), 'Invalid experiment ID.');
  const directory = join(root, 'outputs/internal-benchmark', experimentId);

  function context() {
    const suite = suiteLoader();
    const manifest = readReviewJson(join(directory, 'manifest.json'));
    try { verifyManifest(suite, manifest); }
    catch { throw new ReviewError('Experiment fingerprint verification failed.'); }
    requireReview(manifest.experimentId === experimentId, 'Experiment ID mismatch.');
    const cases = manualIds.map(caseId => {
      const fixture = suite.fixtures.cases.find(c => c.id === caseId);
      const rubric = suite.rubrics.cases[caseId];
      requireReview(fixture && rubric?.type === 'manual_rubric', 'Expected the six locked manual cases.');
      const caseDirectory = join(directory, caseId);
      const result = readReviewJson(join(caseDirectory, 'result.json'));
      const human = readReviewJson(join(caseDirectory, 'human.json'));
      requireReview(result.caseId === caseId && result.state === 'finished', 'Missing, interrupted or mismatched case result.');
      requireReview(result.calls.every((c, i) => c.label === (i === 0 ? 'Baseline' : `Candidate ${String.fromCharCode(64 + i)}`)), 'Invalid output identifiers.');
      const reviewPath = join(caseDirectory, 'rubric.json');
      const review = existsSync(reviewPath) ? readReviewJson(reviewPath) : null;
      try {
        summarize(suite, [{ result, human, ...(review ? { review } : {}) }]);
        verifyHuman(result, human);
        if (review) verifyReview(result, rubric, human, review);
      } catch { throw new ReviewError('A saved result, human decision or rubric record failed harness validation. Preserve it for inspection.'); }
      return { fixture, rubric, result, human, review, reviewPath };
    });
    return { suite, cases };
  }

  function packetFrom({ suite, cases }) {
    return {
      schemaVersion: 1, experimentId, fingerprint: suite.fingerprint,
      cases: cases.map(({ fixture, rubric, result, human, review }) => ({
        caseId: fixture.id, title: fixture.title, system: fixture.system, request: fixture.request,
        sourceHash: digest({ result, human, rubric }),
        outputs: result.calls.map((call, i) => ({
          outputId: `${fixture.id}/${i === 0 ? 'baseline' : `candidate-${String.fromCharCode(96 + i)}`}`,
          label: call.label, status: call.status, text: call.output,
          criteria: call.status !== 'complete' ? [] : rubric.criteria.map(criterion => {
            const saved = review?.judgments[call.label].checks.find(check => check.id === criterion.id);
            return { id: criterion.id, severity: criterion.severity, text: criterion.requirement,
              result: saved?.result ?? null, evidence: saved?.evidence ?? '' };
          }),
        })),
      })),
    };
  }

  function validate(packet, ctx) {
    const expected = packetFrom(ctx);
    exactKeys(packet, Object.keys(expected));
    same(omit(packet, ['cases']), omit(expected, ['cases']), 'Review belongs to different locked definitions or experiment.');
    const cases = index(packet.cases, 'caseId', manualIds);
    return expected.cases.map((expectedCase, n) => {
      const actualCase = cases.get(expectedCase.caseId);
      exactKeys(actualCase, Object.keys(expectedCase));
      same(omit(actualCase, ['outputs']), omit(expectedCase, ['outputs']), 'Case instructions or saved source binding changed.');
      const outputs = index(actualCase.outputs, 'outputId', expectedCase.outputs.map(o => o.outputId));
      const checks = {};
      for (const expectedOutput of expectedCase.outputs) {
        const output = outputs.get(expectedOutput.outputId);
        exactKeys(output, Object.keys(expectedOutput));
        same(omit(output, ['criteria']), omit(expectedOutput, ['criteria']), 'Recorded output text, label or status changed.');
        const criteria = index(output.criteria, 'id', expectedOutput.criteria.map(c => c.id));
        checks[output.label] = expectedOutput.criteria.map(expectedCriterion => {
          const criterion = criteria.get(expectedCriterion.id);
          exactKeys(criterion, Object.keys(expectedCriterion));
          same(omit(criterion, ['result', 'evidence']), omit(expectedCriterion, ['result', 'evidence']), 'Precommitted criterion text or severity changed.');
          requireReview(['pass', 'fail', 'inconclusive'].includes(criterion.result), 'Every criterion requires pass, fail or inconclusive.');
          requireReview(typeof criterion.evidence === 'string' && criterion.evidence.trim().length > 0, 'Every criterion requires evidence.');
          return { id: criterion.id, result: criterion.result, evidence: criterion.evidence };
        });
      }
      const entry = ctx.cases[n];
      const review = grade(entry.result, entry.rubric, entry.human, checks);
      if (entry.review) same(entry.review.judgments, review.judgments, 'Imported judgments conflict with locked grading. No records were overwritten.');
      return { ...entry, reviewToWrite: review };
    });
  }

  return {
    packet() { return packetFrom(context()); },
    status() {
      const ctx = context();
      return { experimentId, fingerprintValid: true, cases: ctx.cases.map(c => ({ caseId: c.fixture.id, grading: c.review ? 'locked' : 'pending' })) };
    },
    export(path) {
      const packet = packetFrom(context());
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { publishNew(path, packet); }
      catch (error) {
        if (error.code === 'EEXIST') throw new ReviewError('Export already exists; choose another filename.');
        throw error;
      }
      return { cases: packet.cases.length, outputs: packet.cases.reduce((n, c) => n + c.outputs.length, 0), criteria: packet.cases.flatMap(c => c.outputs).reduce((n, o) => n + o.criteria.length, 0) };
    },
    import(packet, { checkOnly = false } = {}) {
      const initial = context();
      const plan = validate(packet, initial); // Entire batch must validate before any write.
      const report = { validatedCases: plan.length, writtenCases: [], preservedCases: [], checkOnly };
      if (checkOnly) return report;
      for (let n = 0; n < plan.length; n++) {
        // Recheck source/human hashes and existing grades between case commits.
        const current = validate(packet, context())[n];
        if (current.review) { report.preservedCases.push(current.fixture.id); continue; }
        try {
          publishNew(current.reviewPath, current.reviewToWrite, stage => checkpoint(stage, current.fixture.id));
          report.writtenCases.push(current.fixture.id);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          // Another importer may have published this same case first.
          const concurrent = validate(packet, context())[n];
          requireReview(concurrent.review, 'Concurrent grading could not be verified.');
          report.preservedCases.push(current.fixture.id);
        }
        checkpoint('case_committed', current.fixture.id);
      }
      validate(packet, context());
      return report;
    },
  };
}
