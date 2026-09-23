import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bitcoin: "#F7931A",
        degent: {
          green: '#2efc86',
          orange: '#f7931a',
          dark: '#0b0b0d',
          darker: '#080808',
          card: '#1a1a1d',
          border: '#2a2a2d',
          input: '#151519',
          muted: '#9ca3af',
        }
      },
      fontFamily: {
        sans: ['var(--font-space-grotesk)', '"Space Grotesk"', 'sans-serif'],
      },
      backgroundImage: {
        'degent-gradient': 'linear-gradient(to bottom right, #2efc86, #f7931a)',
        'degent-gradient-hover': 'linear-gradient(to right, rgba(46, 252, 134, 0.9), rgba(247, 147, 26, 0.9))',
      },
      boxShadow: {
        'glow-green': '0 0 20px rgba(46, 252, 134, 0.3)',
        'glow-orange': '0 0 20px rgba(247, 147, 26, 0.3)',
      },
      borderRadius: {
        'degent-card': '10px',
        'degent-button': '6px',
      },
      padding: {
        'hero-md': '180px',
      }
    },
  },
  plugins: [],
};
export default config;
