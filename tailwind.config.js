/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        abyss: '#090b13',
        sunset: '#ff9254',
        aqua: '#7ae2ff',
        warning: '#ffd76b',
        danger: '#ff6b8a',
      },
      fontFamily: {
        display: ['Barlow Condensed', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 24px 80px rgba(0, 0, 0, 0.38)',
      },
    },
  },
  plugins: [],
}