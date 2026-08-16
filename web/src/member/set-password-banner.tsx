import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/ui';
import { PasswordInput } from '../components/password-input';

const MIN_PASSWORD = 12;

/**
 * Shown to members who signed in through the legacy passwordless path and have
 * not yet chosen a password. Setting one opts them into password + OTP login.
 */
export function SetPasswordBanner({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (password !== confirm) return setError('Passwords do not match.');
    if (password.length < MIN_PASSWORD) return setError(`Password must be at least ${MIN_PASSWORD} characters.`);
    setBusy(true);
    try {
      await api.setPassword({ password, confirmPassword: confirm });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-brand/40 bg-brand-soft p-4">
      <p className="text-sm font-medium text-ink">Add a password to your account</p>
      <p className="mt-1 text-xs text-muted">
        You signed in with a one-time email code. Set a password to use password + code sign-in next time.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="new-password" />
        <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
      </div>
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button busy={busy} onClick={() => void save()}>Save password</Button>
        <Button variant="ghost" onClick={onDone}>Dismiss</Button>
      </div>
    </div>
  );
}
