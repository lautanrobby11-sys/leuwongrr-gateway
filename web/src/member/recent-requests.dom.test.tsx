import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import type { UsageRecent } from '../lib/api';
import { RecentRequests } from './main';

/**
 * The recent-request ledger is where the member reads what each call cost and
 * which client made it, so its rendering is a contract:
 *
 * - a missing token split or unknown model price renders a dash, never a
 *   fabricated zero that would read as "free";
 * - the detected app label maps to a friendly name;
 * - clicking a column header re-sorts, and the default order is newest first.
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

function row(overrides: Partial<UsageRecent>): UsageRecent {
  return {
    requestId: 'req-1',
    at: '2026-08-16T10:00:00.000Z',
    model: 'lwrr-text',
    units: 100,
    inputTokens: 60,
    outputTokens: 40,
    cachedTokens: null,
    thinkingTokens: null,
    durationMs: 1000,
    finishReason: 'stop',
    appLabel: 'zcode',
    costCentsEst: 2.5,
    ...overrides
  };
}

describe('RecentRequests', () => {
  it('shows an empty state when there is nothing to render', () => {
    render(<RecentRequests rows={[]} />);
    expect(screen.getByText(/nothing here yet/i)).toBeTruthy();
  });

  it('renders a dash for an unknown cost instead of a zero', () => {
    render(<RecentRequests rows={[row({ costCentsEst: null, appLabel: 'curl' })]} />);
    const cells = screen.getAllByRole('cell');
    const text = cells.map((cell) => cell.textContent).join(' | ');
    expect(text).toContain('—');
    // A known sub-cent cost still renders as precise currency, not $0.00.
    cleanup();
    render(<RecentRequests rows={[row({ costCentsEst: 0.5 })]} />);
    expect(screen.getByText('$0.005')).toBeTruthy();
  });

  it('maps the detected app label to a friendly name', () => {
    render(<RecentRequests rows={[row({ appLabel: 'zcode' })]} />);
    expect(screen.getByText('ZCode')).toBeTruthy();
  });

  it('sorts by the clicked column header', async () => {
    const rows = [
      row({ requestId: 'a', at: '2026-08-16T09:00:00.000Z', units: 10, model: 'model-a' }),
      row({ requestId: 'b', at: '2026-08-16T11:00:00.000Z', units: 900, model: 'model-b' })
    ];
    render(<RecentRequests rows={rows} />);
    // Default sort is newest first, so the later timestamp (model-b) leads.
    let bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(bodyRows[0]!).getByText('model-b')).toBeTruthy();
    // Sorting by Tokens ascending puts the small count first.
    await userEvent.click(screen.getByRole('button', { name: /sort by tokens/i }));
    await userEvent.click(screen.getByRole('button', { name: /sort by tokens/i }));
    bodyRows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(bodyRows[0]!).getByText('model-a')).toBeTruthy();
  });
});
