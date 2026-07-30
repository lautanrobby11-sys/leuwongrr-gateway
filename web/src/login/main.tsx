import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, type SessionState } from '../lib/api';
import { Icon, type IconName } from '../components/icons';
import { Button, Field, inputClass, ToastHost, useToast } from '../components/ui';
import '../styles.css';

const FEATURES: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: 'send', title: 'Satu endpoint', body: 'Pindahkan SDK dengan mengganti base URL dan API key.' },
  { icon: 'key', title: 'Key ber-scope', body: 'Secret tampil sekali; gateway hanya menyimpan HMAC.' },
  { icon: 'gauge', title: 'Budget terkendali', body: 'Rate limit, concurrency, entitlement, dan budget per tenant.' },
  { icon: 'activity', title: 'Usage terukur', body: 'Ledger, settlement, trace ID, dan histori tetap dapat diaudit.' },
  { icon: 'shield', title: 'Gagal tertutup', body: 'Route eksplisit dan kredensial upstream tidak diwariskan dari caller.' },
  { icon: 'sparkles', title: 'Streaming siap', body: 'Server-Sent Events diteruskan untuk endpoint yang mendukungnya.' }
];

const ENDPOINTS = [
  ['GET', '/v1/models', 'Model yang diizinkan tenant'],
  ['POST', '/v1/chat/completions', 'OpenAI Chat Completions'],
  ['POST', '/v1/responses', 'OpenAI Responses API'],
  ['POST', '/v1/messages', 'Anthropic Messages'],
  ['POST', '/v1/messages/count_tokens', 'Anthropic token count']
] as const;

const FAQ = [
  ['Apakah semua model tersedia?', 'Tidak. /v1/models hanya menampilkan model yang diizinkan untuk tenant pemanggil.'],
  ['Apakah API key bisa dipulihkan?', 'Tidak. Plaintext hanya tampil saat diterbitkan; gateway menyimpan HMAC.'],
  ['Apakah streaming didukung?', 'Ya, pada endpoint yang mendukung stream: true melalui Server-Sent Events.'],
  ['Apakah Gemini /v1beta tersedia?', 'Tidak. Portal hanya menyatakan endpoint yang benar-benar diimplementasikan.']
] as const;

function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 ${className}`}>{children}</div>;
}

function ActionLink({ children, href, icon, secondary = false }: { children: ReactNode; href: string; icon?: IconName; secondary?: boolean }) {
  return <a href={href} className={`focus-ring inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${secondary ? 'border border-border bg-surface text-ink hover:border-brand/60' : 'bg-brand text-white hover:bg-brand/90'}`}>{icon && <Icon name={icon} size={16} />}{children}</a>;
}

function PortalNav() {
  return <header className="sticky top-0 z-30 border-b border-border bg-canvas/90 backdrop-blur-xl"><Container className="flex min-h-16 items-center justify-between gap-4"><a href="#top" className="focus-ring flex items-center gap-2 rounded-lg"><span className="grid size-9 place-items-center rounded-lg bg-brand text-sm font-bold text-white shadow-card">L</span><span className="font-semibold tracking-tight">LeuwongRR <span className="text-brand">Gateway</span></span></a><nav aria-label="Navigasi utama" className="hidden items-center gap-1 md:flex">{['fitur', 'cara-kerja', 'docs', 'harga', 'faq'].map((item) => <a key={item} href={`#${item}`} className="focus-ring rounded-lg px-3 py-2 text-sm capitalize text-muted hover:bg-raised hover:text-ink">{item.replace('-', ' ')}</a>)}</nav><ActionLink href="#masuk">Mulai</ActionLink></Container></header>;
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
    try { const result = await api.requestCode(email); setStage('code'); setCooldown(60); toast(result.dev_code ? `Development code: ${result.dev_code}` : `Kode dikirim dan berlaku ${result.ttl_minutes} menit.`); }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Kode tidak dapat dikirim', 'bad'); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true);
    try { await api.verifyCode(email, code); window.location.href = '/member'; }
    catch (error) { toast(error instanceof ApiError ? error.message : 'Kode ditolak', 'bad'); }
    finally { setBusy(false); }
  }

  return <section id="masuk" className="rounded-card border border-border bg-surface p-5 shadow-card sm:p-6" aria-labelledby="signin-title"><div className="mb-5 flex items-center gap-3"><span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name="shield" size={20} /></span><div><h2 id="signin-title" className="font-semibold">Masuk ke console</h2><p className="text-xs text-muted">Kode sekali pakai; tanpa password.</p></div></div>{!ready ? <p className="py-8 text-center text-sm text-muted">Menyiapkan autentikasi…</p> : stage === 'email' ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void requestCode(); }}><Field label="Alamat email" hint="Kami mengirim kode enam digit."><input className={inputClass} type="email" inputMode="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="nama@contoh.com" /></Field><Button type="submit" icon="mail" busy={busy} className="w-full">Kirim kode verifikasi</Button></form> : <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void verify(); }}><Field label="Kode verifikasi" hint={`Dikirim ke ${email}`}><input className={`${inputClass} text-center text-lg tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))} /></Field><Button type="submit" icon="check" busy={busy} className="w-full">Verifikasi dan lanjutkan</Button><div className="flex justify-between text-xs text-muted"><button type="button" onClick={() => setStage('email')} className="focus-ring min-h-[44px] rounded hover:text-ink">Ganti email</button><button type="button" disabled={cooldown > 0 || busy} onClick={() => void requestCode()} className="focus-ring min-h-[44px] rounded hover:text-ink disabled:opacity-50">{cooldown > 0 ? `Kirim ulang ${cooldown}s` : 'Kirim ulang'}</button></div></form>}{ready && (session?.providers.google || session?.providers.discord) && <><div className="my-5 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-border" />atau<span className="h-px flex-1 bg-border" /></div><div className="grid gap-2 sm:grid-cols-2">{session.providers.google && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/google')}>Google</Button>}{session.providers.discord && <Button variant="outline" onClick={() => (window.location.href = '/console/api/auth/start/discord')}>Discord</Button>}</div></>}{ready && session?.providers.telegram && <p className="mt-4 text-center text-xs text-muted">Penautan Telegram belum tersedia di console; gunakan email atau provider di atas.</p>}<p className="mt-4 text-center text-xs text-muted">Sudah masuk? <a href="/member" className="focus-ring rounded text-brand hover:underline">Buka dashboard</a></p></section>;
}

