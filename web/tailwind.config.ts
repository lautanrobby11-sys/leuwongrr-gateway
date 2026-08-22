import type { Config } from 'tailwindcss';

/**
 * A small, closed set of tokens. Every colour used by the console is named
 * here, so a screen cannot quietly introduce a ninth shade of grey and drift
 * away from the rest of the product.
 *
 * Values are `rgb(var(--c-*) / <alpha-value>)` triplets: the tokens stay
 * alpha-capable (`bg-brand/70` keeps working) while the actual colour lives in
 * a CSS variable that a theme preset can override at runtime — see the
 * `[data-theme]` presets in styles.css. Keys are stable API — screens reference
 * names, so a theme refresh only ever touches values here.
 */
export default {
  content: ['./*.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Triplets are "R G B" strings; :root in styles.css seeds them with the
        // GNOME "Adwait" dark palette (warm graphite surfaces, the desktop's
        // accent blue, semantic green/yellow/red).
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        brand: {
          DEFAULT: 'rgb(var(--c-brand) / <alpha-value>)',
          // The old soft tone was the accent at 0.14 alpha; deriving it keeps
          // every preset's soft fills matched to its own accent for free.
          soft: 'rgb(var(--c-brand) / 0.14)'
        },
        good: 'rgb(var(--c-good) / <alpha-value>)',
        warn: 'rgb(var(--c-warn) / <alpha-value>)',
        bad: 'rgb(var(--c-bad) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Cantarell', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      borderRadius: {
        card: '12px'
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -16px rgba(0,0,0,0.8)'
      },
      keyframes: {
        rise: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        rise: 'rise 220ms ease-out both'
      }
    }
  },
  plugins: []
} satisfies Config;
