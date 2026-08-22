import { useEffect, useState } from 'react';

/** Storage key for the visitor's theme choice, shared by every console page. */
export const THEME_STORAGE = 'lwrr.theme';

/**
 * The closed set of themes. The default (no attribute) is the Adwait dark
 * palette seeded in styles.css; every other id must have a `[data-theme]`
 * preset block there. Ids are stable — they persist in localStorage.
 */
export const THEMES: readonly { id: string; label: string }[] = Object.freeze([
  { id: 'adwait', label: 'Adwait (default)' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'daylight', label: 'Daylight' },
  { id: 'rose', label: 'Rose' }
]);

const THEME_IDS = new Set(THEMES.map((theme) => theme.id));

/** Reads the stored theme, falling back to the default. */
export function storedTheme(): string {
  try {
    const value = localStorage.getItem(THEME_STORAGE);
    return value !== null && THEME_IDS.has(value) ? value : 'adwait';
  } catch {
    // Private-browsing storage can throw; the default theme needs no storage.
    return 'adwait';
  }
}

/**
 * Applies the stored theme to <html> and returns the active id. Call before
 * the first render on every console entry point so a returning visitor's
 * theme is on the page before it paints, not a frame after.
 */
export function applyStoredTheme(): string {
  const id = storedTheme();
  if (id === 'adwait') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = id;
  }
  return id;
}

/** Persists and applies a theme choice. */
export function setTheme(id: string): void {
  if (!THEME_IDS.has(id)) return;
  try {
    localStorage.setItem(THEME_STORAGE, id);
  } catch {
    // Storage refused: the theme still applies for this page view.
  }
  applyStoredTheme();
}

/**
 * Compact theme picker for app headers. Styled as a bare select so it sits in
 * a header row without importing the full input chrome.
 */
export function ThemeSelect({ className }: { className?: string }) {
  const [theme, setCurrent] = useState(() => storedTheme());

  // Another tab may change the stored theme; keep this one in step.
  useEffect(() => {
    const sync = () => setCurrent(storedTheme());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return (
    <select
      aria-label="Theme"
      value={theme}
      onChange={(event) => {
        setTheme(event.target.value);
        setCurrent(event.target.value);
      }}
      // Standalone classes rather than the ui.tsx helpers: importing them here
      // would create an import cycle (Shell renders this select).
      className={[
        'focus-ring h-9 cursor-pointer rounded-lg border border-border bg-surface px-2 text-xs text-muted transition-colors hover:text-ink',
        className
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {THEMES.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
