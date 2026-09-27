import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { buildPlan, runBenchmark } from './lib/benchmark.mjs';
import { BenchmarkError, publicError } from './lib/errors.mjs';
import { LIMITS } from './src/models.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const publicFiles = new Set(['index.html', 'src/app.js', 'src/data.js', 'src/models.js', 'src/styles.css', 'public/favicon.svg']);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  let buffer;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 300000) throw new BenchmarkError('context_too_long', 'This example is too large. Try a shorter request.', 413);
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
    const value = JSON.parse(buffer.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof BenchmarkError) throw error;
    throw new BenchmarkError('invalid_input', 'Could not read the request. Reload this page and try again.');
  } finally {
    buffer?.fill(0);
    chunks.forEach(chunk => chunk.fill(0));
  }
}

// Export the HTTP handler for tests. Provider injection is test-only; there is
// no environment switch, URL parameter, or route that enables fake results.
export function createHandler({ provider, budgetUsd = LIMITS.budgetUsd } = {}) {
  let running = false;
  return async (req, res) => {
    let apiKey = '';
    let body;
    let controller;
    let ownsRun = false;
    let close;
    const json = (status, data) => {
      res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const emit = event => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
    try {
      // Loopback binding plus Host/Origin checks keep other sites from using a
      // visitor's local server. There are no cookies, stored keys, or CORS grants.
      const host = req.headers.host;
      if (!['localhost', '127.0.0.1'].some(name => host === `${name}:${req.socket.localPort}`)) {
        throw new BenchmarkError('local_only', 'Open this app using its localhost address.', 403);
      }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') return json(405, { error: { message: 'Use POST for benchmark requests.' } });
        if (url.search || req.headers.origin !== `http://${host}` || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
          throw new BenchmarkError('local_only', 'Run the benchmark from this app’s local page.', 403);
        }
        if (!['/api/plan', '/api/benchmark'].includes(url.pathname)) return json(404, { error: { message: 'Not found.' } });
        body = await readJson(req);
        apiKey = body.apiKey;
        delete body.apiKey;
        if (url.pathname === '/api/plan') return json(200, buildPlan(body.input, budgetUsd));
        if (running) throw new BenchmarkError('busy', 'A benchmark is already running. Let it finish before starting another.', 409);
        const plan = buildPlan(body.input, budgetUsd);
        if (plan.requiresConfirmation && !(typeof body.approvedMaxCost === 'number' && body.approvedMaxCost >= plan.maxCost && body.approvedMaxCost <= LIMITS.hardBudgetUsd)) {
          throw new BenchmarkError('budget_confirmation', 'Approve the displayed benchmark budget before continuing. No model calls were made.');
        }
        running = ownsRun = true;
        controller = new AbortController();
        close = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', close);
        if (res.destroyed) controller.abort();
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.flushHeaders();
        const result = await runBenchmark({ input: body.input, apiKey, approvedMaxCost: body.approvedMaxCost, budgetUsd, signal: controller.signal, emit, provider });
        emit({ type: 'result', result });
        res.end();
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: { message: 'Method not allowed.' } });
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (!publicFiles.has(relative)) return json(404, { error: { message: 'Not found.' } });
      const content = await readFile(resolve(root, relative));
      res.writeHead(200, { ...securityHeaders, 'Content-Type': `${mime[extname(relative)]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const safe = publicError(error);
      if (res.headersSent) { emit({ type: 'error', error: safe }); res.end(); }
      else json(error instanceof BenchmarkError ? error.status : 500, { error: safe });
    } finally {
      apiKey = '';
      if (body) { delete body.apiKey; body = null; }
      if (close) res.off('close', close);
      if (ownsRun) running = false;
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 5173);
  const budgetUsd = Number(process.env.BENCHMARK_BUDGET_USD || LIMITS.budgetUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > LIMITS.hardBudgetUsd) {
    console.error('BENCHMARK_BUDGET_USD must be greater than zero and at most 0.25.');
    process.exitCode = 1;
  } else {
    createServer(createHandler({ budgetUsd }))
      .on('error', () => { console.error('Could not start AI Bill Doctor. Check whether the port is already in use.'); process.exitCode = 1; })
      .listen(port, '127.0.0.1', () => console.log(`AI Bill Doctor · local benchmark\nhttp://localhost:${port}\nPress Ctrl+C to stop.`));
  }
}
