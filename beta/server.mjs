import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Ledger, databasePool } from './ledger.mjs';
import {
  configuration,
  identity,
  keyedHash,
  clientIP,
  ipQuotaIdentity,
  verifyTurnstile,
  publicFailure,
  scrub,
} from './security.mjs';
import { POLICY, BetaError, exactKeys, planInput, requireThat, uuid } from './policy.mjs';
import { benchmark } from './engine.mjs';
import { fakeProvider } from './fake-provider.mjs';

const files = new Map([
  ['/', ['./public/index.html', 'text/html']],
  ['/src/app.js', ['./public/app.js', 'text/javascript']],
  ['/src/models.js', ['../src/models.js', 'text/javascript']],
  ['/src/data.js', ['../src/data.js', 'text/javascript']],
  ['/src/styles.css', ['../src/styles.css', 'text/css']],
  ['/beta.css', ['./public/beta.css', 'text/css']],
  ['/public/favicon.svg', ['../public/favicon.svg', 'image/svg+xml']],
]);
export const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  let buffer;
  try {
    requireThat(!req.headers['content-encoding']);
    if (req.headers['content-length'])
      requireThat(Number(req.headers['content-length']) <= POLICY.maxBodyBytes);
    for await (const chunk of req) {
      bytes += chunk.length;
      requireThat(bytes <= POLICY.maxBodyBytes);
      chunks.push(chunk);
    }
    buffer = Buffer.concat(chunks);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new BetaError('input');
  } finally {
    buffer?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
export function createHandler({ config, ledger, provider, verifier, guardIntervalMs }) {
  const sessions = identity(config);
  const verify =
    verifier ??
    (config.mode === 'demo'
      ? async (token) => requireThat(token === 'local-demo', 'verification')
      : (token, signal) => verifyTurnstile(token, config, { signal }));
  const engineProvider = provider ?? (config.mode === 'demo' ? fakeProvider() : undefined);
  const secrets = [
    config.apiKey,
    config.turnstileSecret,
    config.identitySecret,
    config.databaseUrl,
  ];
  return async (req, res) => {
    let body;
    let controller;
    let onClose;
    const send = (status, data) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(scrub(data, secrets)));
    };
    const emit = (event) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(JSON.stringify(scrub(event, secrets)) + '\n');
    };
    try {
      requireThat(req.headers.host === new URL(config.origin).host, 'origin');
      const url = new URL(req.url, config.origin);
      if (url.pathname === '/healthz' && req.method === 'GET') {
        await ledger.status();
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/config' && req.method === 'GET' && !url.search) {
        const visitor = sessions.ensure(req, res);
        return send(200, {
          mode: config.mode,
          siteKey: config.siteKey,
          csrf: sessions.csrf(visitor),
        });
      }
      if (url.pathname.startsWith('/api/')) {
        requireThat(
          req.method === 'POST' &&
            !url.search &&
            req.headers.origin === config.origin &&
            /^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '') &&
            !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']),
          'origin',
        );
        requireThat(['/api/plan', '/api/benchmark', '/api/events'].includes(url.pathname));
        const visitor = sessions.read(req);
        requireThat(visitor && sessions.validCsrf(req, visitor), 'session');
        const ip = clientIP(req, config),
          ipHash = keyedHash(config.identitySecret, 'ip', ipQuotaIdentity(ip));
        await ledger.throttle(ipHash);
        body = await readBody(req);
        if (url.pathname === '/api/events') {
          exactKeys(body, ['id', 'name', 'runId', 'candidateIndex']);
          await ledger.analytics(body, visitor.hash);
          return send(200, { ok: true });
        }
        exactKeys(
          body,
          url.pathname === '/api/plan' ? ['input'] : ['input', 'idempotencyKey', 'turnstileToken'],
        );
        const { input, plan } = planInput(body.input);
        requireThat(config.allowed(), 'paused');
        if (url.pathname === '/api/plan') {
          await ledger.status();
          return send(200, plan);
        }
        requireThat(uuid(body.idempotencyKey));
        const id = body.idempotencyKey;
        const bodyHash = keyedHash(config.identitySecret, 'request', JSON.stringify(input));
        await ledger.duplicate(id, visitor.hash, bodyHash);
        controller = new AbortController();
        onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.on('close', onClose);
        await verify(body.turnstileToken, controller.signal);
        requireThat(!res.destroyed && !controller.signal.aborted, 'cancelled');
        const reservation = await ledger.reserve({
          id,
          owner: randomUUID(),
          visitorHash: visitor.hash,
          ipHash,
          bodyHash,
          plan,
        });
        res.writeHead(200, {
          ...headers,
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        const result = await benchmark({
          ledger,
          reservation,
          input,
          plan,
          apiKey: config.apiKey,
          signal: controller.signal,
          emit,
          provider: engineProvider,
          guardIntervalMs,
        });
        emit({ type: 'result', result });
        res.end();
        return;
      }
      requireThat(['GET', 'HEAD'].includes(req.method), 'origin');
      const file = files.get(url.pathname);
      if (!file) return send(404, { error: { code: 'not_found', message: 'Not found.' } });
      const content = await readFile(new URL(file[0], import.meta.url));
      res.writeHead(200, {
        ...headers,
        'Content-Type': `${file[1]}; charset=utf-8`,
        ...(config.mode === 'live' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const safe = publicFailure(error);
      if (!res.destroyed) {
        if (res.headersSent) {
          emit({ type: 'error', error: safe.error });
          res.end();
        } else send(safe.status, { error: safe.error });
      }
    } finally {
      body = null;
      if (onClose) res.off('close', onClose);
    }
  };
}
export function webServer(options) {
  const server = createServer(createHandler(options));
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 180000;
  server.keepAliveTimeout = 5000;
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = configuration();
    const pool = databasePool(config.databaseUrl);
    const ledger = new Ledger(pool, config);
    await ledger.status();
    const server = webServer({ config, ledger });
    server.on('error', () => {
      console.error('Beta server could not start. Check private deployment configuration.');
      process.exitCode = 1;
    });
    server.listen(config.port, config.mode === 'demo' ? '127.0.0.1' : '0.0.0.0', () =>
      console.log(`AI Bill Doctor beta started (${config.mode}).`),
    );
    const stop = () => {
      server.close(() => void pool.end());
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch {
    console.error(
      'Beta startup blocked. Check database, migrations and server-side configuration.',
    );
    process.exitCode = 1;
  }
}
