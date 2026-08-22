import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type * as React from 'react';
import type { Plan } from '../lib/api';
import { ModelsTab } from './main';

/**
 * The member Models view is what a subscriber reads before pointing an SDK at
 * the gateway, so its rendering is a contract:
 *
 * - one row per (plan, model) pair, priced at the plan's effective rate rather
 *   than the raw catalog price the member never pays;
 * - only the active subscription's plan reads as included, because that is the
 *   group the entitlement check resolves for their keys;
 * - an empty catalogue says so instead of rendering a bare table.
 */
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

afterEach(cleanup);

function plan(overrides: Partial<Plan>): Plan {
  return {
    id: 'starter',
    name: 'Starter',
    monthlyPriceCents: 500,
    includedTokens: 1_000_000,
    overageCentsPerMillion: 200,
    maxConcurrent: 2,
    rateLimitRpm: 120,
    dailyBudgetUnits: 100_000,
    models: [],
    active: true,
    ...overrides
  };
}

const textModel = {
  id: 'lwrr-text',
  name: 'Lightweight text',
  provider: 'openai',
  multimodalSupport: false,
  inputPriceCents: 100,
  outputPriceCents: 200,
  cacheReadPriceCents: 50,
  effectiveInputPriceCents: 125,
  effectiveOutputPriceCents: 250,
  effectiveCacheReadPriceCents: 62.5
};

describe('member models tab', () => {
  it('prices each row at the plan effective rate and marks only the active plan', () => {
    render(
      <ModelsTab
        plans={[
          plan({ id: 'starter', name: 'Starter', eligibleModels: [textModel] }),
          plan({ id: 'pro', name: 'Pro', eligibleModels: [textModel] })
        ]}
        activePlanId="pro"
        onOpenChat={() => {}}
        onBrowsePlans={() => {}}
      />
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);

    // The effective input price, not the raw 100 cents the member never pays.
    expect(within(rows[0]!).getByText('$1.25')).toBeTruthy();
    expect(within(rows[0]!).getByText('Not active')).toBeTruthy();
    expect(within(rows[1]!).getByText('Included now')).toBeTruthy();
  });

  it('offers chat when a listed plan is active and plans otherwise', () => {
    const { unmount } = render(
      <ModelsTab
        plans={[plan({ eligibleModels: [textModel] })]}
        activePlanId="starter"
        onOpenChat={() => {}}
        onBrowsePlans={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: /Open chat/ })).toBeTruthy();
    unmount();

    render(
      <ModelsTab
        plans={[plan({ eligibleModels: [textModel] })]}
        activePlanId={null}
        onOpenChat={() => {}}
        onBrowsePlans={() => {}}
      />
    );
    expect(screen.getByRole('button', { name: /Browse plans/ })).toBeTruthy();
  });

  it('says the catalogue is empty rather than rendering a bare table', () => {
    render(
      <ModelsTab
        plans={[plan({ eligibleModels: [] })]}
        activePlanId={null}
        onOpenChat={() => {}}
        onBrowsePlans={() => {}}
      />
    );
    expect(screen.getByText(/No models are offered right now/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
