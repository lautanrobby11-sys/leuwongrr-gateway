import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type SessionState } from '../lib/api';
import { Icon, type IconName } from '../components/icons';
import { Button, Field, inputClass, ToastHost, useToast } from '../components/ui';
import '../styles.css';

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'send', title: 'One endpoint', body: 'Point your SDK at the gateway by changing the base URL and API key.' },
  { icon: 'key', title: 'Scoped keys', body: 'Secrets are shown once at issuance; the gateway stores an HMAC, never the plaintext.' },
  { icon: 'gauge', title: 'Configured budgets', body: 'Rate limits, concurrency, entitlements, and per-tenant daily budgets follow operator policy.' },
  { icon: 'activity', title: 'Measurable usage', body: 'Ledger, settlement, trace IDs, and history stay audit-friendly end to end.' },
  { icon: 'shield', title: 'Fails closed', body: 'Routes are explicit, and upstream credentials are never inherited from the caller.' },
  { icon: 'sparkles', title: 'Streaming ready', body: 'Server-Sent Events are forwarded for every endpoint that supports them.' }
];

const ENDPOINTS = [
  ['GET', '/v1/models', 'Models allowed for the tenant'],
  ['POST', '/v1/chat/completions', 'OpenAI Chat Completions'],
  ['POST', '/v1/responses', 'OpenAI Responses API'],
  ['POST', '/v1/messages', 'Anthropic Messages'],
  ['POST', '/v1/messages/count_tokens', 'Anthropic token count']
] as const;

const FAQ = [
  ['Are all models available?', 'No. /v1/models lists only the models the calling tenant is allowed to use.'],
  ['Can an API key be recovered?', 'No. The plaintext is shown once at issuance; the gateway keeps only the HMAC.'],
  ['Is streaming supported?', 'Yes, on endpoints that support stream: true via Server-Sent Events.'],
  ['Is Gemini /v1beta available?', 'No. The portal documents only the endpoints that are actually implemented.']
] as const;

function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

function ActionLink({ children, href, icon, secondary = false }: { children: ReactNode; href: string; icon?: IconName; secondary?: boolean }) {
  return <a href={href} className={`focus-ring inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${secondary ? 'border border-border bg-surface text-ink hover:border-brand/60' : 'bg-brand text-white hover:bg-brand/90'}`}>{icon && <Icon name={icon} size={16} />}{children}</a>;
}

function PortalNav() {
  return <header className="sticky top-0 z-30 border-b border-border bg-canvas/90 backdrop-blur-xl"><Container className="flex min-h-16 items-center justify-between gap-4"><a href="#top" className="focus-ring flex items-center gap-2 rounded-lg"><span className="grid size-9 place-items-center rounded-lg bg-brand text-sm font-bold text-white shadow-card">L</span><span className="font-semibold tracking-tight">LeuwongRR <span className="text-brand">Gateway</span></span></a><nav aria-label="Primary navigation" className="hidden items-center gap-1 md:flex">{['features', 'how-it-works', 'docs', 'pricing', 'faq'].map((item) => <a key={item} href={`#${item}`} className="focus-ring rounded-lg px-3 py-2 text-sm capitalize text-muted hover:bg-raised hover:text-ink">{item.replace('-', ' ')}</a>)}</nav><ActionLink href="#signin">Get started</ActionLink></Container></header>;
}

