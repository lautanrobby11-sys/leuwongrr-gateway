import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setPassword = vi.fn(async (_input: { password: string; confirmPassword: string }) => ({ set: true }));
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { setPassword: (input: { password: string; confirmPassword: string }) => setPassword(input) }
}));

import { SetPasswordBanner } from './set-password-banner';

afterEach(cleanup);

describe('SetPasswordBanner', () => {
  it('submits a matching password and hides after success', async () => {
    const onDone = vi.fn();
    render(<SetPasswordBanner onDone={onDone} />);
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-very-strong-passphrase-1');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a-very-strong-passphrase-1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(setPassword).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('blocks mismatched confirmation', async () => {
    render(<SetPasswordBanner onDone={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-very-strong-passphrase-1');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a-different-value-here-1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));
    expect(setPassword).not.toHaveBeenCalled();
    expect(screen.getByText(/do not match/i)).toBeTruthy();
  });
});
