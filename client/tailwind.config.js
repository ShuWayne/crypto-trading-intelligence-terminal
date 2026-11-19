/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#05070d',
        panel: 'rgba(255,255,255,0.04)',
        electric: '#2f7bff',
        cyanx: '#22d3ee',
        violetx: '#8b5cf6',
        greenx: '#22c55e',
        redx: '#ef4444',
        amberx: '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: { card: '16px' },
      boxShadow: {
        glow: '0 0 24px rgba(47,123,255,0.35)',
        glowgreen: '0 0 24px rgba(34,197,94,0.30)',
        glowred: '0 0 24px rgba(239,68,68,0.30)',
      },
    },
  },
  plugins: [],
}
