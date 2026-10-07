import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadSuite, createManifest, verifyManifest, findCase, casePlan, assertPaidApproval, executeCase, blindView, recordHuman, reveal, grade, verifyHuman, summarize, catalog, projectRoot, replacementQuestion } from './runner.mjs';

const outputRoot = fileURLToPath(new URL('outputs/internal-benchmark/', projectRoot));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const writeNew = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const terminalText = text => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const print = value => console.log(typeof value === 'string' ? terminalText(value) : JSON.stringify(value, null, 2));

function experimentPath(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? '')) throw new Error('Use an experiment name containing lowercase letters, numbers and hyphens.');
  return join(outputRoot, id);
}
function experiment(suite, id) {
  const directory = experimentPath(id);
  verifyManifest(suite, readJson(join(directory, 'manifest.json')));
  return directory;
}
function resultPaths(suite, id, caseId) {
  const c = findCase(suite, caseId);
  const directory = join(experiment(suite, id), c.id);
  return { c, directory, result: join(directory, 'result.json'), human: join(directory, 'human.json'), rubric: join(directory, 'rubric.json') };
}
function assertResult(suite, c, result) {
  if (result.caseId !== c.id || result.suiteFingerprint !== suite.fingerprint) throw new Error('Result belongs to different locked definitions.');
  // Also validate the model sequence and frozen preflight before review/reveal.
  summarize(suite, [{ result }]);
}
function blindText(c, result) {
  const view = blindView(c, result);
  return `${view.caseId}: ${view.title}\n\nSYSTEM\n${view.system}\n\nREQUEST\n${view.request}\n\n` + view.outputs.map(item => `${item.label}\n${item.availability}\n${item.output || '(no output)'}\n`).join('\n');
}

// TTY-only, no echo; never accept a key in argv, an env variable or a file.
async function temporaryKey() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('A local interactive terminal is required for the temporary key. No calls made.');
  process.stdout.write('Temporary OpenAI API key (hidden; memory only): ');
  return new Promise((resolveKey, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';
    const finish = (error) => {
      input.removeListener('data', onData); input.removeListener('end', onEnd);
      input.setRawMode(wasRaw); input.pause(); process.stdout.write('\n');
      const key = value; value = '';
      if (error) reject(error); else resolveKey(key);
    };
    const onEnd = () => finish(new Error('Key entry cancelled. No calls made.'));
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') { finish(new Error('Key entry cancelled. No calls made.')); return; }
        if (character === '\r' || character === '\n') {
          finish(/^[\x21-\x7e]{10,512}$/.test(value) ? null : new Error('Invalid temporary key format. No calls made.')); return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (/^[\x21-\x7e]$/.test(character) && value.length < 512) value += character;
      }
    };
    input.setRawMode(true); input.resume(); input.on('data', onData); input.on('end', onEnd);
  });
}

async function askChoice(rl, question, choices) {
  for (;;) {
    const answer = (await rl.question(`${question} [${choices.join('/')}]: `)).trim().toLowerCase();
    if (choices.includes(answer)) return answer;
    print('Please enter one of the listed values.');
  }
}
function reviewerTerminal() {
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal to record review decisions.');
  return createInterface({ input: process.stdin, output: process.stdout });
}