function SignInCard() {
  const toast = useToast();
  const [session, setSession] = useState<SessionState | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => { api.session().then(setSession).catch(() => setSession(null)).finally(() => setReady(true)); }, []);
  useEffect(() => { if (cooldown <= 0) return; const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000); return () => window.clearTimeout(timer); }, [cooldown]);

  async function requestCode() {
    setBusy(true);
    try { const result = await api.requestCode(email); setStage('code'); setCooldown(60); toast(result.dev_code ? `Development code: ${result.dev_code}` : `Code sent. It stays valid for ${result.ttl_minutes} minutes.`); }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Could not send the code', 'bad'); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true);
    try { await api.verifyCode(email, code); window.location.href = '/member'; }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Code rejected', 'bad'); }
    finally { setBusy(false); }
  }

  return <section id="signin" className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6" aria-labelledby="signin-title"><div className="mb-5 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name="shield" size={20} /></span><div><h2 id="signin-title" className="font-semibold">Sign in to the console</h2><p className="text-xs text-muted">One-time code; no password.</p></div></div>{!ready ? <p className="py-8 text-center text-sm text-muted">Preparing authentication…</p> : stage === 'email' ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void requestCode(); }}><Field label="Email address" hint="We will send a six-digit code."><input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></Field><Button type="submit" icon="mail" busy={busy} className="w-full">Send verification code</Button></form> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void verify(); }}><Field label="Verification code" hint={`Sent to ${email}`}><input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} /></Field><Button type="submit" icon="check" busy={busy} className="w-full">Verify and continue</Button><div className="flex justify-between text-xs text-muted"><button type="button" onClick={() => setStage('email')} className="focus-ring min-h-[44px] rounded hover:text-ink">Change email</button><button type="button" disabled={cooldown > 0 || busy} onClick={() => void requestCode()} className="focus-ring min-h-[44px] rounded hover:text-ink disabled:opacity-50">{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}</button></div></form>}{ready && (session?.providers.google || session?.providers.discord) && <><div className="my-5 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div><div className="grid gap-2 sm:grid-cols-2">{session.providers.google && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/google')}>Google</Button>}{session.providers.discord && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/discord')}>Discord</Button>}</div></>}{ready && session?.providers.telegram && <p className="mt-4 text-center text-xs text-muted">Telegram sign-in is not available in the console yet; use email or the providers above.</p>}<p className="mt-4 text-center text-xs text-muted">Already signed in? <a href="/member" className="focus-ring rounded text-brand hover:underline">Open dashboard</a></p></section>;
}

function HeroCode() {
  return <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card"><div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs text-muted"><span className="tracking-[.25em] text-bad">● ● ●</span><span>Python · OpenAI SDK</span></div><pre className="overflow-x-auto p-5 text-[13px] leading-7 text-muted"><code><span className="text-brand">import</span> os{`\n\n`}<span className="text-brand">from</span> openai <span className="text-brand">import</span> OpenAI{`\n\n`}client = OpenAI({`\n`}  base_url=<span className="text-good">"https://api.leuwongrr.cloud/v1"</span>,{`\n`}  api_key=os.environ[<span className="text-good">"LW_API_KEY"</span>]{`\n`}){`\n\n`}result = client.chat.completions.create({`\n`}  model=<span className="text-good">"lwrr-text"</span>,{`\n`}  messages=[{`{`}<span className="text-good">"role"</span>: <span className="text-good">"user"</span>, <span className="text-good">"content"</span>: <span className="text-good">"Hello"</span>{`}`}] {`\n`})</code></pre></div>;
}

function App() {
  return <div id="top" className="min-h-full bg-canvas text-ink"><PortalNav /><main><section className="relative overflow-hidden border-b border-border py-16 sm:py-24"><div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(39,131,222,.16),transparent_34%),radial-gradient(circle_at_80%_5%,rgba(114,188,143,.10),transparent_30%)]" /><Container className="relative grid items-center gap-12 lg:grid-cols-[1.15fr_.85fr]"><div><span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand"><Icon name="sparkles" size={14} />Controlled AI infrastructure</span><h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">One AI API gateway for the <span className="text-brand">models you allow</span>.</h1><p className="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Speak OpenAI and Anthropic from one endpoint, issue scoped API keys, track token usage, and set per-tenant daily budgets under operator policy — without a rogue proxy in between.</p><div className="mt-7 flex flex-wrap gap-3"><ActionLink href="#signin" icon="send">Get started</ActionLink><ActionLink href="#docs" secondary>Read the docs</ActionLink></div><div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted"><span>✓ HMAC-hashed keys</span><span>✓ Tenant scoped</span><span>✓ Explicit allowlist</span></div></div><HeroCode /></Container></section>

<section id="features" className="py-16 sm:py-24"><Container><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Core capabilities</p><h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Drop-in for developers, decisive for operators.</h2></div><div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{FEATURES.map((feature) => <article key={feature.title} className="rounded-card border border-border bg-surface p-5"><span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name={feature.icon} size={19} /></span><h3 className="mt-4 font-semibold">{feature.title}</h3><p className="mt-2 text-sm leading-6 text-muted">{feature.body}</p></article>)}</div></Container></section>

