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
        // GNOME "Adwait" dark palette: warm graphite surfaces and the desktop's
        // accent blue (#3584e4) with its semantic green, yellow and red. Keys
        // are stable API — screens reference names, so a theme refresh only
        // ever touches values here.
        canvas: '#1b1b21',
        surface: '#24242b',
        raised: '#2e2e37',
        border: '#3d3d49',
        muted: '#a8a8b6',
        ink: '#f6f6f9',
        brand: {
          DEFAULT: '#3584e4',
          soft: 'rgba(53, 132, 228, 0.14)'
        },
        good: '#33d17a',
        warn: '#e5a50a',
        bad: '#f66151'
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
