/**
 * Loaded by src/index.css via `@config`. Tailwind v4 honours darkMode + theme.extend here.
 * Colours map to the CSS custom properties defined in src/index.css (:root / .dark) so a single
 * .dark class flips the whole palette. No hex lives here or in any component — only var() refs.
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
        },
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        rule: 'var(--rule)',
        accent: 'var(--accent)',
        ok: 'var(--status-ok)',
        retried: 'var(--status-retried)',
        failed: 'var(--status-failed)',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      // Type scale from DESIGN.md. mono-* = JetBrains Mono payloads; the rest = IBM Plex Sans.
      fontSize: {
        'headline-lg': ['20px', { lineHeight: '24px', fontWeight: '600' }],
        'headline-sm': ['15px', { lineHeight: '20px', fontWeight: '600' }],
        'body-md': ['13px', { lineHeight: '18px', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '16px', fontWeight: '400' }],
        'mono-metric': ['20px', { lineHeight: '24px', letterSpacing: '-0.02em', fontWeight: '500' }],
        'mono-body': ['13px', { lineHeight: '18px', fontWeight: '400' }],
        'mono-sm': ['11px', { lineHeight: '14px', fontWeight: '400' }],
        'label-caps': ['10px', { lineHeight: '12px', letterSpacing: '0.06em', fontWeight: '600' }],
      },
      spacing: {
        gutter: '0.75rem',
        margin: '1rem',
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '0.75rem',
        'space-lg': '1rem',
        'space-xl': '1.5rem',
      },
      borderRadius: {
        sm: '0.125rem',
        DEFAULT: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
    },
  },
};
