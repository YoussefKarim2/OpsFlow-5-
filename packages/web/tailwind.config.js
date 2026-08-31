/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Industrial palette: slate structure, a single confident accent, and
        // status colours that read at a glance on a factory floor monitor.
        ink: {
          50: '#f6f7f9', 100: '#eceef2', 200: '#d5dae2', 300: '#b0b9c8',
          400: '#8593a8', 500: '#65758d', 600: '#505d74', 700: '#424c5e',
          800: '#39414f', 900: '#333944', 950: '#21252d',
        },
        accent: {
          50: '#eef6ff', 100: '#d9ebff', 200: '#bcdcff', 300: '#8ec7ff',
          400: '#59a8ff', 500: '#3286fb', 600: '#1c67f0', 700: '#1552dd',
          800: '#1844b3', 900: '#1a3d8d', 950: '#152656',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        panel: '0 4px 12px -2px rgb(16 24 40 / 0.08), 0 2px 6px -2px rgb(16 24 40 / 0.05)',
      },
    },
  },
  plugins: [],
};
