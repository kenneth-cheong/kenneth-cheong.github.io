/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Brand palette mirrors index.html's primary blue (--primary-blue #2563eb
      // = blue-600, hover #1d4ed8 = blue-700) so the SaaS app reads as the same product.
      colors: {
        brand: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
          400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
          800: '#1e40af', 900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        // index.html metric/cockpit card lift on hover
        lift: '0 12px 24px rgba(0, 0, 0, 0.05)',
      },
      // Assistant panel "launch" entrance — slides in from the right edge while
      // fading in. Applied (motion-safe) on the ChatDrawer aside each open.
      keyframes: {
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'slide-in-right': 'slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
