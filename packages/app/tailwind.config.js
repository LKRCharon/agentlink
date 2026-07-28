/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["SF Mono", "Monaco", "Cascadia Code", "Roboto Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
