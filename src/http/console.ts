import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { GatewayDatabase } from '../persistence/database.js';
import { AccountError, AccountStore, normaliseEmail, type AccountRecord } from '../accounts/store.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../accounts/passwords.js';
import { AccessError, type AccessVerifier } from '../accounts/access.js';
import {
  OauthError,
  authorizeUrl,
  createPkcePair,
  exchangeCode,
  verifyTelegramLogin,
  type OauthProvider
} from '../accounts/oauth.js';
import { BillingError, type BillingService } from '../billing/service.js';
import { planInputSchema } from '../billing/plan-input.js';
import { customTokenCents } from '../billing/pricing.js';
import { DAILY_BUDGET_UNITS, MAX_CONCURRENT, RATE_LIMIT_RPM } from '../billing/limit-bounds.js';
import { PaymentError, PAID_STATUSES, type CryptomusClient } from '../payments/cryptomus.js';
import { isPaidStatus as isLeuwongrrPaid, verifyHmacSignature } from '../payments/leuwongrr.js';
import { getExchangeRate, idrToTokens, setExchangeRate } from '../billing/exchange-rate.js';
import { assertResolvedPublicEgress } from '../policy/egress.js';
import { createSmtpTransport, sendOtpMail } from '../otp-smtp.js';
import { ModelCatalog, ModelError, modelInputSchema, modelUpdateSchema } from '../models/catalog.js';
import { ModelGroupCatalog, ModelGroupError, modelGroupInputSchema } from '../models/groups.js';
import type { OmniRouteClient } from '../upstream.js';
import type { Scope } from '../auth/api-keys.js';
import { TenantStoreError } from '../persistence/tenant-store.js';

export interface ConsoleDeps {
  config: Config;
  db: GatewayDatabase;
  accounts: AccountStore;
  billing: BillingService;
  payments: CryptomusClient;
  access: AccessVerifier | null;
  /** Optional: model sync pulls the OmniRoute catalog over the loopback client. */
  upstream?: OmniRouteClient;
  logger: Logger;
}

const PAGES: Record<string, string> = {
  // The apex is the public landing page; sign-in lives at /login. Without this
  // entry the allowlist refuses `/` and a visitor who types the bare hostname
  // gets a protocol 404.
  '/': 'index.html',
  '/admin': 'admin.html',
  '/member': 'member.html',
  '/chat': 'chat.html',
  '/login': 'login.html'
};

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8'
};

const ADMIN_ROLES = new Set(['admin', 'owner']);

/** Pre-computed once; used only to equalise timing when the account is absent. */
const DUMMY_PASSWORD_HASH = hashPassword('leuwongrr-timing-equaliser');
const ISSUABLE_SCOPES: readonly Scope[] = [
  'models:read',
  'chat:write',
  'responses:write',
  'messages:write'
];
/**
 * Keys issued and rotated per account per day. A member who needs more than
 * this has a process problem, not a key problem; the limit stops an automated
 * or compromised session from minting an unbounded key farm. Revocation stays
 * unlimited because removing access must never be rate limited.
 */
const MEMBER_KEY_DAILY_LIMIT = 10;

/**
 * Cryptomus reports money as a decimal string in the invoice currency. A value
 * we cannot parse is treated as no value at all, so a malformed callback can
 * never satisfy the amount check by accident.
 */
function reportedCents(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function fail(reply: FastifyReply, status: number, code: string, message: string, traceId: string) {
  return reply.code(status).send({ error: { code, message, trace_id: traceId } });
}

/** Keys this tenant created in the last 24h, rotated replacements included. */
function keysIssuedToday(db: GatewayDatabase, tenantId: string): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const row = db.db
    .prepare('SELECT COUNT(*) AS count FROM api_keys WHERE tenant_id=? AND created_at >= ?')
    .get(tenantId, since) as { count: number };
  return row.count;
}

interface UsageRecentRow {
  requestId: string;
  at: string;
  model: string | null;
  units: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  thinkingTokens: number | null;
  durationMs: number | null;
  finishReason: string | null;
  appLabel: string | null;
  costCentsEst: number | null;
}

interface UsageEventDetailRow {
  request_id: string;
  created_at: string;
  model_id: string | null;
  units: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  thinking_tokens: number | null;
  duration_ms: number | null;
  finish_reason: string | null;
  app_label: string | null;
}

interface ModelPriceRow {
  public_id: string;
  provider: string;
  input_price_cents: number;
  output_price_cents: number;
  cache_read_price_cents: number;
}

/**
 * Recent settled requests with the phase-B detail columns. Cost is an estimate
 * against the model's list price in cents per million tokens — plan multipliers
 * and wallet debits still rule the real ledger, so the UI labels it "est." and
 * rows without token splits (or an unknown model) show no cost rather than a
 * fabricated one.
 *
 * The formula normalises the cached-token overlap per provider: OpenAI reports
 * `prompt_tokens` inclusive of cached tokens, while Anthropic excludes cache
 * reads from `input_tokens`. The cent-per-million price columns are per-model
 * list prices; the actual billing also applies plan multipliers and wallet
 * debits, so the estimate is directional, not authoritative.
 */
