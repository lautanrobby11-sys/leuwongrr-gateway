import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { Admin } from './main';
import { ToastHost } from '../components/ui';

/**
 * Behavioural DOM coverage for the model catalog add/edit modal.
 *
 * This guards the two invariants that matter for a release: the modal refuses
 * to submit an empty id/name, and an existing model's identifier is read-only
 * (the backend PUT schema omits `id`, so the input must never look editable).
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

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.status = status;
    }
  }
  const model = {
    id: 'lwrr-text',
    name: 'Lightweight text',
    provider: 'other',
    inputPriceCents: 10,
    outputPriceCents: 20,
    cacheReadPriceCents: 5,
    multimodalSupport: false,
    upstreamModel: 'auto',
    enabled: true,
    groupId: 'legacy-default'
  };
  const api = {
    admin: {
      overview: () =>
        Promise.resolve({
          totals: { accounts: 1, active_subscriptions: 0, wallet_tokens: 0, units_today: 0 },
          revenue_cents: 0
        }),
      plans: () => Promise.resolve({ plans: [] }),
      models: () => Promise.resolve({ catalog: [model], policies: [] }),
      modelGroups: () =>
        Promise.resolve({
          groups: [{ id: 'legacy-default', name: 'Legacy Default', multiplierBps: 10000, enabled: true, modelsCount: 1, activeModelsCount: 1, plansCount: 0 }]
        }),
      accounts: () => Promise.resolve({ accounts: [] }),
      payments: () => Promise.resolve({ payments: [] }),
      createModel: vi.fn(() => Promise.resolve({ model })),
      updateModel: vi.fn(() => Promise.resolve({ model })),
      deleteModel: vi.fn(() => Promise.resolve({ deleted: true })),
      setModelPolicy: () => Promise.resolve({ updated: true })
    }
  };
  return { api, ApiError };
});

async function openAddModel() {
  const user = userEvent.setup();
  render(
    <ToastHost>
      <Admin />
    </ToastHost>
  );
  const modelsNav = await screen.findAllByRole('button', { name: 'Models' });
  await user.click(modelsNav[0]!);
  await user.click(await screen.findByRole('button', { name: 'Add model' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add model' });
  return { user, dialog };
}

describe('admin model catalog add/edit modal — behavioural DOM coverage', () => {
  afterEach(cleanup);

  it('keeps Save disabled until id and name are supplied', async () => {
    const { user, dialog } = await openAddModel();
    const save = within(dialog).getByRole('button', { name: 'Save model' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.type(within(dialog).getByPlaceholderText('lwrr-text'), 'lwrr-other');
    expect(save.disabled).toBe(true);

    await user.type(within(dialog).getByPlaceholderText('Lightweight text'), 'Other model');
    expect(save.disabled).toBe(false);
  });

  it('shows the model id as read-only when editing an existing model', async () => {
    const user = userEvent.setup();
    render(
      <ToastHost>
        <Admin />
      </ToastHost>
    );
    const modelsNav = await screen.findAllByRole('button', { name: 'Models' });
    await user.click(modelsNav[0]!);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit model' });
    const idInput = within(dialog).getByPlaceholderText('lwrr-text') as HTMLInputElement;
    expect(idInput.readOnly).toBe(true);
    expect(idInput.value).toBe('lwrr-text');
  });

  it('lists the uploaded model and lets Save leave it editable on the table', async () => {
    const { user, dialog } = await openAddModel();
    await user.type(within(dialog).getByPlaceholderText('lwrr-text'), 'lwrr-claud');
    await user.type(within(dialog).getByPlaceholderText('Lightweight text'), 'Claude test');
    await user.click(within(dialog).getByRole('button', { name: 'Save model' }));
  });
});