export async function main(args = process.argv.slice(2)) {
  const [command, id, caseId, ...flags] = args;
  const suite = loadSuite();
  if (!command || command === 'help') {
    print('Internal benchmark only. No command makes paid calls except run with explicit approval.\n\nnode internal/benchmark/cli.mjs list\nnode internal/benchmark/cli.mjs catalog\nnode internal/benchmark/cli.mjs init EXPERIMENT\nnode internal/benchmark/cli.mjs plan CASE_ID\nnode internal/benchmark/cli.mjs run EXPERIMENT CASE_ID --paid --approve USD\nnode internal/benchmark/cli.mjs blind EXPERIMENT CASE_ID\nnode internal/benchmark/cli.mjs human EXPERIMENT CASE_ID\nnode internal/benchmark/cli.mjs rubric EXPERIMENT CASE_ID\nnode internal/benchmark/cli.mjs reveal EXPERIMENT CASE_ID\nnode internal/benchmark/cli.mjs summary EXPERIMENT');
    return;
  }
  if (command === 'list' && args.length === 1) {
    print(suite.fixtures.cases.map(c => ({ id: c.id, category: c.category, baseline: c.baselineModel, evaluation: c.evaluationType, maximumCost: casePlan(c).maxCost })));
    return;
  }
  if (command === 'catalog' && args.length === 1) { print(catalog(suite)); return; }
  if (command === 'plan' && args.length === 2) { print(casePlan(findCase(suite, id))); return; }
  if (command === 'init' && args.length === 2) {
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const directory = experimentPath(id);
    mkdirSync(directory, { mode: 0o700 }); // Existing experiments are never reset.
    writeNew(join(directory, 'manifest.json'), createManifest(suite, id));
    print(`Locked ${suite.fixtures.suiteId} as ${id}. No calls made. One attempt per case; definitions/settings are now frozen for this experiment.`);
    return;
  }
  if (command === 'summary' && args.length === 2) {
    const directory = experiment(suite, id);
    const entries = [];
    for (const c of suite.fixtures.cases) {
      const caseDirectory = join(directory, c.id);
      if (!existsSync(join(caseDirectory, 'result.json'))) continue;
      const entry = { result: readJson(join(caseDirectory, 'result.json')) };
      for (const [key, file] of [['human', 'human.json'], ['review', 'rubric.json']]) if (existsSync(join(caseDirectory, file))) entry[key] = readJson(join(caseDirectory, file));
      entries.push(entry);
    }
    print(summarize(suite, entries)); return;
  }
  if (!['run', 'blind', 'human', 'rubric', 'reveal'].includes(command)) throw new Error('Unknown command or arguments. Use help.');
  if (command !== 'run' && args.length !== 3) throw new Error('Expected EXPERIMENT CASE_ID only.');
  const paths = resultPaths(suite, id, caseId);
  if (command === 'run') {
    if (flags.length !== 3 || flags[0] !== '--paid' || flags[1] !== '--approve') throw new Error('No calls made. Run requires --paid --approve USD. Use plan first.');
    const approvedMaxCost = Number(flags[2]);
    const plan = casePlan(paths.c);
    assertPaidApproval(plan, true, approvedMaxCost);
    if (existsSync(paths.directory)) throw new Error('This case already has an attempt/reservation. It will not be overwritten or retried.');
    print(`This will run ${plan.calls.length} paid calls, reserving up to $${plan.maxCost.toFixed(6)}. No retries.`);
    let apiKey = await temporaryKey();
    try {
      // Key entry can take time; recheck the lock before any paid call.
      verifyManifest(loadSuite(), readJson(join(experimentPath(id), 'manifest.json')));
      mkdirSync(paths.directory, { mode: 0o700 });
      const checkpoint = record => {
        const temporary = join(paths.directory, 'checkpoint.tmp');
        writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
        renameSync(temporary, paths.result);
      };
      const result = await executeCase({ suite, caseId, apiKey, paid: true, approvedMaxCost, checkpoint });
      print(`Recorded ${caseId}: ${result.engineOutcome}. Use blind/human to review. Costs remain hidden in the review workflow.`);
    } finally { apiKey = ''; }
    return;
  }
  const result = readJson(paths.result);
  assertResult(suite, paths.c, result);
  if (command === 'blind') { print(blindText(paths.c, result)); return; }
  if (command === 'human') {
    if (existsSync(paths.human)) throw new Error('Human decisions are already locked.');
    if (result.state !== 'finished') throw new Error('Interrupted attempt: preserve it as inconclusive; do not rerun this case.');
    print(blindText(paths.c, result));
    const decisions = {};
    const complete = result.calls.filter(c => c.role === 'candidate' && c.status === 'complete');
    if (complete.length) {
      const rl = reviewerTerminal();
      try { for (const call of complete) decisions[call.label] = await askChoice(rl, `${call.label}: ${replacementQuestion}`, ['yes', 'no']); }
      finally { rl.close(); }
    }
    writeNew(paths.human, recordHuman(result, decisions));
    print('Human replacement decisions locked. Grade independently with rubric; reveal is now available.'); return;
  }
  const human = readJson(paths.human);
  verifyHuman(result, human);
  if (command === 'reveal') { print(reveal(result, human)); return; }
  if (existsSync(paths.rubric)) throw new Error('Rubric judgments are already locked.');
  const rubric = suite.rubrics.cases[caseId];
  const checks = {};
  if (rubric.type === 'manual_rubric' && result.calls.some(c => c.status === 'complete')) {
    print(blindText(paths.c, result));
    print(`PRECOMMITTED RUBRIC\n${JSON.stringify(rubric, null, 2)}`);
    const rl = reviewerTerminal();
    try {
      for (const call of result.calls.filter(c => c.status === 'complete')) {
        checks[call.label] = [];
        for (const criterion of rubric.criteria) {
          print(`${call.label} / ${criterion.id} (${criterion.severity}): ${criterion.requirement}`);
          const verdict = await askChoice(rl, 'Criterion result', ['pass', 'fail', 'inconclusive']);
          let evidence = '';
          while (!evidence.trim()) evidence = await rl.question('Evidence from the output/source (required): ');
          checks[call.label].push({ id: criterion.id, result: verdict, evidence });
        }
      }
    } finally { rl.close(); }
  }
  const review = grade(result, rubric, human, checks);
  writeNew(paths.rubric, review);
  print(review.judgments);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Internal benchmark: ${error.message}`); process.exitCode = 1; });
}
