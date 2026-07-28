import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { GatewayDatabase } from '../persistence/database.js';
import { AccountError, AccountStore, normaliseEmail, type AccountRecord } from '../accounts/store.js';
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
import { PaymentError, PAID_STATUSES, FAILED_STATUSES, type CryptomusClient } from '../payments/cryptomus.js';
import { assertPublicEgress } from '../policy/egress.js';
import { listModels } from '../policy/capabilities.js';
import type { Scope } from '../auth/api-keys.js';

export interface ConsoleDeps {
  config: Config;
  db: GatewayDatabase;
  accounts: AccountStore;
  billing: BillingService;
  payments: CryptomusClient;
  access: AccessVerifier | null;
  logger: Logger;
}

const PAGES: Record<string, string> = {
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
const ISSUABLE_SCOPES: readonly Scope[] = [
  'models:read',
  'chat:write',
  'responses:write',
  'messages:write'
];

function fail(reply: FastifyReply, status: number, code: string, message: string, traceId: string) {
  return reply.code(status).send({ error: { code, message, trace_id: traceId } });
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
const keySchema = z
  .object({
    name: z.string().min(1).max(64),
    scopes: z.array(z.enum(['models:read', 'chat:write', 'responses:write', 'messages:write'])).min(1),
    expiresDays: z.number().int().min(1).max(365).optional()
  })
  .strict();
const planSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{2,32}$/),
    name: z.string().min(1).max(64),
    monthlyPriceCents: z.number().int().min(0).max(10_000_00),
    includedTokens: z.number().int().min(0),
    overageCentsPerMillion: z.number().int().min(0).max(1_000_00),
    maxConcurrent: z.number().int().min(1).max(64),
    rateLimitRpm: z.number().int().min(1).max(100000),
    dailyBudgetUnits: z.number().int().min(0),
    models: z.array(z.string().min(1).max(64)),
    active: z.boolean().optional()
  })
  .strict();
const topupSchema = z
  .object({ planId: z.string().min(1).max(32), amountCents: z.number().int().min(100).max(1_000_000) })
  .strict();
const subscribeSchema = z.object({ planId: z.string().min(1).max(32) }).strict();

/**
 * The console is a separate concern from the LLM data plane: it never proxies
 * to OmniRoute, and it authenticates humans instead of API keys.
 */
