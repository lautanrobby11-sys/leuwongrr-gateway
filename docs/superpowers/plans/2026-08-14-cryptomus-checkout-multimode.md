# Cryptomus Checkout and Multimode Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make Cryptomus checkout and callback settlement authoritative, idempotent, snapshot-based, and ready to fund rolling-time, token-pack, monetary-pack, and PAYG balances without treating checkout as an unverified raw order.

**Architecture:** The member checkout creates an immutable internal payment order containing the exact entitlement and price snapshot. Cryptomus is only an external payment transport. The callback verifies the provider signature, resolves the internal order, validates amount/currency/status, and settles exactly once inside a database transaction. Billing settlement consumes the payment snapshot and writes the correct token/cents/subscription ledger entries; it never recomputes entitlement from a mutable plan.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Zod, Vitest, Cryptomus HTTP API.

## Global Constraints

- All project-facing API errors, types, tests, OpenAPI, migration comments, and documentation remain in English.
- Do not read or modify OmniRoute files, databases, configs, or secrets.
- Provider secrets remain runtime-only and never enter repository, database, logs, or responses.
- Payment payloads and provider responses are sanitized; no raw credentials, prompts, or responses are stored.
- Business queries include `tenant_id` where applicable.
- Checkout and webhook writes are transactional and idempotent.
- No negative subscription or wallet balances.
- Failed settlement becomes an auditable reconciliation state; it is never silently retried or granted twice.
- Run focused tests after every task and `npm run validate` before claiming completion.

---

### Task 1: Payment order snapshot schema

**Files:**
- Modify: `src/persistence/migrations.ts` (new forward-only payment settlement columns)
- Test: `tests/payment-order-migration.test.ts`

**Interfaces:**
- Payment rows expose immutable `entitlement_snapshot_json`, `balance_cents`, `token_amount`, `settlement_status`, and `settlement_error`.
- Existing payment rows remain readable with safe defaults.

- [ ] **Step 1: Write failing migration tests**

Cover that a payment order can persist:

```ts
expect(columns).toEqual(expect.arrayContaining([
  'entitlement_snapshot_json', 'balance_cents', 'token_amount',
  'settlement_status', 'settlement_error'
]));
expect(() => db.db.prepare("INSERT INTO payments (...)").run(...)).not.toThrow();
```

Also assert settlement status is limited to `pending`, `settled`, `failed`, and `reconciliation_required`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run tests/payment-order-migration.test.ts`

Expected: FAIL because the columns and status constraint do not exist.

- [ ] **Step 3: Add migration `0012_payment_order_snapshot`**

Use a forward-only SQLite table rebuild only where required. Preserve existing columns and rows. Backfill `token_amount` from `tokens`, `balance_cents` to `0`, `entitlement_snapshot_json` to `'{}'`, and `settlement_status` from `status` (`paid`/`paid_over` → `settled`, others → `pending`). Do not store provider payloads.

- [ ] **Step 4: Run migration tests**

Run: `npx vitest run tests/payment-order-migration.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/migrations.ts tests/payment-order-migration.test.ts
git commit -m "feat: snapshot payment settlement state"
```

---

### Task 2: Cryptomus checkout snapshot and idempotent callback

**Files:**
- Modify: `src/http/console.ts:574-635,638-692,1076-1175`
- Modify: `src/payments/cryptomus.ts`
- Test: `tests/payment-checkout.test.ts`
- Test: `tests/payment-webhook.test.ts`
- Modify: `docs/api/openapi.yaml`

**Interfaces:**
- `openInvoice(input)` writes the exact plan/mode/token/cents snapshot before or atomically with the external invoice registration.
- `settleCryptomusPayment(payload)` validates and settles one internal order exactly once.
- Repeated valid callbacks return success without a second grant.

- [ ] **Step 1: Add failing checkout tests**

Assert that subscription and top-up checkout rows contain the selected plan group/method, exact amount/currency, token/cents entitlement, and no provider response blob. Assert that an unconfigured Cryptomus client returns `503 payments_not_configured` and does not create a paid row.

- [ ] **Step 2: Add failing callback tests**

Extend existing webhook tests to assert:

- unknown order is rejected;
- amount below the invoice is rejected;
- wrong currency is rejected;
- `paid` settles once;
- repeated `paid` callback does not duplicate grant;
- `paid_over` settles once;
- `cancel`/`fail` never grants;
- grant failure records `reconciliation_required` rather than marking the order settled.

- [ ] **Step 3: Run focused tests and verify red**

Run: `npx vitest run tests/payment-checkout.test.ts tests/payment-webhook.test.ts`

Expected: FAIL on missing snapshot/idempotency assertions.

- [ ] **Step 4: Implement snapshot checkout**

Resolve the active plan and its mode/group before creating the invoice. Store a sanitized snapshot containing plan ID, model group ID, method, price, currency, token amount, and monetary amount. Keep `order_id` as the internal source of truth; Cryptomus UUID is only a provider reference. Do not log request bodies or provider responses.

- [ ] **Step 5: Implement transactional callback settlement**

Verify signature first. Load the payment by `order_id`. Validate stored currency and amount against the callback. For non-paid statuses, update only the payment status. For paid statuses, execute one transaction guarded by `settlement_status != 'settled'`; grant from the stored snapshot and record the settlement status. A second callback must observe `settled` and perform no grant.

- [ ] **Step 6: Synchronize OpenAPI and route tests**

Document response status and sanitized payment fields for checkout and callback. Keep allowlist/documented operations synchronized.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/payment-checkout.test.ts tests/payment-webhook.test.ts tests/payment-signature.test.ts tests/openapi-contract.test.ts`