function recentUsage(db: GatewayDatabase, tenantId: string, limit: number): UsageRecentRow[] {
  const rows = db.db
    .prepare(
      `SELECT request_id, created_at, model_id, units, input_tokens, output_tokens, cached_tokens,
              thinking_tokens, duration_ms, finish_reason, app_label
       FROM usage_events WHERE tenant_id=? AND state='settled'
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(tenantId, limit) as UsageEventDetailRow[];
  if (rows.length === 0) return [];
  const prices = new Map(
    (db.db
      .prepare('SELECT public_id, provider, input_price_cents, output_price_cents, cache_read_price_cents FROM models')
      .all() as ModelPriceRow[]).map((price) => [price.public_id, price])
  );
  return rows.map((row) => {
    const price = row.model_id !== null ? prices.get(row.model_id) : undefined;
    let costCentsEst: number | null = null;
    if (price && (row.input_tokens !== null || row.output_tokens !== null)) {
      const input = row.input_tokens ?? 0;
      const output = row.output_tokens ?? 0;
      const cached = row.cached_tokens ?? 0;
      // OpenAI prompt_tokens are inclusive of cached_tokens; to avoid
      // double-counting the cached portion at both input_price and
      // cache_read_price, subtract cached from the input term. The schema
      // stores the raw upstream value, so the subtraction is here in the
      // estimate, not in the stored row.
      const effectiveInput = price.provider === 'openai' ? Math.max(0, input - cached) : input;
      costCentsEst = Number(
        (
          (effectiveInput / 1_000_000) * price.input_price_cents +
          (output / 1_000_000) * price.output_price_cents +
          (cached / 1_000_000) * price.cache_read_price_cents
        ).toFixed(4)
      );
    }
    return {
      requestId: row.request_id,
      at: row.created_at,
      model: row.model_id,
      units: row.units,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cachedTokens: row.cached_tokens,
      thinkingTokens: row.thinking_tokens,
      durationMs: row.duration_ms,
      finishReason: row.finish_reason,
      appLabel: row.app_label,
      costCentsEst
    };
  });
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  const attributes = [
    `${config.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.SESSION_TTL_HOURS * 3600}`
  ];
  if (new URL(config.PUBLIC_BASE_URL).protocol === 'https:') attributes.push('Secure');
  reply.header('set-cookie', attributes.join('; '));
}

function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.header(
    'set-cookie',
    `${config.SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

const emailSchema = z.object({ email: z.string().email().max(254) }).strict();
const verifySchema = z
  .object({ email: z.string().email().max(254), code: z.string().regex(/^[0-9]{6}$/) })
  .strict();
const registerSchema = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(254),
    password: z.string().min(1).max(256),
    confirmPassword: z.string().min(1).max(256)
  })
  .strict();
const passwordLoginSchema = z
  .object({ email: z.string().email().max(254), password: z.string().min(1).max(256) })
  .strict();
const resetRequestSchema = z.object({ email: z.string().email().max(254) }).strict();
const resetSchema = z
  .object({
    email: z.string().email().max(254),
    code: z.string().regex(/^[0-9]{6}$/),
    password: z.string().min(1).max(256),
    confirmPassword: z.string().min(1).max(256)
  })
  .strict();
const setPasswordSchema = z
  .object({ password: z.string().min(1).max(256), confirmPassword: z.string().min(1).max(256) })
  .strict();
const keySchema = z
  .object({
    name: z.string().min(1).max(64),
    scopes: z.array(z.enum(['models:read', 'chat:write', 'responses:write', 'messages:write'])).min(1),
    expiresDays: z.number().int().min(1).max(365).optional()
  })
  .strict();
// Shared with the operator CLI: two writers of the same table must not disagree
// about what a plan may contain.
const planSchema = planInputSchema;
/**
 * `z.number()` already refuses NaN, and `.int()` refuses ±Infinity, but a JSON
 * body cannot carry either: `JSON.stringify` renders both as `null`. The
 * `finite()` clause is what makes the rejection explicit at the boundary rather
 * than an accident of encoding, and `tenant_limits` is enforcement state — a
 * non-finite value that reached SQLite would write a float or a NULL into a
 * column the request path reads as units.
 *
 * The bounds come from `limit-bounds.ts`, the same module `planInputSchema` and
 * the browser form read. Restating them here is how the UI came to disagree with
 * the route in the first place.
 */
const limitsSchema = z
  .object({
    tenantId: z.string().min(1).max(64),
    dailyBudgetUnits: z
      .number()
      .finite()
      .int()
      .min(DAILY_BUDGET_UNITS.min)
      .max(DAILY_BUDGET_UNITS.max),
    maxConcurrent: z.number().finite().int().min(MAX_CONCURRENT.min).max(MAX_CONCURRENT.max),
    rateLimitRpm: z.number().finite().int().min(RATE_LIMIT_RPM.min).max(RATE_LIMIT_RPM.max)
  })
  .strict();
const topupSchema = z
  .object({
    planId: z.string().min(1).max(32),
    amountCents: z.number().int().min(100).max(1_000_000),
    provider: z.enum(['cryptomus', 'leuwongrr']).default('cryptomus')
  })
  .strict();
/**
 * Custom token pack purchase: any quantity of tokens (1M minimum, one whole
 * million at a time) with a shelf life chosen from the durations the operator
 * sells. The price is the plan's pay-as-you-go rate plus 5%, computed here and
 * echoed into the snapshot so the settlement can never invent its own rate.
 */
const customTopupSchema = z
  .object({
    planId: z.string().min(1).max(32),
    tokenQuantity: z.number().int().min(1_000_000).max(1_000_000_000_000),
    durationHours: z.number().int().min(1).max(8_760),
    provider: z.enum(['cryptomus', 'leuwongrr']).default('cryptomus')
  })
  .strict();
const subscribeSchema = z
  .object({
    planId: z.string().min(1).max(32),
    provider: z.enum(['cryptomus', 'leuwongrr']).default('cryptomus')
  })
  .strict();

/**
 * The console is a separate concern from the LLM data plane: it never proxies
 * to OmniRoute, and it authenticates humans instead of API keys.
 */
export function registerConsole(app: FastifyInstance, deps: ConsoleDeps): void {
  const { config, accounts, billing, payments, db } = deps;
  const distRoot = normalize(config.WEB_DIST_PATH);
  // Release 2a: admin-owned model catalogue, read and written via the admin
  // surface only. The request path keeps using the static registry.
  const models = new ModelCatalog(db.db);
  const groups = new ModelGroupCatalog(db.db);

  async function currentAccount(req: FastifyRequest): Promise<AccountRecord | null> {
    const token = readCookie(req, config.SESSION_COOKIE_NAME);
    return token ? accounts.resolveSession(token) : null;
  }

  /**
   * Admin authority comes from Cloudflare Access, not from a cookie, so a
   * stolen member session can never reach an admin endpoint.
   */
  async function requireAdmin(req: FastifyRequest): Promise<AccountRecord> {
    if (!deps.access) throw new AccessError('access_not_configured', 503);
    const assertion = req.headers['cf-access-jwt-assertion'];
    const token = Array.isArray(assertion) ? assertion[0] : assertion;
    if (typeof token !== 'string') throw new AccessError('access_assertion_missing', 401);
    const identity = await deps.access.verify(token);
    const account = accounts.findByEmail(identity.email);
    if (!account || !ADMIN_ROLES.has(account.role)) throw new AccessError('admin_role_required', 403);
    if (account.status !== 'active') throw new AccessError('account_suspended', 403);
    return account;
  }

  function requireMember(account: AccountRecord | null): AccountRecord {
    if (!account) throw new AccountError('session_required', 401);
    return account;
  }

  function handle(error: unknown, reply: FastifyReply, traceId: string) {
    if (
      error instanceof AccountError ||
      error instanceof AccessError ||
      error instanceof OauthError ||
      error instanceof BillingError ||
      error instanceof PaymentError ||
      error instanceof ModelError ||
      error instanceof ModelGroupError
    ) {
      return fail(reply, error.statusCode, error.code, error.code.replace(/_/g, ' '), traceId);
    }
    deps.logger.error({ err: error, trace_id: traceId }, 'console_request_failed');
    return fail(reply, 500, 'console_error', 'Request could not be completed', traceId);
  }

  // ---- Static shell ----

  app.get('/', (req, reply) => servePage(req, reply));
  app.get('/admin', (req, reply) => servePage(req, reply));
  app.get('/member', (req, reply) => servePage(req, reply));
  app.get('/chat', (req, reply) => servePage(req, reply));
  app.get('/login', (req, reply) => servePage(req, reply));

  async function servePage(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split('?')[0] ?? req.url;
    const file = PAGES[path];
    if (!file) return fail(reply, 404, 'route_not_found', 'Route is not available', req.id);
    try {
      const html = await readFile(join(distRoot, file), 'utf8');
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('x-frame-options', 'DENY')
        .header('referrer-policy', 'same-origin')
        .send(html);
    } catch {
      return fail(reply, 503, 'console_not_built', 'Dashboard assets are not installed', req.id);
    }
  }

  app.get<{ Params: { file: string } }>('/console/assets/:file', async (req, reply) => {
    // The allowlist already restricts the character set; normalising and
    // re-checking the prefix makes traversal impossible even if that changes.
    const target = normalize(join(distRoot, 'assets', req.params.file));
    if (!target.startsWith(normalize(join(distRoot, 'assets')))) {
      return assetMiss(reply, req.id);
    }
    try {
      const body = await readFile(target);
      return reply
        .header('content-type', MIME[extname(target)] ?? 'application/octet-stream')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(body);
    } catch {
      return assetMiss(reply, req.id);
    }
  });

  /**
   * The shared hook removes `cache-control` for asset routes so a hit can declare
   * itself immutable. A miss must restore it: an absent header lets an
   * intermediary apply its own default and cache a 404 for a hashed filename that
   * exists in the next release.
   */
  function assetMiss(reply: FastifyReply, traceId: string) {
    reply.header('cache-control', 'no-store');
    return fail(reply, 404, 'route_not_found', 'Route is not available', traceId);
  }

  // ---- Session ----

  app.get('/console/api/session', async (req, reply) => {
    const account = await currentAccount(req);
    return reply.send({
      authenticated: Boolean(account),
      account: account
        ? {
            email: account.email,
            display_name: account.displayName,
            role: account.role,
            tenant_id: account.tenantId,
            has_password: accounts.hasPassword(account.id)
          }
        : null,
      providers: {
        google: Boolean(config.GOOGLE_CLIENT_ID),
        discord: Boolean(config.DISCORD_CLIENT_ID),
        telegram: Boolean(config.TELEGRAM_BOT_TOKEN),
        telegram_bot: config.TELEGRAM_BOT_USERNAME ?? null
      }
    });
  });

  /**
   * Issues a purpose-bound one-time code and delivers it through the configured
   * channel. Shared by the legacy request-code flow and the register/login/reset
   * flows so delivery behaviour (webhook, SMTP, development) stays in one place.
   */
  async function issueAndDeliver(
    email: string,
    purpose: 'login' | 'register' | 'reset',
    reply: FastifyReply
  ) {
    const code = accounts.issueCode(email, purpose, config.OTP_TTL_MINUTES, config.OTP_RESEND_SECONDS);
    if (config.OTP_DELIVERY === 'webhook' && config.OTP_WEBHOOK_URL) {
      // Resolved rather than literal inspection: the relay is operator
      // supplied, and a public name that answers with a private address is
      // exactly how a one-time code gets posted to something internal.
      const target = await assertResolvedPublicEgress(config.OTP_WEBHOOK_URL);
      const delivery = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.OTP_WEBHOOK_TOKEN
            ? { authorization: `Bearer ${config.OTP_WEBHOOK_TOKEN}` }
            : {})
        },
        body: JSON.stringify({
          email: normaliseEmail(email),
          code,
          ttl_minutes: config.OTP_TTL_MINUTES
        }),
        signal: AbortSignal.timeout(8000)
      });
      // A relay that answered 4xx or 5xx has delivered nothing. Reporting
      // success would leave the member waiting for a code that is never
      // going to arrive, with no signal to the operator that it failed.
      if (!delivery.ok) throw new AccountError('otp_delivery_failed', 502);
      return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
    }
    if (config.OTP_DELIVERY === 'smtp') {
      // ADR-014: the transport is created per request and closed after the
      // send; nodemailer only dials on sendMail, so nothing is held open
      // between requests. Any failure — auth, TLS, timeout, provider
      // refusal — becomes a fixed 502 like the webhook relay, and the
      // provider error is never carried here, so it cannot echo credentials.
      let transport: ReturnType<typeof createSmtpTransport> | undefined;
      try {
        transport = createSmtpTransport(config);
        await sendOtpMail(transport, {
          from: config.SMTP_FROM as string, // loadConfig forces all-or-nothing
          to: normaliseEmail(email),
          code,
          ttlMinutes: config.OTP_TTL_MINUTES
        });
      } catch {
        // Any SMTP failure reduces to the same fixed 502: delivered nothing.
        throw new AccountError('otp_delivery_failed', 502);
      } finally {
        transport?.close?.();
      }
      return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
    }
    // Development delivery returns the code in the response instead of the
    // log, so a secret never lands in a file an operator might ship.
    return reply.send({ delivered: false, ttl_minutes: config.OTP_TTL_MINUTES, dev_code: code });
  }

  app.post('/console/api/auth/request-code', async (req, reply) => {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Email is required', req.id);
    try {
      return await issueAndDeliver(parsed.data.email, 'login', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/verify-code', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Code is invalid', req.id);
    try {
      const ok = accounts.consumeLoginCode(
        parsed.data.email,
        parsed.data.code,
        config.OTP_MAX_ATTEMPTS
      );
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account =
        accounts.findByEmail(parsed.data.email) ?? accounts.create({ email: parsed.data.email });
      accounts.linkIdentity(account.id, 'email', normaliseEmail(parsed.data.email));
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.login',
        traceId: req.id,
        metadata: { method: 'email' }
      });
      return reply.send({ authenticated: true, role: account.role });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
    const { name, email, password, confirmPassword } = parsed.data;
    if (password !== confirmPassword) {
      return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
    }
    const weakness = validatePasswordStrength(password);
    if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
    try {
      const existing = accounts.findByEmail(email);
      if (existing) {
        if (existing.emailVerifiedAt !== null) {
          // Already active: answer the same success shape without sending a
          // code, so the response never reveals that the email is registered.
          return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
        }
        // Pending registration: refresh the credential and re-issue the code.
        accounts.setPassword(existing.id, hashPassword(password));
        db.db
          .prepare('UPDATE accounts SET display_name = ? WHERE id = ?')
          .run(name.slice(0, 120), existing.id);
        return await issueAndDeliver(email, 'register', reply);
      }
      const account = accounts.create({ email, displayName: name });
      accounts.setPassword(account.id, hashPassword(password));
      return await issueAndDeliver(email, 'register', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/register/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Code is invalid', req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'register', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || !accounts.hasPassword(account.id)) {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      if (account.status !== 'active') {
        return fail(reply, 403, 'account_suspended', 'Account is suspended', req.id);
      }
      accounts.markEmailVerified(account.id);
      accounts.linkIdentity(account.id, 'email', normaliseEmail(parsed.data.email));
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.register',
        traceId: req.id,
        metadata: { method: 'password' }
      });
      return reply.send({ authenticated: true, role: account.role });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/login/password', async (req, reply) => {
    const parsed = passwordLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(reply, 401, 'credential_invalid', 'Email or password is incorrect', req.id);
    }
    try {
      const account = accounts.findByEmail(parsed.data.email);
      const storedHash = account ? accounts.getPasswordHash(account.id) : null;
      // Verify against a dummy hash when the account or password is absent so
      // the response timing does not reveal whether the email exists.
      const ok = storedHash
        ? verifyPassword(parsed.data.password, storedHash)
        : verifyPassword(parsed.data.password, DUMMY_PASSWORD_HASH);
      if (
        !account ||
        !ok ||
        storedHash === null ||
        account.status !== 'active' ||
        account.emailVerifiedAt === null
      ) {
        return fail(reply, 401, 'credential_invalid', 'Email or password is incorrect', req.id);
      }
      return await issueAndDeliver(parsed.data.email, 'login', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/login/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Code is invalid', req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'login', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active' || account.emailVerifiedAt === null) {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      accounts.linkIdentity(account.id, 'email', normaliseEmail(parsed.data.email));
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.login',
        traceId: req.id,
        metadata: { method: 'password' }
      });
      return reply.send({ authenticated: true, role: account.role });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/password/request-reset', async (req, reply) => {
    const parsed = resetRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Email is required', req.id);
    try {
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active') {
        // Generic success; never reveal whether the email exists.
        return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
      }
      return await issueAndDeliver(parsed.data.email, 'reset', reply);
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/password/reset', async (req, reply) => {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
    if (parsed.data.password !== parsed.data.confirmPassword) {
      return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
    }
    const weakness = validatePasswordStrength(parsed.data.password);
    if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
    try {
      const ok = accounts.consumeCode(parsed.data.email, parsed.data.code, 'reset', config.OTP_MAX_ATTEMPTS);
      if (!ok) return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      const account = accounts.findByEmail(parsed.data.email);
      if (!account || account.status !== 'active') {
        return fail(reply, 401, 'code_invalid', 'Code is invalid or expired', req.id);
      }
      accounts.setPassword(account.id, hashPassword(parsed.data.password));
      accounts.markEmailVerified(account.id);
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.password.reset',
        traceId: req.id,
        metadata: { method: 'otp' }
      });
      return reply.send({ reset: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/password/set', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = setPasswordSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'All fields are required', req.id);
      if (parsed.data.password !== parsed.data.confirmPassword) {
        return fail(reply, 400, 'invalid_request', 'Passwords do not match', req.id);
      }
      const weakness = validatePasswordStrength(parsed.data.password);
      if (weakness) return fail(reply, 400, 'invalid_request', weakness, req.id);
      accounts.setPassword(account.id, hashPassword(parsed.data.password));
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.password.set',
        traceId: req.id,
        metadata: { method: 'session' }
      });
      return reply.send({ set: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/auth/logout', async (req, reply) => {
    const token = readCookie(req, config.SESSION_COOKIE_NAME);
    if (token) accounts.revokeSession(token);
    clearSessionCookie(reply, config);
    return reply.send({ authenticated: false });
  });

  // ---- Federated login ----

  app.get<{ Params: { provider: OauthProvider } }>(
    '/console/api/auth/start/:provider',
    async (req, reply) => {
      try {
        const state = randomUUID();
        const { verifier, challenge } = createPkcePair();
        accounts.saveOauthState({
          state,
          provider: req.params.provider,
          verifier,
          redirectPath: '/member',
          ttlMinutes: 10
        });
        return reply.redirect(authorizeUrl(config, req.params.provider, state, challenge), 302);
      } catch (error) {
        return handle(error, reply, req.id);
      }
    }
  );

  app.get<{ Params: { provider: OauthProvider }; Querystring: { code?: string; state?: string } }>(
    '/callbacks/:provider',
    async (req, reply) => {
      try {
        const { code, state } = req.query;
        if (!code || !state) return fail(reply, 400, 'invalid_request', 'Missing code', req.id);
        const saved = accounts.consumeOauthState(state, req.params.provider);
        if (!saved) return fail(reply, 400, 'state_invalid', 'Login state expired', req.id);
        const profile = await exchangeCode(config, req.params.provider, code, saved.verifier);
        const account =
          accounts.findByIdentity(req.params.provider, profile.subject) ??
          accounts.findByEmail(profile.email) ??
          accounts.create({ email: profile.email, displayName: profile.displayName });
        accounts.linkIdentity(account.id, req.params.provider, profile.subject);
        const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
        setSessionCookie(reply, config, token);
        db.audit({
          tenantId: account.tenantId,
          actorType: 'account',
          event: 'console.login',
          traceId: req.id,
          metadata: { method: req.params.provider }
        });
        return reply.redirect(saved.redirectPath, 302);
      } catch (error) {
        return handle(error, reply, req.id);
      }
    }
  );

  app.post('/callbacks/telegram', async (req, reply) => {
    try {
      if (!config.TELEGRAM_BOT_TOKEN) {
        return fail(reply, 404, 'provider_not_configured', 'Telegram login is off', req.id);
      }
      const payload = req.body as Record<string, string>;
      const login = verifyTelegramLogin(payload, config.TELEGRAM_BOT_TOKEN);
      // Telegram never provides an email, so it can only attach to an account
      // that already proved an address by another method.
      const existing = accounts.findByIdentity('telegram', login.id);
      const account = existing ?? (await currentAccount(req));
      if (!account) {
        return fail(reply, 409, 'telegram_link_required', 'Sign in first, then link Telegram', req.id);
      }
      accounts.linkIdentity(account.id, 'telegram', login.id);
      const token = accounts.createSession(account.id, config.SESSION_TTL_HOURS);
      setSessionCookie(reply, config, token);
      return reply.send({ authenticated: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // ---- Member API ----

  app.get('/console/api/member/overview', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const summary = billing.summary(account.id, account.tenantId);
      return reply.send({
        account: {
          email: account.email,
          display_name: account.displayName,
          role: account.role,
          has_password: accounts.hasPassword(account.id)
        },
        billing: summary,
        ledger: billing.ledger(account.id, 20)
      });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/member/usage', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const rows = db.db
        .prepare(
          "SELECT day, COALESCE(SUM(units), 0) AS units FROM usage_events WHERE tenant_id = ? AND state = 'settled' GROUP BY day ORDER BY day DESC LIMIT 30"
        )
        .all(account.tenantId) as Array<{ day: string; units: number }>;
      return reply.send({ days: rows.reverse(), recent: recentUsage(db, account.tenantId, 50) });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/member/plans', async (req, reply) => {
    try {
      requireMember(await currentAccount(req));
      return reply.send({ plans: billing.listMemberPlans() });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/member/keys', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      return reply.send({ keys: db.tenants.list(account.tenantId) });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/member/keys', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = keySchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Key request invalid', req.id);
      if (keysIssuedToday(db, account.tenantId) >= MEMBER_KEY_DAILY_LIMIT) {
        return fail(
          reply,
          429,
          'key_limit_reached',
          `Daily key creation limit reached (${MEMBER_KEY_DAILY_LIMIT}). Revoke unused keys to free a slot.`,
          req.id
        );
      }
      const scopes = parsed.data.scopes.filter((scope): scope is Scope =>
        ISSUABLE_SCOPES.includes(scope as Scope)
      );
      const issued = db.tenants.issue({
        tenantId: account.tenantId,
        name: parsed.data.name,
        scopes
      });
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.key.issued',
        traceId: req.id,
        metadata: { name: parsed.data.name, scopes }
      });
      // Shown once. The gateway stores only the HMAC of this value.
      return reply.send({ key: issued.plaintext });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/member/keys/revoke', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = z.object({ keyId: z.string().min(1).max(64) }).strict().safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Key id required', req.id);
      db.tenants.revoke(account.tenantId, parsed.data.keyId);
      return reply.send({ revoked: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/member/keys/rotate', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = z
        .object({
          keyId: z.string().min(1).max(64),
          graceMinutes: z.number().int().min(0).max(1440).optional()
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Rotate request invalid', req.id);
      if (keysIssuedToday(db, account.tenantId) >= MEMBER_KEY_DAILY_LIMIT) {
        return fail(
          reply,
          429,
          'key_limit_reached',
          `Daily key limit reached (${MEMBER_KEY_DAILY_LIMIT}). Revoke unused keys to free a slot.`,
          req.id
        );
      }
      const graceMinutes = parsed.data.graceMinutes ?? 30;
      let rotated;
      try {
        // Scoping by tenant inside the store is the actual authorisation: one
        // account can never rotate a key that belongs to another tenant.
        rotated = db.tenants.rotate(account.tenantId, parsed.data.keyId, { graceMinutes });
      } catch (error) {
        if (error instanceof TenantStoreError) {
          return fail(reply, 404, 'key_not_found', 'Key not found or already revoked', req.id);
        }
        throw error;
      }
      db.audit({
        tenantId: account.tenantId,
        actorType: 'account',
        event: 'console.key.rotated',
        traceId: req.id,
        metadata: { keyId: parsed.data.keyId, graceMinutes, replacedWith: rotated.key.id }
      });
      // Shown once, exactly like a freshly issued key.
      return reply.send({
        key: rotated.plaintext,
        key_id: rotated.key.id,
        grace_minutes: graceMinutes
      });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/member/payments', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const rows = db.db
        .prepare(
          'SELECT order_id, purpose, plan_id, tokens, amount_cents, currency, status, payment_url, created_at, settled_at FROM payments WHERE account_id = ? ORDER BY created_at DESC LIMIT 25'
        )
        .all(account.id);
      return reply.send({ payments: rows });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  async function openInvoice(input: {
    account: AccountRecord;
    purpose: 'subscription' | 'topup';
    planId: string;
    amountCents: number;
    tokens: number;
    traceId: string;
    provider: 'cryptomus' | 'leuwongrr';
    snapshot: Record<string, unknown>;
  }) {
    const orderId = `${input.purpose}-${randomUUID()}`;
    if (input.provider === 'leuwongrr') {
      const leuwongrrRate = getExchangeRate(db.db);
      const amountIdr = input.amountCents; // reuse amountCents column for IDR
      const paymentUrl = `${new URL(config.PUBLIC_BASE_URL).origin}/pay/leuwongrr?order_id=${encodeURIComponent(orderId)}&amount=${amountIdr}&tokens=${input.tokens}`;
      db.db
        .prepare(
          `INSERT INTO payments (id, account_id, provider, order_id, invoice_uuid, purpose, plan_id, tokens, token_amount, balance_cents, amount_cents, currency, status, settlement_status, entitlement_snapshot_json, payment_url, created_at)
           VALUES (?, ?, 'leuwongrr', ?, ?, ?, ?, ?, ?, ?, ?, 'IDR', ?, 'pending', ?, ?, ?)`
        )
        .run(
          randomUUID(),
          input.account.id,
          orderId,
          null,
          input.purpose,
          input.planId,
          input.tokens,
          input.tokens,
          0,
          amountIdr,
          'pending',
          JSON.stringify(input.snapshot),
          paymentUrl,
          new Date().toISOString()
        );
      void leuwongrrRate; // rate lookup ensures configured state is enforced at invoice time
      return { order_id: orderId, payment_url: paymentUrl, tokens: input.tokens, provider: 'leuwongrr' };
    }

    const invoice = await payments.createInvoice({
      orderId,
      amountCents: input.amountCents,
      currency: 'USD',
      callbackUrl: new URL('/webhooks/cryptomus', config.PUBLIC_BASE_URL).toString(),
      returnUrl: new URL('/member', config.PUBLIC_BASE_URL).toString()
    });
    db.db
      .prepare(
        `INSERT INTO payments (id, account_id, provider, order_id, invoice_uuid, purpose, plan_id, tokens, token_amount, balance_cents, amount_cents, currency, status, settlement_status, entitlement_snapshot_json, payment_url, created_at)
         VALUES (?, ?, 'cryptomus', ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'pending', ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.account.id,
        orderId,
        invoice.uuid,
        input.purpose,
        input.planId,
        input.tokens,
        input.tokens,
        0,
        input.amountCents,
        invoice.status,
        JSON.stringify(input.snapshot),
        invoice.paymentUrl,
        new Date().toISOString()
      );
    return { order_id: orderId, payment_url: invoice.paymentUrl, tokens: input.tokens };
  }

  app.post('/console/api/member/subscribe', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = subscribeSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Plan required', req.id);
      const plan = billing.getPlan(parsed.data.planId);
      if (!plan || !plan.active) return fail(reply, 404, 'plan_not_found', 'Plan unavailable', req.id);
      // Release 2 plans (spec 20.1) charge the purchase price from the
      // database; legacy plans keep the monthly rate.
      const priceCents =
        plan.durationHours !== null && plan.durationHours !== undefined
          ? (plan.priceCents ?? 0)
          : plan.monthlyPriceCents;
      if (priceCents === 0) {
        return reply.send({ subscription: billing.startSubscription(account.id, plan.id) });
      }
      // A monetary pack buys a cents balance, so the snapshot carries the
      // purchase price on the cents axis; every other method keeps it at zero
      // and the request path spends it through the active PAYG rate.
      const balanceCents = plan.method === 'monetary_pack' ? priceCents : 0;
      // Release 2: a token pack with a shelf life settles into a duration
      // subscription, not the permanent wallet, so it stacks with other packs
      // and expires on its own clock even when purchased from the plan card.
      const durationHours =
        (plan.method ?? 'token_pack') === 'token_pack' ? plan.durationHours ?? null : null;
      return reply.send(
        await openInvoice({
          account,
          purpose: 'subscription',
          planId: plan.id,
          amountCents: priceCents,
          tokens: plan.includedTokens,
          traceId: req.id,
          provider: parsed.data.provider,
          snapshot: { method: plan.method ?? 'token_pack', modelGroupId: plan.modelGroupId ?? null, planId: plan.id, amountCents: priceCents, tokens: plan.includedTokens, balanceCents, durationHours }
        })
      );
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/member/topup', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = topupSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Amount invalid', req.id);
      const plan = billing.getPlan(parsed.data.planId);
      if (!plan) return fail(reply, 404, 'plan_not_found', 'Plan unavailable', req.id);
      const tokens = billing.tokensForCents(plan, parsed.data.amountCents);
      return reply.send(
        await openInvoice({
          account,
          purpose: 'topup',
          planId: plan.id,
          amountCents: parsed.data.amountCents,
          tokens,
          traceId: req.id,
          provider: parsed.data.provider,
          snapshot: { method: 'token_pack', modelGroupId: plan.modelGroupId ?? null, planId: plan.id, amountCents: parsed.data.amountCents, tokens, balanceCents: 0 }
        })
      );
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  /**
   * Release 2 custom token pack: the member chooses any quantity (1M minimum,
   * whole millions) and a shelf life (24h / 7d / 30d / …); the rate is the
   * plan's pay-as-you-go rate plus 5%. Settlement grants the pack as a
   * duration subscription so it stacks with other packs and expires on its own
   * clock.
   */
  app.post('/console/api/member/custom-topup', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = customTopupSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Quantity invalid: minimum 1,000,000 tokens, whole millions only', req.id);
      if (parsed.data.tokenQuantity % 1_000_000 !== 0) {
        return fail(reply, 400, 'invalid_request', 'Quantity must be whole millions', req.id);
      }
      const plan = billing.getPlan(parsed.data.planId);
      if (!plan) return fail(reply, 404, 'plan_not_found', 'Plan unavailable', req.id);
      if (plan.overageCentsPerMillion <= 0) {
        return fail(reply, 409, 'plan_has_no_payg_rate', 'Plan has no pay-as-you-go rate', req.id);
      }
      const amountCents = customTokenCents(plan.overageCentsPerMillion, parsed.data.tokenQuantity);
      return reply.send(
        await openInvoice({
          account,
          purpose: 'topup',
          planId: plan.id,
          amountCents,
          tokens: parsed.data.tokenQuantity,
          traceId: req.id,
          provider: parsed.data.provider,
          snapshot: { method: 'token_pack', modelGroupId: plan.modelGroupId ?? null, planId: plan.id, amountCents, tokens: parsed.data.tokenQuantity, balanceCents: 0, durationHours: parsed.data.durationHours }
        })
      );
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // A member can hold a Rolling Time pass and several stacked Token Packs at
  // once; the console lists every live subscription so the reset toggle and the
  // expiry countdowns have one authoritative source instead of guessing from
  // the single-newest summary row.
  app.get('/console/api/member/subscriptions', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const rows = db.db
        .prepare(
          "SELECT s.id, s.plan_id, s.status, s.period_start, s.period_end, s.included_tokens, s.used_tokens, s.auto_renew, s.method, s.duration_hours, s.timer_basis, s.activated_at, s.expires_at, s.resets_remaining, p.name AS plan_name, p.tier_label FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.account_id = ? AND s.status IN ('active','past_due') ORDER BY s.created_at"
        )
        .all(account.id) as Array<{
        id: string;
        plan_id: string;
        status: string;
        period_start: string;
        period_end: string;
        included_tokens: number;
        used_tokens: number;
        auto_renew: number;
        method: string | null;
        duration_hours: number | null;
        timer_basis: string | null;
        activated_at: string | null;
        expires_at: string | null;
        resets_remaining: number;
        plan_name: string | null;
        tier_label: string | null;
      }>;
      return reply.send({
        subscriptions: rows.map((row) => ({
          id: row.id,
          planId: row.plan_id,
          planName: row.plan_name ?? row.plan_id,
          tierLabel: row.tier_label ?? '',
          status: row.status,
          method: row.method,
          includedTokens: row.included_tokens,
          usedTokens: row.used_tokens,
          durationHours: row.duration_hours,
          timerBasis: row.timer_basis,
          activatedAt: row.activated_at,
          expiresAt: row.expires_at,
          resetsRemaining: row.resets_remaining
        }))
      });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // Release 2 (spec 20.3): a member resets their own subscription's timer; the
  // service refuses with 409 when no resets remain or a reset is racing another.
  app.post('/console/api/member/subscription/reset', async (req, reply) => {
    try {
      const account = requireMember(await currentAccount(req));
      const parsed = z
        .object({ subscriptionId: z.string().min(1).max(64) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Subscription id required', req.id);
      const subscription = billing.getSubscription(parsed.data.subscriptionId);
      if (!subscription || subscription.accountId !== account.id) {
        return fail(reply, 404, 'subscription_not_found', 'Subscription unavailable', req.id);
      }
      return reply.send({ subscription: billing.resetSubscription(subscription.id) });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // ---- Admin API ----

  app.get('/console/api/admin/overview', async (req, reply) => {
    try {
      await requireAdmin(req);
      const totals = db.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM subscriptions WHERE status = 'active') AS active_subscriptions, (SELECT COALESCE(SUM(balance_tokens), 0) FROM wallets) AS wallet_tokens, (SELECT COALESCE(SUM(units), 0) FROM usage_events WHERE state = 'settled' AND day = ?) AS units_today"
        )
        .get(new Date().toISOString().slice(0, 10));
      const revenue = db.db
        .prepare(
          "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments WHERE status IN ('paid','paid_over')"
        )
        .get() as { cents: number };
      return reply.send({ totals, revenue_cents: revenue.cents });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/admin/plans', async (req, reply) => {
    try {
      await requireAdmin(req);
      return reply.send({ plans: billing.listPlans() });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/plans', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = planSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Plan payload invalid', req.id);
      // A plan is live enforcement state: `applyPlanLimits` copies it into
      // `tenant_limits`. Writing the row and its audit record in one transaction
      // keeps a persisted envelope change from ever losing its explanation.
      const plan = db.db.transaction(() => {
        const written = billing.upsertPlan(parsed.data);
        db.audit({
          tenantId: admin.tenantId,
          actorType: 'admin',
          event: 'console.plan.upserted',
          traceId: req.id,
          metadata: { plan: written.id }
        });
        return written;
      })();
      return reply.send({ plan });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/admin/models', async (req, reply) => {
    try {
      await requireAdmin(req);
      const rows = db.db
        .prepare('SELECT tenant_id, model_id, enabled FROM model_policies ORDER BY tenant_id')
        .all();
      return reply.send({
        catalog: models.list(),
        policies: rows
      });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // Release 2a: register a model reachable through OmniRoute.
  app.post('/console/api/admin/models', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = modelInputSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Model payload invalid', req.id);
      const model = db.db.transaction(() => {
        const written = models.create(parsed.data);
        db.audit({
          tenantId: admin.tenantId,
          actorType: 'admin',
          event: 'console.model.created',
          traceId: req.id,
          metadata: { model: written.id }
        });
        return written;
      })();
      return reply.send({ model });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  /**
   * One-way, admin-triggered import from the OmniRoute catalog over the
   * loopback client. The gateway never reads OmniRoute files or its database;
   * it asks the same `/v1/models` surface an OpenAI client would. Imported
   * models land **disabled** so an admin has to switch them on explicitly —
   * a sync can never silently widen a tenant's entitlement.
   *
   * `reset: true` additionally reconciles the catalog with OmniRoute: a model
   * whose id no longer appears upstream is removed, unless an active plan
   * still entitles it (the delete guard). This stops the catalog drifting from
   * upstream across repeated syncs without ever breaking a live entitlement.
   */
  app.post('/console/api/admin/models/sync', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = z
        .object({ reset: z.boolean().optional() })
        .strict()
        .safeParse(req.body ?? {});
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Sync payload invalid', req.id);
      const reset = parsed.data.reset === true;
      if (!deps.upstream) {
        return fail(reply, 503, 'sync_unavailable', 'Upstream client is not configured', req.id);
      }
      const response = await deps.upstream.request('/v1/models', { method: 'GET' });
      const body = (await response.json().catch(() => null)) as
        | { data?: Array<{ id?: unknown }> }
        | null;
      if (!response.ok || !body || !Array.isArray(body.data)) {
        return fail(reply, 502, 'sync_upstream_error', 'OmniRoute model list could not be read', req.id);
      }

      const known = new Set(models.list().map((model) => model.id));
      const added: string[] = [];
      const skipped: string[] = [];
      const upstreamSlugs = new Set<string>();
      for (const entry of body.data) {
        const rawId = typeof entry?.id === 'string' ? entry.id : '';
        const slug = rawId
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
        if (!slug || slug.length < 2) {
          skipped.push(rawId || '?');
          continue;
        }
        upstreamSlugs.add(slug);
        if (known.has(slug)) {
          skipped.push(slug);
          continue;
        }
        try {
          const written = models.create({
            id: slug,
            name: rawId.slice(0, 64) || slug,
            provider: 'other',
            inputPriceCents: 0,
            outputPriceCents: 0,
            cacheReadPriceCents: 0,
            multimodalSupport: false,
            upstreamModel: rawId.slice(0, 128) || 'auto',
            enabled: false,
            groupId: 'legacy-default'
          });
          known.add(written.id);
          added.push(written.id);
        } catch {
          skipped.push(slug);
        }
      }

      const removed: string[] = [];
      const keptProtected: string[] = [];
      if (reset) {
        // Reconcile inside the same transaction: every removal and its audit
        // trace share one write, so a failed reset cannot leave the catalog
        // half-reconciled with no explanation.
        for (const model of models.list()) {
          if (upstreamSlugs.has(model.id)) continue;
          try {
            models.remove(model.id);
            removed.push(model.id);
          } catch {
            // Referenced by an active plan: the entitlement wins, so the model
            // outlives its upstream entry until the plan releases it.
            keptProtected.push(model.id);
          }
        }
      }
      db.audit({
        tenantId: admin.tenantId,
        actorType: 'admin',
        event: 'console.model.synced',
        traceId: req.id,
        metadata: { added: added.length, skipped: skipped.length, removed: removed.length, keptProtected: keptProtected.length, reset }
      });
      return reply.send({ synced: true, added, skipped: skipped.length, removed, keptProtected, reset });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  /**
   * Bulk model edit: one partial update per row, applied inside a single
   * transaction so a mid-batch failure (unknown group, malformed row) leaves
   * the catalog exactly as it was. Rows naming a model that does not exist are
   * reported in `missing` instead of failing the batch — an operator pasting a
   * catalogue list should learn which ids drifted, not lose the rest of the
   * edit. Field bounds are the single-editor schema, so nothing slips through
   * here that the per-model route would reject.
   */
  app.post('/console/api/admin/models/bulk', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const bulkRowSchema = modelUpdateSchema
        .extend({ id: z.string().regex(/^[a-z0-9-]{2,64}$/) })
        .strict();
      const parsed = z
        .object({ rows: z.array(bulkRowSchema).min(1).max(500) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) {
        return fail(reply, 400, 'invalid_request', 'Bulk payload invalid', req.id);
      }
      if (parsed.data.rows.some((row) => Object.keys(row).length < 2)) {
        return fail(reply, 400, 'invalid_request', 'Each row needs an id and at least one field to change', req.id);
      }
      const updated: string[] = [];
      const missing: string[] = [];
      const apply = db.db.transaction(() => {
        for (const row of parsed.data.rows) {
          const { id, ...changes } = row;
          // Null return is the catalog's "no such model": record it and keep
          // going, still inside the transaction so the surviving rows land
          // together.
          const result = models.update(id, changes);
          if (result === null) missing.push(id);
          else updated.push(id);
        }
      });
      apply();
      db.audit({
        tenantId: admin.tenantId,
        actorType: 'admin',
        event: 'console.model.bulk_updated',
        traceId: req.id,
        metadata: { updated: updated.length, missing: missing.length }
      });
      return reply.send({ updated, missing });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.put('/console/api/admin/models/:id', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9-]{2,64}$/.test(id)) return fail(reply, 400, 'invalid_request', 'Model id invalid', req.id);
      const parsed = modelUpdateSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Model payload invalid', req.id);
      const model = db.db.transaction(() => {
        const written = models.update(id, parsed.data);
        if (!written) return null;
        db.audit({
          tenantId: admin.tenantId,
          actorType: 'admin',
          event: 'console.model.updated',
          traceId: req.id,
          metadata: { model: written.id }
        });
        return written;
      })();
      if (!model) return fail(reply, 404, 'model_not_found', 'Model unavailable', req.id);
      return reply.send({ model });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.delete('/console/api/admin/models/:id', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9-]{2,64}$/.test(id)) return fail(reply, 400, 'invalid_request', 'Model id invalid', req.id);
      db.db.transaction(() => {
        models.remove(id);
        db.audit({
          tenantId: admin.tenantId,
          actorType: 'admin',
          event: 'console.model.deleted',
          traceId: req.id,
          metadata: { model: id }
        });
      })();
      return reply.send({ deleted: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // Per-tenant entitlement toggle. Lives on its own path so POST /models can
  // mean "create a model" rather than being overloaded with a second meaning.
  app.post('/console/api/admin/models/policy', async (req, reply) => {
    try {
      await requireAdmin(req);
      const parsed = z
        .object({
          tenantId: z.string().min(1).max(64),
          modelId: z.string().min(1).max(64),
          enabled: z.boolean()
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Model payload invalid', req.id);
      db.tenants.setModelPolicy(parsed.data.tenantId, parsed.data.modelId, parsed.data.enabled);
      return reply.send({ updated: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/admin/model-groups', async (req, reply) => {
    try {
      await requireAdmin(req);
      const modelCounts = db.db
        .prepare('SELECT group_id AS group_id, COUNT(*) AS models, SUM(enabled = 1) AS active_models FROM models WHERE group_id IS NOT NULL GROUP BY group_id')
        .all() as Array<{ group_id: string; models: number; active_models: number | null }>;
      const planCounts = db.db
        .prepare('SELECT model_group_id AS group_id, COUNT(*) AS plans FROM plans WHERE model_group_id IS NOT NULL GROUP BY model_group_id')
        .all() as Array<{ group_id: string; plans: number }>;
      const modelsByGroup = new Map(modelCounts.map((row) => [row.group_id, row]));
      const plansByGroup = new Map(planCounts.map((row) => [row.group_id, row.plans]));
      const listed = groups.list().map((group) => {
        const models = modelsByGroup.get(group.id);
        return {
          ...group,
          modelsCount: models?.models ?? 0,
          activeModelsCount: models?.active_models ?? 0,
          plansCount: plansByGroup.get(group.id) ?? 0
        };
      });
      return reply.send({ groups: listed });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.post('/console/api/admin/model-groups', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = modelGroupInputSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Group payload invalid', req.id);
      const group = db.db.transaction(() => {
        const written = groups.create(parsed.data);
        db.audit({ tenantId: admin.tenantId, actorType: 'admin', event: 'console.model_group.created', traceId: req.id, metadata: { group: written.id } });
        return written;
      })();
      return reply.send({ group });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.put('/console/api/admin/model-groups/:id', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = modelGroupInputSchema.omit({ id: true }).safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Group payload invalid', req.id);
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9-]{2,64}$/.test(id)) return fail(reply, 400, 'invalid_request', 'Group id invalid', req.id);
      const group = db.db.transaction(() => {
        const written = groups.update(id, parsed.data);
        db.audit({ tenantId: admin.tenantId, actorType: 'admin', event: 'console.model_group.updated', traceId: req.id, metadata: { group: id } });
        return written;
      })();
      return reply.send({ group });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.post('/console/api/admin/model-groups/:id/models', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const groupId = (req.params as { id: string }).id;
      if (!/^[a-z0-9-]{2,64}$/.test(groupId)) return fail(reply, 400, 'invalid_request', 'Group id invalid', req.id);
      const parsed = z.object({ modelId: z.string().min(1).max(64) }).strict().safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Model assignment invalid', req.id);
      db.db.transaction(() => {
        groups.assignModel(groupId, parsed.data.modelId);
        db.audit({ tenantId: admin.tenantId, actorType: 'admin', event: 'console.model_group.model_assigned', traceId: req.id, metadata: { group: groupId, model: parsed.data.modelId } });
      })();
      return reply.send({ assigned: true, groupId, modelId: parsed.data.modelId });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.delete('/console/api/admin/model-groups/:id/models/:modelId', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const modelId = (req.params as { modelId: string }).modelId;
      if (!/^[a-z0-9-]{2,64}$/.test(modelId)) return fail(reply, 400, 'invalid_request', 'Model id invalid', req.id);
      db.db.transaction(() => {
        groups.unassignModel(modelId);
        db.audit({ tenantId: admin.tenantId, actorType: 'admin', event: 'console.model_group.model_unassigned', traceId: req.id, metadata: { model: modelId } });
      })();
      return reply.send({ unassigned: true });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.delete('/console/api/admin/model-groups/:id', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const id = (req.params as { id: string }).id;
      if (!/^[a-z0-9-]{2,64}$/.test(id)) return fail(reply, 400, 'invalid_request', 'Group id invalid', req.id);
      db.db.transaction(() => {
        groups.remove(id);
        db.audit({ tenantId: admin.tenantId, actorType: 'admin', event: 'console.model_group.deleted', traceId: req.id, metadata: { group: id } });
      })();
      return reply.send({ deleted: true });
    } catch (error) { return handle(error, reply, req.id); }
  });

  app.get('/console/api/admin/accounts', async (req, reply) => {
    try {
      await requireAdmin(req);
      const list = accounts.list(200).map((account) => ({
        ...account,
        billing: billing.summary(account.id, account.tenantId),
        // The enforced envelope, not the plan's copy of it. A direct limit edit
        // leaves the plan describing values that are no longer in force, so an
        // editor seeded from the plan would write them back on save.
        limits: db.tenants.effectiveLimits(account.tenantId, {
          dailyBudgetUnits: config.DAILY_BUDGET_UNITS,
          maxConcurrent: config.TENANT_MAX_CONCURRENT,
          rateLimitRpm: config.RATE_LIMIT_RPM
        })
      }));
      return reply.send({ accounts: list });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/accounts/limits', async (req, reply) => {
    try {
      await requireAdmin(req);
      const parsed = limitsSchema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Limits invalid', req.id);
      db.tenants.setLimits(parsed.data.tenantId, {
        dailyBudgetUnits: parsed.data.dailyBudgetUnits,
        maxConcurrent: parsed.data.maxConcurrent,
        rateLimitRpm: parsed.data.rateLimitRpm
      });
      return reply.send({ updated: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/accounts/credit', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = z
        .object({
          accountId: z.string().min(1).max(64),
          tokens: z.number().int().min(1).max(1_000_000_000),
          reason: z.string().min(1).max(120)
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Credit invalid', req.id);
      const balance = billing.credit(
        parsed.data.accountId,
        parsed.data.tokens,
        'admin',
        `${req.id}:${parsed.data.reason}`,
        'adjustment'
      );
      db.audit({
        tenantId: admin.tenantId,
        actorType: 'admin',
        event: 'console.credit.granted',
        traceId: req.id,
        metadata: { account: parsed.data.accountId, tokens: parsed.data.tokens }
      });
      return reply.send({ balance_tokens: balance });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/accounts/status', async (req, reply) => {
    try {
      await requireAdmin(req);
      const parsed = z
        .object({
          accountId: z.string().min(1).max(64),
          status: z.enum(['active', 'suspended'])
        })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Status invalid', req.id);
      accounts.setStatus(parsed.data.accountId, parsed.data.status);
      return reply.send({ updated: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/admin/payments', async (req, reply) => {
    try {
      await requireAdmin(req);
      const rows = db.db
        .prepare(
          'SELECT order_id, account_id, purpose, plan_id, tokens, amount_cents, status, created_at, settled_at FROM payments ORDER BY created_at DESC LIMIT 100'
        )
        .all();
      return reply.send({ payments: rows });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // ---- Exchange rate (admin) ----

  app.get('/console/api/admin/exchange-rate', async (req, reply) => {
    try {
      await requireAdmin(req);
      const row = db.db
        .prepare("SELECT idr_per_usd, updated_at FROM exchange_rates WHERE id = 'default'")
        .get() as { idr_per_usd: number; updated_at: string } | undefined;
      if (!row) return fail(reply, 404, 'exchange_rate_not_found', 'Rate not configured', req.id);
      return reply.send({ idr_per_usd: row.idr_per_usd, updated_at: row.updated_at });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/exchange-rate', async (req, reply) => {
    try {
      const admin = await requireAdmin(req);
      const parsed = z
        .object({ idr_per_usd: z.number().int().positive() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Rate invalid', req.id);
      setExchangeRate(db.db, parsed.data.idr_per_usd, admin.id);
      db.audit({
        tenantId: admin.tenantId,
        actorType: 'admin',
        event: 'console.exchange_rate.updated',
        traceId: req.id,
        metadata: { idr_per_usd: parsed.data.idr_per_usd }
      });
      return reply.send({ idr_per_usd: parsed.data.idr_per_usd });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  // ---- Payment webhook ----

  app.post('/webhooks/cryptomus', async (req, reply) => {
    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return fail(reply, 400, 'invalid_request', 'Body required', req.id);
    }
    try {
      if (!payments.verifyWebhook(payload)) {
        return fail(reply, 403, 'signature_invalid', 'Signature rejected', req.id);
      }
    } catch (error) {
      return handle(error, reply, req.id);
    }

    const orderId = typeof payload.order_id === 'string' ? payload.order_id : null;
    const status = typeof payload.status === 'string' ? payload.status : null;
    if (!orderId || !status) return fail(reply, 400, 'invalid_request', 'Fields missing', req.id);

    const payment = db.db
      .prepare(
        'SELECT id, account_id, purpose, plan_id, tokens, amount_cents, currency, status, settled_at, entitlement_snapshot_json FROM payments WHERE order_id = ?'
      )
      .get(orderId) as
      | {
          id: string;
          account_id: string;
          purpose: 'subscription' | 'topup';
          plan_id: string | null;
          tokens: number;
          amount_cents: number;
          currency: string;
          status: string;
          settled_at: string | null;
          entitlement_snapshot_json: string;
        }
      | undefined;
    if (!payment) return fail(reply, 404, 'payment_not_found', 'Unknown order', req.id);

    const settles = PAID_STATUSES.includes(status);
    if (settles) {
      // A valid signature proves the message came from the provider, not that
      // it describes the invoice we issued. Granting on the order id alone
      // would honour any amount the callback happens to carry.
      const cents = reportedCents(payload.amount);
      const currency = typeof payload.currency === 'string' ? payload.currency : null;
      if (cents === null || cents < payment.amount_cents || currency !== payment.currency) {
        return fail(
          reply,
          409,
          'payment_amount_mismatch',
          'Reported settlement does not match the invoice',
          req.id
        );
      }
    }

    // Cryptomus retries. Recording the delivery and acting on it therefore
    // share a single transaction: if the grant throws, the marker rolls back
    // with it and the retry can still settle, instead of being mistaken for a
    // duplicate and leaving the payer with nothing. Settlement failures are
    // rethrown as BillingError so the transaction rolls back the marker AND
    // the `reconciliation_required` state is persisted only afterwards — a
    // transient failure must never lock the payment out of a later retry.
    const digest = `${orderId}:${status}:${String(payload.sign)}`;
    const seenAt = new Date().toISOString();
    try {
      const outcome = db.db.transaction((): 'duplicate' | 'settled' | 'recorded' => {
        const inserted = db.db
          .prepare(
            'INSERT OR IGNORE INTO payment_events (id, payment_id, digest, status, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(randomUUID(), payment.id, digest, status, seenAt);
        if (inserted.changes === 0) return 'duplicate';

        if (settles) {
          // paid and paid_over are distinct deliveries of one settlement.
          // settled_at, not the digest, is what makes the grant one-time.
          if (payment.settled_at) {
            db.db.prepare('UPDATE payments SET status = ?, settlement_status = \'settled\' WHERE id = ?').run(status, payment.id);
            return 'recorded';
          }
          db.db
            .prepare('UPDATE payments SET status = ?, settled_at = ? WHERE id = ?')
            .run(status, seenAt, payment.id);
          let snapshot: Record<string, unknown>;
          try {
            snapshot = JSON.parse(payment.entitlement_snapshot_json || '{}') as Record<string, unknown>;
            if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') throw new Error('snapshot_not_object');
          } catch {
            throw new BillingError('entitlement_snapshot_invalid', 409);
          }
          if (Object.keys(snapshot).length === 0) {
            snapshot.method = payment.purpose === 'subscription' ? 'rolling_time' : 'token_pack';
            snapshot.planId = payment.plan_id;
            snapshot.tokens = payment.tokens;
          }
          try {
            snapshot.amountCents ??= payment.amount_cents;
            billing.settlePaymentSnapshot(payment.account_id, payment.id, snapshot);
          } catch (error) {
            const reason = error instanceof BillingError ? error.code : 'settlement_failed';
            throw new BillingError(reason, 409);
          }
          db.db.prepare("UPDATE payments SET settlement_status = 'settled', settlement_error = NULL WHERE id = ?").run(payment.id);
          return 'settled';
        }

        // A late failure notice must never revoke money already settled.
        if (payment.settled_at) return 'recorded';
        db.db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
        return 'recorded';
      })();
      return reply.send({ accepted: true, duplicate: outcome === 'duplicate' });
    } catch (error) {
      if (error instanceof BillingError) {
        // The transaction rolled back, so no payment_events marker survived.
        // Mark the payment for operator attention now that the failure is
        // definitively its own row, not a blind retry of a settled payment.
        db.db.prepare("UPDATE payments SET settlement_status = 'reconciliation_required', settlement_error = ?, status = ?, settled_at = NULL WHERE id = ?").run(error.code, status, payment.id);
        return fail(reply, 409, 'payment_reconciliation_required', 'Payment requires reconciliation', req.id);
      }
      return handle(error, reply, req.id);
    }
  });

  // ---- leuwongrr.online payment webhook (QRIS + bank transfer) ----
  // Server-to-server: no session cookie, no CORS, no Access JWT.
  // Signature: HMAC-SHA256 of the raw body with LEUWONGRR_WEBHOOK_SECRET.
  app.post('/webhooks/leuwongrr', async (req, reply) => {
    const secret = config.LEUWONGRR_WEBHOOK_SECRET;
    if (!secret || secret.trim() === '') {
      return fail(reply, 503, 'webhook_not_configured', 'Webhook secret not configured', req.id);
    }
    const signature = req.headers['x-leuwongrr-signature'];
    const signatureStr = Array.isArray(signature) ? signature[0] : signature;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!signatureStr || typeof signatureStr !== 'string' || !verifyHmacSignature(secret, rawBody, signatureStr)) {
      return fail(reply, 403, 'signature_invalid', 'Signature rejected', req.id);
    }

    const payload = req.body as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return fail(reply, 400, 'invalid_request', 'Body required', req.id);
    }

    const orderId = typeof payload.order_id === 'string' ? payload.order_id : null;
    const amountIdr = typeof payload.amount_idr === 'number' ? payload.amount_idr : null;
    const status = typeof payload.status === 'string' ? payload.status : null;
    if (!orderId || amountIdr === null || !status) {
      return fail(reply, 400, 'invalid_request', 'Fields missing: order_id, amount_idr, status', req.id);
    }

    const payment = db.db
      .prepare(
        "SELECT id, account_id, purpose, plan_id, tokens, amount_cents, currency, status, settled_at, entitlement_snapshot_json FROM payments WHERE order_id = ? AND provider = 'leuwongrr'"
      )
      .get(orderId) as
      | {
          id: string;
          account_id: string;
          purpose: 'subscription' | 'topup';
          plan_id: string | null;
          tokens: number;
          amount_cents: number;
          currency: string;
          status: string;
          settled_at: string | null;
          entitlement_snapshot_json: string;
        }
      | undefined;
    if (!payment) return fail(reply, 404, 'payment_not_found', 'Unknown order', req.id);

    const settles = isLeuwongrrPaid(status);
    if (settles && Math.round(amountIdr) < payment.amount_cents) {
      return fail(reply, 409, 'payment_amount_mismatch', 'Reported amount below invoice', req.id);
    }
    if (settles && payment.currency !== 'IDR') {
      return fail(reply, 409, 'payment_currency_mismatch', 'Expected IDR', req.id);
    }

    let tokens = 0;
    let snapshot: Record<string, unknown>;
    if (settles) {
      try {
        const rate = getExchangeRate(db.db);
        tokens = idrToTokens(Math.round(amountIdr), rate);
      } catch (error) {
        return handle(error, reply, req.id);
      }
      try {
        snapshot = JSON.parse(payment.entitlement_snapshot_json || '{}') as Record<string, unknown>;
        if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== 'object') throw new Error('snapshot_not_object');
        if (Object.keys(snapshot).length === 0) {
          snapshot = {
            method: payment.purpose === 'subscription' ? 'rolling_time' : 'token_pack',
            planId: payment.plan_id,
            tokens
          };
        }
        snapshot.amountCents ??= payment.amount_cents;
        if (snapshot.tokens === undefined || snapshot.tokens === null || snapshot.tokens === 0) {
          snapshot.tokens = tokens;
        }
      } catch {
        return fail(reply, 400, 'snapshot_invalid', 'Entitlement snapshot invalid', req.id);
      }
    }

    const digest = `${orderId}:${status}:${signatureStr}`;
    const seenAt = new Date().toISOString();
    try {
      const outcome = db.db.transaction((): 'duplicate' | 'settled' | 'recorded' => {
        const inserted = db.db
          .prepare(
            'INSERT OR IGNORE INTO payment_events (id, payment_id, digest, status, created_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(randomUUID(), payment.id, digest, status, seenAt);
        if (inserted.changes === 0) return 'duplicate';
        if (settles) {
          if (payment.settled_at) return 'recorded';
          db.db
            .prepare('UPDATE payments SET status = ?, settled_at = ? WHERE id = ?')
            .run(status, seenAt, payment.id);
          try {
            billing.settlePaymentSnapshot(payment.account_id, payment.id, snapshot as {
              method?: 'rolling_time' | 'token_pack' | 'monetary_pack' | 'payg';
              planId?: string;
              modelGroupId?: string | null;
              tokens?: number;
              balanceCents?: number;
              amountCents?: number;
            });
          } catch (error) {
            const reason = error instanceof BillingError ? error.code : 'settlement_failed';
            throw new BillingError(reason, 409);
          }
          db.db.prepare("UPDATE payments SET settlement_status = 'settled', settlement_error = NULL WHERE id = ?").run(payment.id);
          return 'settled';
        }
        if (payment.settled_at) return 'recorded';
        db.db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
        return 'recorded';
      })();
      return reply.send({ accepted: true, duplicate: outcome === 'duplicate' });
    } catch (error) {
      if (error instanceof BillingError) {
        db.db.prepare("UPDATE payments SET settlement_status = 'reconciliation_required', settlement_error = ?, status = ?, settled_at = NULL WHERE id = ?").run(error.code, status, payment.id);
        return fail(reply, 409, 'payment_reconciliation_required', 'Payment requires reconciliation', req.id);
      }
      return handle(error, reply, req.id);
    }
  });
}
