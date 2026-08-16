import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number, message: string) { super(message); }
  },
  api: {
    session: vi.fn(async () => ({ authenticated: false, account: null, providers: { google: false, discord: false, telegram: false, telegram_bot: null } })),
    register: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '123456' })),
    registerVerify: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    loginPassword: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '654321' })),
    loginVerify: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    requestCode: vi.fn(async () => ({ delivered: false, ttl_minutes: 10, dev_code: '111111' })),
    verifyCode: vi.fn(async () => ({ authenticated: true, role: 'member' })),
    requestReset: vi.fn(async () => ({ delivered: true, ttl_minutes: 10 })),
    resetPassword: vi.fn(async () => ({ reset: true })),
    setPassword: vi.fn(async () => ({ set: true }))
  }
}));

import { App } from './main';

afterEach(cleanup);

describe('login shell', () => {
  it('shows the sign-in form with email and password by default', async () => {
    render(<App />);
    expect(await screen.findByLabelText(/email address/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
  });

  it('switches to registration with name, email, password, and confirmation', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /create account/i }));
    expect(screen.getByLabelText(/full name/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
  });

  it('has a visible eye toggle on the password field', async () => {
    render(<App />);
    await screen.findByLabelText(/email address/i);
    expect(screen.getAllByRole('button', { name: /show password/i }).length).toBeGreaterThan(0);
  });

  it('offers a forgot-password path', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /forgot password/i }));
    expect(screen.getByText(/reset your password/i)).toBeTruthy();
  });
});
