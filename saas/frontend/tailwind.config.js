/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff', 100: '#dbe6ff', 200: '#bccfff', 300: '#8eabff',
          400: '#597dff', 500: '#3457f5', 600: '#1f3ad6', 700: '#1a2faa',
          800: '#1b2b87', 900: '#1b296b',
        },
      },
    },
  },
  plugins: [],
};