function HeroCode() {
  return <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card"><div className="flex items-center justify-between border-b border-border px-4 py-3 text-xs text-muted"><span className="tracking-[.25em] text-bad">● ● ●</span><span>Python · OpenAI SDK</span></div><pre className="overflow-x-auto p-5 text-[13px] leading-7 text-muted"><code><span className="text-brand">from</span> openai <span className="text-brand">import</span> OpenAI{`\n\n`}client = OpenAI({`\n`}  base_url=<span className="text-good">"https://api.leuwongrr.cloud/v1"</span>,{`\n`}  api_key=os.environ[<span className="text-good">"LW_API_KEY"</span>]{`\n`}){`\n\n`}result = client.chat.completions.create({`\n`}  model=<span className="text-good">"lwrr-text"</span>,{`\n`}  messages=[{`{`}<span className="text-good">"role"</span>: <span className="text-good">"user"</span>, <span className="text-good">"content"</span>: <span className="text-good">"Halo"</span>{`}`}] {`\n`})</code></pre></div>;
}

function App() {
  return <div id="top" className="min-h-full bg-canvas text-ink"><PortalNav /><main><section className="relative overflow-hidden border-b border-border py-16 sm:py-24"><div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,rgba(39,131,222,.16),transparent_34%),radial-gradient(circle_at_80%_5%,rgba(114,188,143,.10),transparent_30%)]" /><Container className="relative grid items-center gap-12 lg:grid-cols-[1.15fr_.85fr]"><div><span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand"><Icon name="sparkles" size={14} />Infrastruktur AI yang terkendali</span><h1 className="mt-6 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">Satu gateway untuk <span className="text-brand">model AI</span> yang Anda izinkan.</h1><p className="mt-5 max-w-2xl text-base leading-7 text-muted sm:text-lg">Gunakan antarmuka OpenAI dan Anthropic, terbitkan API key ber-scope, pantau usage, dan batasi biaya tanpa menambah proxy liar.</p><div className="mt-7 flex flex-wrap gap-3"><ActionLink href="#masuk" icon="send">Mulai sekarang</ActionLink><ActionLink href="#docs" secondary>Lihat dokumentasi</ActionLink></div><div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted"><span>✓ HMAC-hashed keys</span><span>✓ Tenant scoped</span><span>✓ Explicit allowlist</span></div></div><HeroCode /></Container></section>

