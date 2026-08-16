import { describe, expect, it } from 'vitest';
import { AccountStore } from '../src/accounts/store.js';
import { hashPassword, verifyPassword } from '../src/accounts/passwords.js';
import { createTempDatabase, testConfig } from './support/harness.js';

describe('AccountStore password and purpose-aware OTP', () => {
  it('stores and reports a password hash without exposing it on the record', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const account = store.create({ email: 'pw@example.test', displayName: 'Pw' });
      expect(store.hasPassword(account.id)).toBe(false);
      store.setPassword(account.id, hashPassword('a-strong-password-1'));
      expect(store.hasPassword(account.id)).toBe(true);
      const record = store.findById(account.id);
      expect(record?.passwordHash).toBeNull(); // never surfaced as plaintext
      const raw = db.db
        .prepare('SELECT password_hash FROM accounts WHERE id=?')
        .get(account.id) as { password_hash: string };
      expect(verifyPassword('a-strong-password-1', raw.password_hash)).toBe(true);
    } finally {
      dispose();
    }
  });

  it('marks an account email-verified', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const account = store.create({ email: 'verify@example.test' });
      store.markEmailVerified(account.id);
      expect(store.findById(account.id)?.emailVerifiedAt).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it('keeps register, login, and reset codes separate', () => {
    const { db, dispose } = createTempDatabase();
    try {
      const store = new AccountStore(db.db, testConfig.API_KEY_PEPPER);
      const registerCode = store.issueCode('multi@example.test', 'register', 10, 0);
      // A login consume must not accept a register code.
      expect(store.consumeCode('multi@example.test', registerCode, 'login', 5)).toBe(false);
      expect(store.consumeCode('multi@example.test', registerCode, 'register', 5)).toBe(true);
    } finally {
      dispose();
    }
  });
});
