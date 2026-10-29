import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(({ mode }) => ({
  server: {
    host: process.env.VITE_HOST || "::",
    port: 8080,
    allowedHosts: true, // reachable by IP *or* host name from any PC in the network
    strictPort: true, // fail immediately if 8080 is taken — never silently bump to 8081
    hmr: { overlay: false },
    // changeOrigin must stay false: the API builds the WebRTC/HLS camera URLs from the
    // Host header it receives. Rewriting it to "localhost:3001" made every other PC
    // look for the camera streams on itself.
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: false },
      "/ws": { target: "ws://localhost:3001", ws: true, changeOrigin: false },
    },
  },

  // Pre-bundle every heavy dep so Vite doesn't lazy-compile on first browser request.
  // This cuts "blank screen for 10s" cold-start down to ~1-2s after the first run.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react-router-dom",
      "@tanstack/react-query",
      "lucide-react",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "date-fns",
      "framer-motion",
      "hls.js",
      "sonner",
      "next-themes",
      "react-day-picker",
      // radix primitives (most expensive to on-demand compile)
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toast",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-switch",
      "@radix-ui/react-label",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-popover",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-progress",
      "@radix-ui/react-slider",
    ],
    // Don't force re-bundle on every start — use the cache
    force: false,
  },

  plugins: [react()],

  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@tanstack/react-query",
    ],
  },

  // Suppress noisy TS/circular warnings that slow down the console
  build: {
    sourcemap: mode === "development",
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY") return;
        warn(warning);
      },
    },
  },
}));
