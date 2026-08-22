import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { ThemeSelect, applyStoredTheme, setTheme, storedTheme, THEME_STORAGE } from './theme';

/**
 * The theme system is three moving parts that must agree: the closed preset
 * set, the <html data-theme> attribute the CSS presets key off, and the
 * localStorage value that carries the choice across pages. These tests pin
 * that contract, including that an unknown stored value falls back to the
 * default instead of silently styling nothing.
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

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  it('stores a choice and applies it to <html>', () => {
    setTheme('midnight');
    expect(localStorage.getItem(THEME_STORAGE)).toBe('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(storedTheme()).toBe('midnight');
  });

  it('the default theme clears the attribute rather than setting an alias', () => {
    setTheme('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
    // Choosing the default again removes the override entirely.
    setTheme('adwait');
    expect(localStorage.getItem(THEME_STORAGE)).toBe('adwait');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(applyStoredTheme()).toBe('adwait');
  });

  it('falls back to the default for an unknown stored value', () => {
    localStorage.setItem(THEME_STORAGE, 'hackerman');
    expect(storedTheme()).toBe('adwait');
    expect(applyStoredTheme()).toBe('adwait');
  });

  it('ignores ids outside the closed preset set', () => {
    setTheme('daylight');
    setTheme('not-a-theme');
    expect(localStorage.getItem(THEME_STORAGE)).toBe('daylight');
  });

  it('the picker reflects and changes the active theme', async () => {
    localStorage.setItem(THEME_STORAGE, 'rose');
    render(<ThemeSelect />);
    const picker = screen.getByRole('combobox', { name: 'Theme' }) as HTMLSelectElement;
    expect(picker.value).toBe('rose');
    await userEvent.setup().selectOptions(picker, 'daylight');
    expect(localStorage.getItem(THEME_STORAGE)).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
  });
});
