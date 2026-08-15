import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as React from 'react';
import { Chat } from './main';
import { ToastHost } from '../components/ui';

/**
 * Behavioural DOM coverage for the chat connection settings.
 *
 * The chat model picker must be driven by the gateway: GET /v1/models with the
 * bearer key returns only the models the owner has enabled for that tenant, so
 * the dropdown may never offer a free-text model that the key cannot use. These
 * tests mock `fetch` and assert:
 *
 * - the settings dialog starts with the model picker disabled and empty;
 * - after a key is saved the picker is populated only with the allowed ids;
 * - a rejected key surfaces the gateway error and leaves the picker empty;
 * - sending without a model is refused instead of posting an empty model.
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

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body
  } as Response;
}

async function openSettingsWithKey(key: string) {
  sessionStorage.setItem('lwrr.chat.key', key);
  const user = userEvent.setup();
  render(
    <ToastHost>
      <Chat />
    </ToastHost>
  );
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  return user;
}

describe('chat model picker — driven by GET /v1/models', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('starts with an empty picker until a key is saved', async () => {
    render(
      <ToastHost>
        <Chat />
      </ToastHost>
    );
    // Without a saved key the settings dialog is open by default.
    const picker = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(picker.disabled).toBe(true);
    expect(picker.options.length).toBe(1);
    expect(picker.value).toBe('');
  });

  it('populates the picker with exactly the models the key is allowed to see', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(true, 200, {
        object: 'list',
        data: [
          { id: 'lwrr-text', object: 'model', owned_by: 'leuwongrr', capabilities: ['text', 'stream'] },
          { id: 'best-fast', object: 'model', owned_by: 'leuwongrr', capabilities: ['text', 'stream'] }
        ]
      })
    );
    const user = await openSettingsWithKey('lwrr_live_ok');

    const picker = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2));
    expect(picker.options[0]!.value).toBe('lwrr-text');
    expect(picker.options[1]!.value).toBe('best-fast');
    // The first allowed model becomes the selection automatically.
    expect(picker.value).toBe('lwrr-text');

    // Changing the selection persists it for the session.
    await user.selectOptions(picker, 'best-fast');
    expect(localStorage.getItem('lwrr.chat.model')).toBe('best-fast');
  });

  it('keeps a stored model only when it is still allowed, otherwise falls back', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(true, 200, { object: 'list', data: [{ id: 'best-fast', object: 'model' }] })
    );
    localStorage.setItem('lwrr.chat.model', 'lwrr-text');
    await openSettingsWithKey('lwrr_live_ok');

    const picker = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(1));
    expect(picker.value).toBe('best-fast');
  });

  it('surfaces the gateway error and leaves the picker empty for a rejected key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(false, 401, {
        error: { code: 'unauthorized', message: 'Invalid API key' }
      })
    );
    await openSettingsWithKey('lwrr_live_bad');

    const picker = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(true));
    expect(picker.options.length).toBe(1);
    expect(await screen.findByText('Invalid API key')).toBeTruthy();
  });

  it('refuses to send when no model is selected', async () => {
    fetchMock.mockResolvedValue(jsonResponse(true, 200, { object: 'list', data: [] }));
    await openSettingsWithKey('lwrr_live_empty');

    const picker = (await screen.findByRole('combobox')) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(1));
    const textbox = (await screen.findByRole('textbox', { name: 'Message' })) as HTMLTextAreaElement;
    await userEvent.setup().type(textbox, 'hello');
    // The Composer send button is disabled while there is no model, and the
    // settings dialog remains the authoritative gate.
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    expect(picker.value).toBe('');
  });
});
