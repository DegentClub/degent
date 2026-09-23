import type { Config } from "tailwindcss";

// Degent Club design tokens. Keep these in sync with docs in README.md.
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0f0f10", // page background
          raised: "#161618", // cards
          border: "#26262a",
          muted: "#8a8a93",
          text: "#e8e6e1",
        },
        gold: {
          DEFAULT: "#d4a843", // accent, headings, primary actions
          dim: "#a8842f",
          soft: "rgba(212, 168, 67, 0.12)",
        },
        btc: {
          DEFAULT: "#f7931a", // reserved for BTC / cost figures only
          soft: "rgba(247, 147, 26, 0.12)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 12px 32px rgba(0,0,0,0.45)",
      },
    },
  },
  plugins: [],
};
export default config;
