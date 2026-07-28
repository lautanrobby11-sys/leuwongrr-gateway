import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type SessionState } from '../lib/api';
import { Icon } from '../components/icons';
import { Button, Field, inputClass, Spinner, ToastHost, useToast } from '../components/ui';
import '../styles.css';

function Login() {
  const toast = useToast();
  const [session, setSession] = useState<SessionState | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function requestCode() {
    setBusy(true);
    try {
      const result = await api.requestCode(email);
      setStage('code');
      setCooldown(60);
      toast(
        result.dev_code
          ? `Development code: ${result.dev_code}`
          : `Code sent. It expires in ${result.ttl_minutes} minutes.`
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not send the code', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    try {
      await api.verifyCode(email, code);
      window.location.href = '/member';
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Code rejected', 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (!session) return <Spinner label="Preparing sign in" />;

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="animate-rise w-full max-w-sm rounded-card border border-border bg-surface p-6 shadow-card">
        <div className="mb-5 flex items-center gap-2">
          <Icon name="sparkles" size={20} className="text-brand" animate />
          <div>
            <h1 className="text-base font-semibold tracking-tight">Sign in</h1>
            <p className="text-xs text-muted">LeuwongRR API console</p>
          </div>
        </div>

        {stage === 'email' ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void requestCode();
            }}
          >
            <Field label="Email address" hint="We send a six digit code. No phone number required.">
              <input
                className={inputClass}
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Button type="submit" icon="mail" busy={busy} className="w-full">
              Email me a code
            </Button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <Field label="Verification code" hint={`Sent to ${email}`}>
              <input
                className={`${inputClass} text-center text-lg tracking-[0.4em]`}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
              />
            </Field>
            <Button type="submit" icon="check" busy={busy} className="w-full">
              Verify and continue
            </Button>
            <div className="flex items-center justify-between text-xs text-muted">
              <button type="button" className="focus-ring rounded hover:text-ink" onClick={() => setStage('email')}>
                Use another email
              </button>
              <button
                type="button"
                className="focus-ring rounded hover:text-ink disabled:opacity-50"
                disabled={cooldown > 0 || busy}
                onClick={() => void requestCode()}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {(session.providers.google || session.providers.discord) && (
          <>
            <div className="my-5 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-border" />
              or continue with
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="grid gap-2">
              {session.providers.google && (
                <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/google')}>
                  Google
                </Button>
              )}
              {session.providers.discord && (
                <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/discord')}>
                  Discord
                </Button>
              )}
            </div>
          </>
        )}

        {session.providers.telegram && (
          <p className="mt-4 text-center text-xs text-muted">
            Telegram can be linked from your account page after you sign in.
          </p>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ToastHost>
      <Login />
    </ToastHost>
  </StrictMode>
);
