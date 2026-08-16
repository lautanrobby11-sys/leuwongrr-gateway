import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PasswordInput } from './password-input';

afterEach(cleanup);

function Harness() {
  const [value, setValue] = useState('');
  return <PasswordInput label="Password" value={value} onChange={setValue} autoComplete="new-password" />;
}

describe('PasswordInput', () => {
  it('masks by default and reveals on toggle without losing the value', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Password') as HTMLInputElement;
    await userEvent.type(input, 'hunter2secret');
    expect(input.type).toBe('password');

    const toggle = screen.getByRole('button', { name: /show password/i });
    await userEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(input.value).toBe('hunter2secret');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(toggle);
    expect(input.type).toBe('password');
    expect(input.value).toBe('hunter2secret');
  });

  it('keeps the toggle keyboard operable', async () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', { name: /show password/i });
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('text');
  });
});
