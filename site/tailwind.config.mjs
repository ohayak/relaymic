import defaultTheme from "tailwindcss/defaultTheme";
import daisyui from "daisyui";
import typography from "@tailwindcss/typography";

// Remote Visio palette (DESIGN.md is the reference). Ink and paper come from
// the black line-art icon (icons/icon.svg); the three signal colours are the
// segments of a level meter: green = it gets through, amber = on its way,
// red = needs you. They mean the same thing here as on the sender page.
const shared = {
  "--rounded-box": "1.25rem",
  "--rounded-btn": "0.75rem",
  "--rounded-badge": "1.9rem",
  "--animation-btn": "0.15s",
  "--btn-focus-scale": "0.98",
  "--tab-radius": "0.75rem",
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,md,mdx,ts}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    screens: {
      "3xs": "350px",
      "2xs": "400px",
      xs: "475px",
      ...defaultTheme.screens,
    },
    extend: {
      fontFamily: {
        sans: ["Archivo", ...defaultTheme.fontFamily.sans],
        mono: ["IBM Plex Mono", ...defaultTheme.fontFamily.mono],
      },
      maxWidth: {
        prose: "70ch",
      },
    },
  },
  plugins: [daisyui, typography],
  daisyui: {
    logs: false,
    themes: [
      {
        remotevisio: {
          ...shared,
          "color-scheme": "light",
          primary: "#131417",
          "primary-content": "#ffffff",
          secondary: "#ffb000",
          "secondary-content": "#131417",
          accent: "#1d7a46",
          "accent-content": "#ffffff",
          neutral: "#131417",
          "neutral-content": "#eceae6",
          "base-100": "#ffffff",
          "base-200": "#f4f4f5",
          "base-300": "#e4e4e7",
          "base-content": "#131417",
          info: "#2457c5",
          "info-content": "#ffffff",
          success: "#1d7a46",
          "success-content": "#ffffff",
          warning: "#ffb000",
          "warning-content": "#131417",
          error: "#c2380f",
          "error-content": "#ffffff",
        },
      },
      {
        dark: {
          ...shared,
          "color-scheme": "dark",
          primary: "#eceae6",
          "primary-content": "#131417",
          secondary: "#ffb000",
          "secondary-content": "#131417",
          accent: "#57d08a",
          "accent-content": "#131417",
          neutral: "#0c0d0f",
          "neutral-content": "#eceae6",
          "base-100": "#131417",
          "base-200": "#17181c",
          "base-300": "#2a2c33",
          "base-content": "#eceae6",
          info: "#7aa7ff",
          "info-content": "#131417",
          success: "#57d08a",
          "success-content": "#131417",
          warning: "#ffb000",
          "warning-content": "#131417",
          error: "#ff4a17",
          "error-content": "#131417",
        },
      },
    ],
  },
};
