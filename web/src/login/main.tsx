import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type SessionState } from '../lib/api';
import { LogoMark } from '../components/logo';
import { Button, Field, inputClass, ToastHost, useToast } from '../components/ui';
import { PasswordInput } from '../components/password-input';
import { applyStoredTheme } from '../components/theme';
import '../styles.css';

type Mode = 'signin' | 'register' | 'otp' | 'forgot' | 'reset';

const MIN_PASSWORD = 12;

export function App() {
  const toast = useToast();
  const [session, setSession] = useState<SessionState | null>(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  // Which flow the OTP step belongs to: registration or password sign-in.
  const [otpFlow, setOtpFlow] = useState<'register' | 'login'>('login');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function fail(error: unknown, fallback: string) {
    toast(error instanceof ApiError ? error.message : fallback, 'bad');
  }

  async function requestCodeOnly() {
    try {
      const result = await api.requestCode(email);
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Could not send the code'); }
  }

  async function resend() {
    if (otpFlow === 'register') {
      try { await api.register({ name, email, password, confirmPassword: confirm }); setCooldown(60); } catch (error) { fail(error, 'Could not resend'); }
    } else if (password) {
      try { await api.loginPassword(email, password); setCooldown(60); } catch (error) { fail(error, 'Could not resend'); }
    } else {
      await requestCodeOnly();
    }
  }

  async function submitRegister() {
    if (password !== confirm) return toast('Passwords do not match', 'bad');
    if (password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, 'bad');
    setBusy(true);
    try {
      const result = await api.register({ name, email, password, confirmPassword: confirm });
      setOtpFlow('register');
      setMode('otp');
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Could not start registration'); }
    finally { setBusy(false); }
  }

  async function submitLogin() {
    setBusy(true);
    try {
      const result = await api.loginPassword(email, password);
      setOtpFlow('login');
      setMode('otp');
      setCooldown(60);
      toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. Valid for ${result.ttl_minutes} minutes.`);
    } catch (error) { fail(error, 'Email or password is incorrect'); }
    finally { setBusy(false); }
  }

  async function submitOtp() {
    setBusy(true);
    try {
      if (otpFlow === 'register') await api.registerVerify(email, code);
      else await api.loginVerify(email, code);
      window.location.href = '/member';
    } catch (error) { fail(error, 'Code rejected'); }
    finally { setBusy(false); }
  }

  async function submitForgot() {
    setBusy(true);
    try {
      await api.requestReset(email);
      setMode('reset');
      toast('If that address exists, a reset code is on its way.');
    } catch (error) { fail(error, 'Could not request a reset'); }
    finally { setBusy(false); }
  }

  async function submitReset() {
    if (password !== confirm) return toast('Passwords do not match', 'bad');
    if (password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`, 'bad');
    setBusy(true);
    try {
      await api.resetPassword({ email, code, password, confirmPassword: confirm });
      toast('Password updated. Sign in with your new password.');
      setMode('signin');
      setPassword('');
      setConfirm('');
      setCode('');
    } catch (error) { fail(error, 'Could not reset the password'); }
    finally { setBusy(false); }
  }

  const oauth = ready && session && (session.providers.google || session.providers.discord);

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4 py-10 text-ink">
      <main className="w-full max-w-md">
        <a href="/" className="focus-ring mb-6 flex items-center justify-center gap-2 rounded-lg">
          <LogoMark size={28} />
          <span className="font-semibold tracking-tight">LeuwongRR Gateway</span>
        </a>

        <section className="rounded-card border border-border bg-surface p-6 shadow-card" aria-labelledby="auth-title">
          {!ready ? (
            <p className="py-10 text-center text-sm text-muted">Preparing authentication…</p>
          ) : (
            <>
              <h1 id="auth-title" className="text-lg font-semibold tracking-tight">
                {mode === 'register' ? 'Create your account'
                  : mode === 'otp' ? 'Enter your verification code'
                  : mode === 'forgot' ? 'Reset your password'
                  : mode === 'reset' ? 'Choose a new password'
                  : 'Sign in to the console'}
              </h1>
              <p className="mt-1 text-xs text-muted">
                {mode === 'register' ? 'Name, email, and a strong password, then a one-time code.'
                  : mode === 'otp' ? `We sent a six-digit code to ${email}.`
                  : mode === 'forgot' ? 'We will email you a one-time reset code.'
                  : mode === 'reset' ? 'Enter the code and your new password.'
                  : 'Password plus a one-time code. No password? Use a one-time email code.'}
              </p>

              {mode === 'signin' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitLogin(); }}>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
                  <Button type="submit" busy={busy} className="w-full">Continue</Button>
                  <div className="flex justify-between text-xs text-muted">
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode('forgot')}>Forgot password?</button>
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode('register')}>Create account</button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
                  <Button type="button" variant="outline" className="w-full" onClick={() => { setOtpFlow('login'); setMode('otp'); void requestCodeOnly(); }}>Email me a one-time code</Button>
                </form>
              )}

              {mode === 'register' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitRegister(); }}>
                  <Field label="Full name">
                    <input className={inputClass} autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Lovelace" />
                  </Field>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <PasswordInput label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} />
                  <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                  <Button type="submit" busy={busy} className="w-full">Create account</Button>
                  <p className="text-center text-xs text-muted">Already have an account? <button type="button" className="focus-ring rounded text-brand hover:underline" onClick={() => setMode('signin')}>Sign in</button></p>
                </form>
              )}

              {mode === 'otp' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitOtp(); }}>
                  <Field label="Verification code" hint={`Sent to ${email}`}>
                    <input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} />
                  </Field>
                  <Button type="submit" icon="check" busy={busy} className="w-full">Verify and continue</Button>
                  <div className="flex justify-between text-xs text-muted">
                    <button type="button" className="focus-ring min-h-[44px] rounded hover:text-ink" onClick={() => setMode(otpFlow === 'register' ? 'register' : 'signin')}>Back</button>
                    <button type="button" disabled={cooldown > 0 || busy} className="focus-ring min-h-[44px] rounded hover:text-ink disabled:opacity-50" onClick={() => void resend()}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}</button>
                  </div>
                </form>
              )}

              {mode === 'forgot' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitForgot(); }}>
                  <Field label="Email address">
                    <input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
                  </Field>
                  <Button type="submit" busy={busy} className="w-full">Send reset code</Button>
                  <p className="text-center text-xs text-muted"><button type="button" className="focus-ring rounded text-brand hover:underline" onClick={() => setMode('signin')}>Back to sign in</button></p>
                </form>
              )}

              {mode === 'reset' && (
                <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void submitReset(); }}>
                  <Field label="Reset code">
                    <input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} />
                  </Field>
                  <PasswordInput label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters.`} />
                  <PasswordInput label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
                  <Button type="submit" busy={busy} className="w-full">Update password</Button>
                </form>
              )}

              {oauth && mode === 'signin' && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {session!.providers.google && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/google')}>Google</Button>}
                  {session!.providers.discord && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/discord')}>Discord</Button>}
                </div>
              )}
            </>
          )}
        </section>

        <p className="mt-4 text-center text-xs text-muted">
          Prompts and completions are never logged. <a href="/" className="focus-ring rounded text-brand hover:underline">Back to site</a>
        </p>
      </main>
    </div>
  );
}

// Guard the mount so importing this module has no side effect off the page:
// the DOM behavioural tests import `App` directly and there is no #root then,
// while login.html always provides one in the browser. The stored theme is
// applied before the first render so the shell never flashes the default.
const rootElement = document.getElementById('root');
if (rootElement) {
  applyStoredTheme();
  createRoot(rootElement).render(
    <StrictMode>
      <ToastHost>
        <App />
      </ToastHost>
    </StrictMode>
  );
}
