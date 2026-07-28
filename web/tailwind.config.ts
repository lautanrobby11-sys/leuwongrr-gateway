import type { Config } from 'tailwindcss';

/**
 * A small, closed set of tokens. Every colour used by the console is named
 * here, so a screen cannot quietly introduce a ninth shade of grey and drift
 * away from the rest of the product.
 */
export default {
  content: ['./*.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#0b0d12',
        surface: '#12151d',
        raised: '#181c26',
        border: '#242938',
        muted: '#8b93a7',
        ink: '#e7eaf3',
        brand: {
          DEFAULT: '#4f8cff',
          soft: 'rgba(79, 140, 255, 0.12)'
        },
        good: '#3fb950',
        warn: '#d29922',
        bad: '#f85149'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      },
      borderRadius: {
        card: '14px'
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
