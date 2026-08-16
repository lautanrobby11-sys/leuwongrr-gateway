import { useEffect, useRef, useState } from 'react';

/**
 * Clipboard copy without pulling the motion/icon stack: the public portal has a
 * byte budget and every `ui.tsx` import would drag Motion into its bundle. The
 * two inline glyphs keep this module dependency-free on purpose.
 */
export function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied',
  className,
  compact = false
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      // Non-secure contexts (plain HTTP on localhost) have no clipboard API;
      // a transient textarea still copies without any dependency.
      const helper = document.createElement('textarea');
      helper.value = value;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      helper.remove();
    }
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      aria-live="polite"
      className={
        className ??
        'focus-ring inline-flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/60 hover:text-ink'
      }
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
      {compact ? null : <span>{copied ? copiedLabel : label}</span>}
    </button>
  );
}