<section id="how-it-works" className="border-y border-border bg-surface py-16 sm:py-24"><Container><div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">How it works</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">From account to first request.</h2><p className="mt-4 text-sm leading-6 text-muted">A short path in front of explicit tenant policy and settlement.</p></div><ol className="grid gap-3 sm:grid-cols-3">{[['01','Verify your account','Sign in with email or a configured provider.'],['02','Issue a key','Pick scopes and copy the secret while it is shown.'],['03','Point your SDK','Swap the base URL and call the models you are entitled to.']].map(([no,title,body]) => <li key={no} className="rounded-card border border-border bg-canvas p-5"><span className="text-xs font-semibold text-brand">STEP {no}</span><h3 className="mt-3 font-semibold">{title}</h3><p className="mt-2 text-sm text-muted">{body}</p></li>)}</ol></div></Container></section>

<section id="docs" className="py-16 sm:py-24"><Container><div className="grid gap-8 lg:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Developer docs</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">A small, explicit API surface.</h2><p className="mt-4 text-sm leading-6 text-muted">SDK base URL: <code className="rounded bg-raised px-1.5 py-1 text-ink">https://api.leuwongrr.cloud/v1</code>. Every data-plane request uses a Bearer API key.</p><div className="mt-6 rounded-card border border-border bg-surface p-4"><pre className="overflow-x-auto text-xs leading-6 text-muted"><code>{`curl https://api.leuwongrr.cloud/v1/chat/completions \\\n  -H "Authorization: Bearer $LW_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"lwrr-text","messages":[{"role":"user","content":"Hello"}]}'`}</code></pre></div></div><div className="overflow-hidden rounded-card border border-border bg-surface">{ENDPOINTS.map(([method,path,detail]) => <div key={path} className="grid gap-2 border-b border-border p-4 last:border-0 sm:grid-cols-[64px_1fr]"><span className={`text-xs font-semibold ${method === 'GET' ? 'text-good' : 'text-brand'}`}>{method}</span><div><code className="text-sm text-ink">{path}</code><p className="mt-1 text-xs text-muted">{detail}</p></div></div>)}</div></div></Container></section>

<section id="pricing" className="border-y border-border bg-surface py-16 sm:py-24"><Container><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Pricing</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">Plans follow operator policy.</h2><p className="mt-4 text-sm leading-6 text-muted">Prices, token allowances, RPM, concurrency, and models are read from the live catalog after you sign in — no marketing numbers that differ from the gateway configuration.</p><span className="mt-6 inline-block"><ActionLink href="#signin" icon="card">See live plans</ActionLink></span></div></Container></section>

<section id="faq" className="py-16 sm:py-24"><Container><div className="mx-auto max-w-3xl"><p className="text-center text-xs font-semibold uppercase tracking-[.18em] text-brand">FAQ</p><div className="mt-8 space-y-3">{FAQ.map(([question, answer]) => <details key={question} className="group rounded-card border border-border bg-surface p-4"><summary className="cursor-pointer list-none font-medium">{question}<span className="float-right text-brand group-open:rotate-45">＋</span></summary><p className="mt-3 text-sm leading-6 text-muted">{answer}</p></details>)}</div></div></Container></section>

<section className="border-t border-border bg-surface py-16"><Container className="grid items-start gap-10 lg:grid-cols-[1fr_420px]"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Ready to build?</p><h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight">Sign in, pick a live plan, and issue your first key.</h2><p className="mt-4 max-w-xl text-sm leading-6 text-muted">The member console handles usage, ledger, payments, subscriptions, and API-key lifecycle. Admins still need Cloudflare Access plus an application role.</p><div className="mt-6 flex flex-wrap gap-3"><ActionLink href="/member" secondary>Member</ActionLink><ActionLink href="/chat" secondary>Chat</ActionLink></div></div><SignInCard /></Container></section></main><footer className="border-t border-border py-8"><Container className="flex flex-col gap-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between"><p>© LeuwongRR Gateway</p><p>OpenAI-compatible · Tenant-scoped · Explicitly allowlisted</p></Container></footer></div>;
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><ToastHost><App /></ToastHost></StrictMode>);
