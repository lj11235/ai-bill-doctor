import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBatch, safeFailure } from './runner.mjs';
import { hiddenLine } from '../diagnostics/connectivity.mjs';

// No environment/argv/file credentials. --paid --approve 1.50 is the explicit
// batch authorization; the terminal asks for the hidden key once, not per case.
export async function main(args = process.argv.slice(2), {
  batch = createBatch(), input = process.stdin, output = process.stdout,
} = {}) {
  const print = value => output.write(JSON.stringify(value, null, 2) + '\n');
  let apiKey = '';
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    if (!args.length || (args.length === 1 && args[0] === 'plan')) { print(batch.preview()); return 0; }
    if (args.length === 1 && args[0] === 'status') { print(batch.status()); return 0; }
    if (args.length !== 4 || args[0] !== 'run' || args[1] !== '--paid' || args[2] !== '--approve' || args[3] !== '1.50') {
      print({ state: 'not_dispatched', reason: 'approval_required', command: 'node internal/batch/cli.mjs run --paid --approve 1.50' }); return 1;
    }
    const plan = batch.preview(); print(plan);
    if (!input.isTTY || !output.isTTY) { print({ state: 'not_dispatched', reason: 'interactive_terminal_required' }); return 1; }
    output.write('You authorized this single batch up to $1.50. No retries or automatic resume.\n');
    apiKey = await hiddenLine('Temporary OpenAI API key (hidden; memory only): ', input, output);
    process.on('SIGINT', abort); process.on('SIGTERM', abort);
    const result = await batch.run({ paid: true, approvedUsd: 1.50, apiKey, signal: controller.signal, progress: print });
    apiKey = ''; print(result);
    return result.state === 'complete' && !result.accountingUncertain ? 0 : 1;
  } catch (error) { print(safeFailure(error)); return 1; }
  finally {
    apiKey = ''; process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('Batch stopped. Use the read-only status command; do not retry or remove reservations.');
    process.exitCode = 1;
  });
}
