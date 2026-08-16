import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { CopyButton } from './copy';
import { Skeleton, Table, Tabs } from './ui';

/**
 * Behavioural coverage for the phase-A component additions: sortable tables,
 * segmented tabs, layout skeletons, and the dependency-free copy button that
 * the byte-budgeted portal depends on. Motion is mocked out the same way the
 * chat suite does — these tests assert behaviour, not spring physics.
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

describe('Table sorting', () => {
  it('renders plain headers when no handler is given', () => {
    render(
      <Table headers={['Model', 'Price']}>
        <tr>
          <td>lwrr-text</td>
        </tr>
      </Table>
    );
    expect(screen.queryByRole('button', { name: /sort by/i })).toBeNull();
  });

  it('reports the clicked column and marks the active sort', async () => {
    const onSort = vi.fn();
    render(
      <Table headers={['Model', 'Price']} sort={{ index: 1, dir: 'desc' }} onSort={onSort}>
        <tr>
          <td>lwrr-text</td>
          <td>0.50</td>
        </tr>
      </Table>
    );
    await userEvent.click(screen.getByRole('button', { name: /sort by model/i }));
    expect(onSort).toHaveBeenCalledWith(0);
    // The active column carries the direction indicator.
    expect(screen.getByRole('button', { name: /sort by price/i }).querySelector('svg')).toBeTruthy();
  });
});

describe('Tabs', () => {
  it('switches the selected tab', async () => {
    const onChange = vi.fn();
    render(
      <Tabs
        tabs={[
          { id: 'plans', label: 'Plans' },
          { id: 'packs', label: 'Token packs' }
        ]}
        active="plans"
        onChange={onChange}
      />
    );
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Plans');
    await userEvent.click(screen.getByRole('tab', { name: 'Token packs' }));
    expect(onChange).toHaveBeenCalledWith('packs');
  });
});

describe('Skeleton', () => {
  it('renders an inert placeholder', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    expect(container.querySelector('[aria-hidden]')).toBeTruthy();
  });
});

describe('CopyButton', () => {
  it('copies through the clipboard API and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CopyButton value="lwrr_live_abc" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('lwrr_live_abc');
    expect(screen.getByText('Copied')).toBeTruthy();
  });
});