<section id="fitur" className="py-16 sm:py-24"><Container><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Kemampuan inti</p><h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Kompatibel untuk developer, tegas untuk operator.</h2></div><div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{FEATURES.map((feature) => <article key={feature.title} className="rounded-card border border-border bg-surface p-5"><span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand"><Icon name={feature.icon} size={19} /></span><h3 className="mt-4 font-semibold">{feature.title}</h3><p className="mt-2 text-sm leading-6 text-muted">{feature.body}</p></article>)}</div></Container></section>

<section id="cara-kerja" className="border-y border-border bg-surface py-16 sm:py-24"><Container><div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Cara kerja</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">Dari akun ke request pertama.</h2><p className="mt-4 text-sm leading-6 text-muted">Alur sederhana di depan kontrol tenant dan settlement yang eksplisit.</p></div><ol className="grid gap-3 sm:grid-cols-3">{[['01','Verifikasi akun','Gunakan email atau provider yang dikonfigurasi.'],['02','Terbitkan key','Pilih scope; salin secret saat ditampilkan.'],['03','Hubungkan SDK','Ganti base URL dan gunakan model yang diizinkan.']].map(([no,title,body]) => <li key={no} className="rounded-card border border-border bg-canvas p-5"><span className="text-xs font-semibold text-brand">LANGKAH {no}</span><h3 className="mt-3 font-semibold">{title}</h3><p className="mt-2 text-sm text-muted">{body}</p></li>)}</ol></div></Container></section>

<section id="docs" className="py-16 sm:py-24"><Container><div className="grid gap-8 lg:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Developer docs</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">API surface yang kecil dan eksplisit.</h2><p className="mt-4 text-sm leading-6 text-muted">Base URL SDK: <code className="rounded bg-raised px-1.5 py-1 text-ink">https://api.leuwongrr.cloud/v1</code>. Semua request data plane memakai Bearer API key.</p><div className="mt-6 rounded-card border border-border bg-surface p-4"><pre className="overflow-x-auto text-xs leading-6 text-muted"><code>{`curl https://api.leuwongrr.cloud/v1/chat/completions \\\n  -H "Authorization: Bearer $LW_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"lwrr-text","messages":[{"role":"user","content":"Halo"}]}'`}</code></pre></div></div><div className="overflow-hidden rounded-card border border-border bg-surface">{ENDPOINTS.map(([method,path,detail]) => <div key={path} className="grid gap-2 border-b border-border p-4 last:border-0 sm:grid-cols-[64px_1fr]"><span className={`text-xs font-semibold ${method === 'GET' ? 'text-good' : 'text-brand'}`}>{method}</span><div><code className="text-sm text-ink">{path}</code><p className="mt-1 text-xs text-muted">{detail}</p></div></div>)}</div></div></Container></section>

<section id="harga" className="border-y border-border bg-surface py-16 sm:py-24"><Container><div className="mx-auto max-w-2xl text-center"><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Harga</p><h2 className="mt-3 text-3xl font-semibold tracking-tight">Plan mengikuti kebijakan operator.</h2><p className="mt-4 text-sm leading-6 text-muted">Harga, token allowance, RPM, concurrency, dan model diambil dari katalog aktif setelah masuk—tidak ada angka marketing yang berbeda dari konfigurasi gateway.</p><span className="mt-6 inline-block"><ActionLink href="#masuk" icon="card">Lihat plan aktif</ActionLink></span></div></Container></section>

<section id="faq" className="py-16 sm:py-24"><Container><div className="mx-auto max-w-3xl"><p className="text-center text-xs font-semibold uppercase tracking-[.18em] text-brand">FAQ</p><div className="mt-8 space-y-3">{FAQ.map(([question, answer]) => <details key={question} className="group rounded-card border border-border bg-surface p-4"><summary className="cursor-pointer list-none font-medium">{question}<span className="float-right text-brand group-open:rotate-45">＋</span></summary><p className="mt-3 text-sm leading-6 text-muted">{answer}</p></details>)}</div></div></Container></section>

<section className="border-t border-border bg-surface py-16"><Container className="grid items-start gap-10 lg:grid-cols-[1fr_420px]"><div><p className="text-xs font-semibold uppercase tracking-[.18em] text-brand">Siap membangun?</p><h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight">Masuk, pilih plan aktif, lalu terbitkan key pertama.</h2><p className="mt-4 max-w-xl text-sm leading-6 text-muted">Console member menangani usage, ledger, pembayaran, subscription, dan lifecycle API key. Admin tetap memerlukan Cloudflare Access serta peran aplikasi.</p><div className="mt-6 flex flex-wrap gap-3"><ActionLink href="/member" secondary>Member</ActionLink><ActionLink href="/chat" secondary>Chat</ActionLink></div></div><SignInCard /></Container></section></main><footer className="border-t border-border py-8"><Container className="flex flex-col gap-3 text-xs text-muted sm:flex-row sm:items-center sm:justify-between"><p>© LeuwongRR Gateway</p><p>OpenAI-compatible · Tenant-scoped · Explicitly allowlisted</p></Container></footer></div>;
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><ToastHost><App /></ToastHost></StrictMode>);
