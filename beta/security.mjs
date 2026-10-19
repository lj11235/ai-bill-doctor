import { createHmac, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';
import { BetaError, requireThat, pricingHash, uuid } from './policy.mjs';

export function configuration(env = process.env) {
  const mode = env.BETA_MODE ?? 'live';
  requireThat(['live', 'demo'].includes(mode), 'unavailable');
  let origin;
  try {
    origin = new URL(env.PUBLIC_ORIGIN ?? '');
  } catch {
    throw new BetaError('unavailable');
  }
  requireThat(
    origin.origin === env.PUBLIC_ORIGIN && !origin.username && !origin.password,
    'unavailable',
  );
  requireThat(
    mode === 'live'
      ? origin.protocol === 'https:'
      : origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname),
    'unavailable',
  );
  requireThat(
    typeof env.IDENTITY_SECRET === 'string' && env.IDENTITY_SECRET.length >= 48,
    'unavailable',
  );
  const trusted = (env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .filter(Boolean)
    .map((value) => {
      try {
        return ipaddr.parseCIDR(value.trim());
      } catch {
        throw new BetaError('unavailable');
      }
    });
  requireThat(
    trusted.every(([, bits]) => bits > 0),
    'unavailable',
  );
  const config = {
    mode,
    origin: origin.origin,
    hostname: origin.hostname,
    port: Number(env.PORT ?? 5174),
    databaseUrl: env.DATABASE_URL,
    identitySecret: env.IDENTITY_SECRET,
    trusted,
    apiKey: mode === 'live' ? env.OPENAI_API_KEY : '',
    turnstileSecret: mode === 'live' ? env.TURNSTILE_SECRET_KEY : '',
    siteKey: mode === 'live' ? env.TURNSTILE_SITE_KEY : '',
    identityHash: createHash('sha256').update(env.IDENTITY_SECRET).digest('hex'),
    allowed: () => {
      if (env.BETA_KILL_SWITCH !== '0') return false;
      if (mode === 'demo') return true;
      const expiry = Date.parse(env.PRICING_APPROVED_UNTIL ?? '');
      return (
        env.PRICING_APPROVED_HASH === pricingHash &&
        expiry > Date.now() &&
        expiry - Date.now() <= 7 * 86400000
      );
    },
  };
  requireThat(
    config.databaseUrl && Number.isInteger(config.port) && config.port > 0 && config.port < 65536,
    'unavailable',
  );
  if (mode === 'live')
    requireThat(
      [config.apiKey, config.turnstileSecret, config.siteKey].every(
        (v) => typeof v === 'string' && v.length >= 10,
      ),
      'unavailable',
    );
  return config;
}
export const keyedHash = (secret, purpose, value) =>
  createHmac('sha256', secret).update(`${purpose}\0${value}`).digest('hex');
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function identity(config) {
  const name = config.mode === 'live' ? '__Host-abd' : 'abd_local';
  const sign = (value) => keyedHash(config.identitySecret, 'cookie', value);
  const read = (req) => {
    const values = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${name}=`));
    if (values.length !== 1) return null;
    const value = values[0].slice(name.length + 1);
    const [id, issued, signature, ...rest] = value.split('.');
    if (
      rest.length ||
      !uuid(id) ||
      !/^\d{13}$/.test(issued) ||
      !equal(signature, sign(`${id}.${issued}`))
    )
      return null;
    const age = Date.now() - Number(issued);
    if (age < 0 || age > 30 * 86400000) return null;
    return { id, hash: keyedHash(config.identitySecret, 'visitor', id) };
  };
  return {
    read,
    ensure(req, res) {
      const existing = read(req);
      if (existing) return existing;
      const value = `${randomUUID()}.${Date.now()}`;
      res.setHeader(
        'Set-Cookie',
        `${name}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${config.mode === 'live' ? '; Secure' : ''}`,
      );
      return {
        id: value.split('.')[0],
        hash: keyedHash(config.identitySecret, 'visitor', value.split('.')[0]),
      };
    },
    csrf: (visitor) => keyedHash(config.identitySecret, 'csrf', visitor.id),
    validCsrf: (req, visitor) =>
      equal(req.headers['x-csrf-token'], keyedHash(config.identitySecret, 'csrf', visitor.id)),
  };
}
function parsedIP(value) {
  try {
    const address = ipaddr.process(value);
    return address;
  } catch {
    throw new BetaError('origin');
  }
}
export function clientIP(req, config) {
  let current = parsedIP(req.socket.remoteAddress);
  const trusted = (address) =>
    config.trusted.some(
      ([network, bits]) => network.kind() === address.kind() && address.match(network, bits),
    );
  // Ignore spoofed forwarding headers unless the direct peer is explicitly trusted.
  if (trusted(current)) {
    const value = req.headers['x-forwarded-for'];
    requireThat(typeof value === 'string' && value.length < 1024, 'origin');
    const chain = value.split(',').map((s) => s.trim());
    requireThat(chain.length <= 10, 'origin');
    for (let i = chain.length - 1; i >= 0 && trusted(current); i--) current = parsedIP(chain[i]);
  }
  return current.toString();
}
export function ipQuotaIdentity(ip) {
  const address = parsedIP(ip);
  if (address.kind() === 'ipv4') return address.toString();
  // Group IPv6 privacy addresses by /64 so rotating the interface ID is not a quota reset.
  const bytes = address.toByteArray();
  bytes.fill(0, 8);
  return ipaddr.fromByteArray(bytes).toNormalizedString();
}
export async function verifyTurnstile(token, config, { fetchImpl = fetch, signal } = {}) {
  requireThat(
    typeof token === 'string' && token.length > 0 && token.length <= 2048,
    'verification',
  );
  const timeout = AbortSignal.timeout(8000);
  try {
    const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({ secret: config.turnstileSecret, response: token }),
    });
    requireThat(response.ok, 'verification');
    const data = await response.json();
    const age = Date.now() - Date.parse(data.challenge_ts);
    requireThat(
      data.success === true &&
        data.hostname === config.hostname &&
        data.action === 'benchmark' &&
        age >= -30000 &&
        age <= 300000,
      'verification',
    );
  } catch {
    throw new BetaError('verification');
  }
}
export function publicFailure(error) {
  const safe = error instanceof BetaError ? error : new BetaError('unavailable');
  return { status: safe.status, error: { code: safe.code, message: safe.message } };
}
export function scrub(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter((s) => typeof s === 'string' && s.length >= 8))
      value = value.replaceAll(secret, '[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  return value;
}
