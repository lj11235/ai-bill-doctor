import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReview, readReviewJson, ReviewError } from './runner.mjs';

export function main(args = process.argv.slice(2), options = {}) {
  const [command, experimentId, path, ...flags] = args;
  if (!command || (command === 'help' && args.length === 1)) {
    console.log('Offline manual rubric review. No provider calls or identity/cost reveal.\n\nnode internal/review/cli.mjs status EXPERIMENT\nnode internal/review/cli.mjs export EXPERIMENT FILE.json\nnode internal/review/cli.mjs import EXPERIMENT FILE.json --check\nnode internal/review/cli.mjs import EXPERIMENT FILE.json');
    return;
  }
  const valid = command === 'status' ? args.length === 2
    : command === 'export' ? args.length === 3
      : command === 'import' && (args.length === 3 || (args.length === 4 && flags[0] === '--check'));
  if (!valid) throw new ReviewError('Invalid command or arguments. Use help.');
  const review = createReview({ ...options, experimentId });
  const result = command === 'status' ? review.status()
    : command === 'export' ? review.export(resolve(path))
      : review.import(readReviewJson(resolve(path)), { checkOnly: flags[0] === '--check' });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof ReviewError ? error.message : 'Review operation stopped. Existing grading records were preserved; inspect status before resuming.');
    process.exitCode = 1;
  }
}
