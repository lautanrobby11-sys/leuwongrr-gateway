import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon, type IconName } from './icons';

/** Tailwind class merge without a dependency: last class of a group wins. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---- Buttons ----

type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand/90 disabled:bg-brand/40',
  ghost: 'text-muted hover:bg-raised hover:text-ink',
  outline: 'border border-border bg-surface text-ink hover:border-brand/60',
  danger: 'border border-bad/40 text-bad hover:bg-bad/10'
};

export function Button({
  children,
  variant = 'primary',
  icon,
  busy = false,
  className,
  ...rest
}: {
  children?: ReactNode;
  variant?: ButtonVariant;
  icon?: IconName;
  busy?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx(
        'focus-ring inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        className
      )}
    >
      {busy ? <Icon name="spinner" size={16} spin /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

// ---- Surfaces ----

export function Card({
  title,
  subtitle,
  action,
  children,
  className
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'animate-rise rounded-card border border-border bg-surface shadow-card',
        className
      )}
    >
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone = 'default'
}: {
  label: string;
  value: string;
  hint?: string;
  icon: IconName;
  tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-good'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'bad'
          ? 'text-bad'
          : 'text-ink';
  return (
    <div className="animate-rise rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <Icon name={icon} size={14} animate />
        {label}
      </div>
      <p className={cx('mt-2 text-2xl font-semibold tabular-nums tracking-tight', toneClass)}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral'
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'brand';
}) {
  const tones = {
    neutral: 'border-border text-muted',
    good: 'border-good/40 text-good',
    warn: 'border-warn/40 text-warn',
    bad: 'border-bad/40 text-bad',
    brand: 'border-brand/40 text-brand'
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

/** Horizontal allowance bar. Colour shifts as the balance runs down. */
export function Meter({ used, total, label }: { used: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? 'bg-bad' : pct >= 70 ? 'bg-warn' : 'bg-brand';
  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
          <span>{label}</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <motion.div
          className={cx('h-full rounded-full', tone)}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// ---- Forms ----

export function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'focus-ring w-full rounded-lg border border-border bg-raised px-3 py-2 text-sm text-ink placeholder:text-muted/70';

// ---- Data display ----

/**
 * Tables scroll horizontally rather than reflowing into cards: on a phone a
 * shrunken table is still readable, whereas a stacked one loses the column
 * relationships that make usage data meaningful.
 */
export function Table({
  headers,
  children,
  empty
}: {
  headers: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  if (empty) return <EmptyState message="Nothing here yet." />;
  return (
    <div className="-mx-4 overflow-x-auto sm:mx-0">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            {headers.map((header) => (
              <th key={header} className="px-4 py-2 font-medium sm:px-3">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cx('px-4 py-2.5 align-middle sm:px-3', className)}>{children}</td>;
}

export function EmptyState({ message, icon = 'sparkles' }: { message: string; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted">
      <Icon name={icon} size={22} animate />
      {message}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <Icon name="spinner" size={16} spin />
      {label ?? 'Loading'}
    </div>
  );
}

// ---- Toasts ----

interface Toast {
  id: number;
  message: string;
  tone: 'good' | 'bad';
}

const ToastContext = createContext<(message: string, tone?: 'good' | 'bad') => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: 'good' | 'bad' = 'good') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-4 sm:items-end">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              className={cx(
                'pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-card',
                toast.tone === 'good'
                  ? 'border-good/40 bg-surface text-ink'
                  : 'border-bad/50 bg-surface text-ink'
              )}
              role="status"
            >
              <Icon name={toast.tone === 'good' ? 'check' : 'alert'} size={16} />
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// ---- Modal ----

export function Modal({
  open,
  title,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-lg rounded-t-card border border-border bg-surface shadow-card sm:rounded-card"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 360, damping: 30 }}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">{title}</h2>
              <button className="focus-ring rounded-md p-1 text-muted hover:text-ink" onClick={onClose} aria-label="Close">
                <Icon name="close" size={16} />
              </button>
            </header>
            <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---- App shell ----

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
}

/**
 * One shell for both dashboards. Wide viewports get a fixed rail; below 768px
 * the same items become a bottom bar, which keeps navigation reachable by
 * thumb without a second layout to maintain.
 */
export function Shell({
  title,
  subtitle,
  items,
  active,
  onSelect,
  onSignOut,
  children
}: {
  title: string;
  subtitle?: string;
  items: NavItem[];
  active: string;
  onSelect: (id: string) => void;
  onSignOut?: () => void;
  children: ReactNode;
}) {
  const activeLabel = useMemo(
    () => items.find((item) => item.id === active)?.label ?? title,
    [items, active, title]
  );

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
        <div className="flex items-center gap-2 px-5 py-4">
          <Icon name="sparkles" size={18} className="text-brand" animate />
          <div>
            <p className="text-sm font-semibold leading-tight">{title}</p>
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cx(
                'focus-ring flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                item.id === active
                  ? 'bg-brand-soft text-brand'
                  : 'text-muted hover:bg-raised hover:text-ink'
              )}
              aria-current={item.id === active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}
        </nav>
        {onSignOut && (
          <div className="border-t border-border p-3">
            <Button variant="ghost" icon="logout" className="w-full justify-start" onClick={onSignOut}>
              Sign out
            </Button>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-3 backdrop-blur md:px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight">{activeLabel}</h1>
            {subtitle && <p className="truncate text-xs text-muted md:hidden">{subtitle}</p>}
          </div>
          {onSignOut && (
            <Button variant="ghost" icon="logout" className="md:hidden" onClick={onSignOut} aria-label="Sign out" />
          )}
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4 pb-24 md:p-6 md:pb-6">
          {children}
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-flow-col border-t border-border bg-surface/95 backdrop-blur md:hidden">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className={cx(
                'focus-ring flex flex-col items-center gap-1 px-2 py-2.5 text-[11px]',
                item.id === active ? 'text-brand' : 'text-muted'
              )}
              aria-current={item.id === active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
