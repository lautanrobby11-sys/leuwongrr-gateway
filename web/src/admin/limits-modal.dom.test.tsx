import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { Admin } from './main';
import { ToastHost } from '../components/ui';
import { DAILY_BUDGET_UNITS, MAX_CONCURRENT, RATE_LIMIT_RPM } from './limits-validation';

/**
 * Behavioural DOM coverage for the tenant limits modal (issue #51).
 *
 * tests/admin-limits-form-wiring.test.ts can only read the source of main.tsx.
 * It cannot prove that a cleared box leaves Save disabled, that a box shows an
 * empty string rather than the word NaN, or that a typed zero stays valid. Those
 * are runtime facts, so they are asserted here against the rendered modal.
 */

// motion animates through effects that happy-dom does not need to run; a
// pass-through keeps the real DOM (role, aria-label, children) while dropping
// the animation-only props so React does not warn about unknown attributes.
vi.mock('motion/react', async () => {
  const react = await import('react');
  const OMIT = new Set([
    'initial', 'animate', 'exit', 'transition',
    'whileHover', 'whileTap', 'whileFocus', 'whileInView', 'layout', 'layoutId', 'variants', 'drag'
  ]);
  const create = (tag: string) =>
    function MotionMock(props: Record<string, unknown>) {
      const clean: Record<string, unknown> = {};
      for (const key of Object.keys(props)) if (!OMIT.has(key)) clean[key] = props[key];
      return react.createElement(tag, clean as unknown as React.HTMLAttributes<HTMLElement>);
    };
  const cache = new Map<string, ReturnType<typeof create>>();
  const motion = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      const tag = typeof prop === 'string' ? prop : 'div';
      let component = cache.get(tag);
      if (!component) {
        component = create(tag);
        cache.set(tag, component);
      }
      return component;
    }
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
    useReducedMotion: () => false
  };
});

// The modal only opens from a loaded Accounts tab, so the admin data layer is
// mocked with one account whose stored limits are in range.
vi.mock('../lib/api', () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.status = status;
    }
  }
  const account = {
    id: 'acc-1',
    email: 'operator@example.com',
    displayName: 'Operator',
    role: 'admin',
    status: 'active',
    tenantId: 'tenant-smoke',
    billing: { plan: { name: 'Starter' }, totalAvailable: 100_000, usageToday: 0 },
    limits: { dailyBudgetUnits: 100_000, maxConcurrent: 2, rateLimitRpm: 120, stored: true }
  };
  const api = {
    admin: {
      overview: () =>
        Promise.resolve({
          totals: { accounts: 1, active_subscriptions: 1, wallet_tokens: 100_000, units_today: 0 },
          revenue_cents: 0
        }),
      plans: () => Promise.resolve({ plans: [] }),
      models: () => Promise.resolve({ catalog: [], policies: [] }),
      accounts: () => Promise.resolve({ accounts: [account] }),
      payments: () => Promise.resolve({ payments: [] }),
      setLimits: () => Promise.resolve({ ok: true })
    }
  };
  return { api, ApiError };
});

async function openLimitsModal() {
  const user = userEvent.setup();
  render(
    <ToastHost>
      <Admin />
    </ToastHost>
  );
  const accountsNav = await screen.findAllByRole('button', { name: 'Accounts' });
  await user.click(accountsNav[0]!);
  await user.click(await screen.findByRole('button', { name: 'Limits' }));
  const dialog = await screen.findByRole('dialog', { name: 'Tenant limits' });
  const save = within(dialog).getByRole('button', { name: 'Save limits' }) as HTMLButtonElement;
  const inputs = within(dialog).getAllByRole('spinbutton') as HTMLInputElement[];
  return { user, save, inputs };
}

describe('admin limits modal — behavioural DOM coverage', () => {
  afterEach(cleanup);

  it('enables Save for the seeded in-range values', async () => {
    const { save } = await openLimitsModal();
    expect(save.disabled).toBe(false);
  });

  it('disables Save when each field is cleared, one at a time', async () => {
    const { user, save, inputs } = await openLimitsModal();
    for (const input of inputs) {
      const restore = input.value;
      await user.clear(input);
      expect(save.disabled).toBe(true);
      await user.type(input, restore);
      expect(save.disabled).toBe(false);
    }
  });

  it('shows an empty box, not the word NaN, when a field is cleared', async () => {
    const { user, inputs } = await openLimitsModal();
    const daily = inputs[0]!;
    await user.clear(daily);
    expect(daily.value).toBe('');
    expect(daily.value).not.toBe('NaN');
  });

  it('enables Save at exactly the minimum of every field', async () => {
    const { user, save, inputs } = await openLimitsModal();
    const mins = [DAILY_BUDGET_UNITS.min, MAX_CONCURRENT.min, RATE_LIMIT_RPM.min];
    for (let i = 0; i < inputs.length; i += 1) {
      await user.clear(inputs[i]!);
      await user.type(inputs[i]!, String(mins[i]));
    }
    expect(save.disabled).toBe(false);
  });

  it('disables Save one past the maximum of every field', async () => {
    const { user, save, inputs } = await openLimitsModal();
    const maxes = [DAILY_BUDGET_UNITS.max, MAX_CONCURRENT.max, RATE_LIMIT_RPM.max];
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i]!;
      await user.clear(input);
      await user.type(input, String(maxes[i]! + 1));
      expect(save.disabled).toBe(true);
      await user.clear(input);
      await user.type(input, String(maxes[i]));
      expect(save.disabled).toBe(false);
    }
  });

  it('keeps a typed zero on daily budget as a valid, Save-enabled value', async () => {
    const { user, save, inputs } = await openLimitsModal();
    const daily = inputs[0]!;
    await user.clear(daily);
    await user.type(daily, '0');
    expect(daily.value).toBe('0');
    expect(save.disabled).toBe(false);
  });
});