```bash
git add src/http/console.ts src/payments/cryptomus.ts tests/payment-checkout.test.ts tests/payment-webhook.test.ts docs/api/openapi.yaml
git commit -m "feat: harden cryptomus checkout and callbacks"
```

---

### Task 3: Multimode payment grants

**Files:**
- Modify: `src/billing/service.ts`
- Modify: `src/http/console.ts`
- Modify: `src/persistence/migrations.ts`
- Test: `tests/payment-multimode-settlement.test.ts`

**Interfaces:**
- `BillingService.settlePaymentSnapshot(accountId, paymentId, snapshot)` returns a settled grant result.
- Supported grants are `rolling_time`, `token_pack`, `monetary_pack`, and PAYG wallet credit.

- [ ] **Step 1: Write failing multimode settlement tests**

Cover:

```ts
expect(settle('token_pack')).toMatchObject({ tokensGranted: 500_000, centsGranted: 0 });
expect(settle('monetary_pack')).toMatchObject({ tokensGranted: 0, centsGranted: 1000 });
expect(settle('rolling_time').subscription.modelGroupId).toBe('value');
expect(settle('payg')).toMatchObject({ centsGranted: 1000 });
```

Assert shared balances are account/tenant scoped, no balance goes below zero, and retrying the same payment does not add another ledger entry.

- [ ] **Step 2: Run the focused test and verify red**

Run: `npx vitest run tests/payment-multimode-settlement.test.ts`

Expected: FAIL because the settlement method and monetary ledger fields do not exist.

- [ ] **Step 3: Extend billing records and ledger currency**

Add explicit token/cents columns or a currency discriminator to ledger writes. Preserve token ledger compatibility. All grants use immutable payment reference/order ID and a unique constraint for idempotency.

- [ ] **Step 4: Implement `settlePaymentSnapshot`**

For `rolling_time`, call subscription creation with the stored group snapshot. For `token_pack`, credit token balance and equivalent cost metadata. For `monetary_pack` and PAYG, credit cents only. Never convert monetary balance into tokens at checkout. Keep the transaction atomic across payment status, balance, subscription, and ledger writes.

- [ ] **Step 5: Wire callback to billing settlement**

Replace callback-local token/subscription assumptions with the billing service method. On any invariant failure, set `reconciliation_required`, preserve the sanitized failure reason, and return a non-success response that does not invite blind retry of a post-grant operation.

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/payment-multimode-settlement.test.ts tests/billing-settlement.test.ts tests/subscription-engine.test.ts tests/payment-webhook.test.ts`

```bash
git add src/billing/service.ts src/http/console.ts src/persistence/migrations.ts tests/payment-multimode-settlement.test.ts
git commit -m "feat: settle cryptomus payments into shared balances"
```

---

### Task 4: Verification and release evidence

**Files:**
- Modify only if required by failing gates.

- [ ] **Step 1: Inspect diff and secret exposure**

Run `git diff --check`, inspect payment SQL and logs, and confirm no provider credential or raw payload is persisted.

- [ ] **Step 2: Run full validation**

Run: `npm run validate`

Expected: all convention, secret, lint, typecheck, and test gates pass.

- [ ] **Step 3: Run local CI gate**

Run: `npm run ci:local`

Do not deploy. Do not claim production readiness if this gate or any required evidence is missing.

- [ ] **Step 4: Review working tree**

Run `git status --short`; leave only intentional committed changes.
