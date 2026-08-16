import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  PASSWORD_MIN_LENGTH
} from '../src/accounts/passwords.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
    expect(verifyPassword('wrong-password-value-here!!', hash)).toBe(false);
  });

  it('produces a unique salt per hash', () => {
    const a = hashPassword('same-password-value-12345');
    const b = hashPassword('same-password-value-12345');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password-value-12345', a)).toBe(true);
    expect(verifyPassword('same-password-value-12345', b)).toBe(true);
  });

  it('rejects a malformed stored hash instead of throwing', () => {
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });
});

describe('password strength', () => {
  it('accepts a long password and rejects a short one', () => {
    expect(validatePasswordStrength('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePasswordStrength('short')).toMatch(/at least/i);
  });

  it('rejects an overlong password', () => {
    expect(validatePasswordStrength('a'.repeat(200))).toMatch(/too long/i);
  });
});