export function registerConsole(app: FastifyInstance, deps: ConsoleDeps): void {
  const { config, accounts, billing, payments, db } = deps;
  const distRoot = normalize(config.WEB_DIST_PATH);

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
      error instanceof PaymentError
    ) {
      return fail(reply, error.statusCode, error.code, error.code.replace(/_/g, ' '), traceId);
    }
    deps.logger.error({ err: error, trace_id: traceId }, 'console_request_failed');
    return fail(reply, 500, 'console_error', 'Request could not be completed', traceId);
  }

  // ---- Static shell ----

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
      return fail(reply, 404, 'route_not_found', 'Route is not available', req.id);
    }
    try {
      const body = await readFile(target);
      return reply
        .header('content-type', MIME[extname(target)] ?? 'application/octet-stream')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(body);
    } catch {
      return fail(reply, 404, 'route_not_found', 'Route is not available', req.id);
    }
  });

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
            tenant_id: account.tenantId
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

  app.post('/console/api/auth/request-code', async (req, reply) => {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Email is required', req.id);
    try {
      const code = accounts.issueLoginCode(
        parsed.data.email,
        config.OTP_TTL_MINUTES,
        config.OTP_RESEND_SECONDS
      );
      if (config.OTP_DELIVERY === 'webhook' && config.OTP_WEBHOOK_URL) {
        await fetch(assertPublicEgress(config.OTP_WEBHOOK_URL), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.OTP_WEBHOOK_TOKEN
              ? { authorization: `Bearer ${config.OTP_WEBHOOK_TOKEN}` }
              : {})
          },
          body: JSON.stringify({
            email: normaliseEmail(parsed.data.email),
            code,
            ttl_minutes: config.OTP_TTL_MINUTES
          }),
          signal: AbortSignal.timeout(8000)
        });
        return reply.send({ delivered: true, ttl_minutes: config.OTP_TTL_MINUTES });
      }
      // Development delivery returns the code in the response instead of the
      // log, so a secret never lands in a file an operator might ship.
      return reply.send({ delivered: false, ttl_minutes: config.OTP_TTL_MINUTES, dev_code: code });
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
        account: { email: account.email, display_name: account.displayName, role: account.role },
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
      return reply.send({ days: rows.reverse() });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.get('/console/api/member/plans', async (req, reply) => {
    try {
      requireMember(await currentAccount(req));
      return reply.send({ plans: billing.listPlans(true) });
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
  }) {
    const orderId = `${input.purpose}-${randomUUID()}`;
    const invoice = await payments.createInvoice({
      orderId,
      amountCents: input.amountCents,
      currency: 'USD',
      callbackUrl: new URL('/webhooks/cryptomus', config.PUBLIC_BASE_URL).toString(),
      returnUrl: new URL('/member', config.PUBLIC_BASE_URL).toString()
    });
    db.db
      .prepare(
        `INSERT INTO payments (id, account_id, provider, order_id, invoice_uuid, purpose, plan_id, tokens, amount_cents, currency, status, payment_url, created_at)
         VALUES (?, ?, 'cryptomus', ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`
      )
      .run(
        randomUUID(),
        input.account.id,
        orderId,
        invoice.uuid,
        input.purpose,
        input.planId,
        input.tokens,
        input.amountCents,
        invoice.status,
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
      if (plan.monthlyPriceCents === 0) {
        return reply.send({ subscription: billing.startSubscription(account.id, plan.id) });
      }
      return reply.send(
        await openInvoice({
          account,
          purpose: 'subscription',
          planId: plan.id,
          amountCents: plan.monthlyPriceCents,
          tokens: plan.includedTokens,
          traceId: req.id
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
          traceId: req.id
        })
      );
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
      const plan = billing.upsertPlan(parsed.data);
      db.audit({
        tenantId: admin.tenantId,
        actorType: 'admin',
        event: 'console.plan.upserted',
        traceId: req.id,
        metadata: { plan: plan.id }
      });
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
        catalog: listModels().map((model) => ({
          id: model.publicId,
          capabilities: [...model.capabilities],
          max_output_tokens: model.maxOutputTokens
        })),
        policies: rows
      });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/models', async (req, reply) => {
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

  app.get('/console/api/admin/accounts', async (req, reply) => {
    try {
      await requireAdmin(req);
      const list = accounts.list(200).map((account) => ({
        ...account,
        billing: billing.summary(account.id, account.tenantId)
      }));
      return reply.send({ accounts: list });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });

  app.post('/console/api/admin/accounts/limits', async (req, reply) => {
    try {
      await requireAdmin(req);
      const parsed = z
        .object({
          tenantId: z.string().min(1).max(64),
          dailyBudgetUnits: z.number().int().min(0),
          maxConcurrent: z.number().int().min(1).max(64),
          rateLimitRpm: z.number().int().min(1).max(100000)
        })
        .strict()
        .safeParse(req.body);
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
        'SELECT id, account_id, purpose, plan_id, tokens, status FROM payments WHERE order_id = ?'
      )
      .get(orderId) as
      | {
          id: string;
          account_id: string;
          purpose: 'subscription' | 'topup';
          plan_id: string | null;
          tokens: number;
          status: string;
        }
      | undefined;
    if (!payment) return fail(reply, 404, 'payment_not_found', 'Unknown order', req.id);

    // Cryptomus retries; the digest makes a repeat delivery a no-op instead of
    // a second grant.
    const digest = `${orderId}:${status}:${String(payload.sign)}`;
    const inserted = db.db
      .prepare(
        'INSERT OR IGNORE INTO payment_events (id, payment_id, digest, status, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), payment.id, digest, status, new Date().toISOString());
    if (inserted.changes === 0) return reply.send({ accepted: true, duplicate: true });

    try {
      if (PAID_STATUSES.includes(status)) {
        db.db
          .prepare('UPDATE payments SET status = ?, settled_at = ? WHERE id = ?')
          .run(status, new Date().toISOString(), payment.id);
        if (payment.purpose === 'subscription' && payment.plan_id) {
          billing.startSubscription(payment.account_id, payment.plan_id);
        } else if (payment.tokens > 0) {
          billing.credit(payment.account_id, payment.tokens, 'payment', orderId);
        }
      } else if (FAILED_STATUSES.includes(status)) {
        db.db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
      } else {
        db.db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, payment.id);
      }
      return reply.send({ accepted: true });
    } catch (error) {
      return handle(error, reply, req.id);
    }
  });
}
