import { defineConfig } from "vite";

export default defineConfig({
  define: { global: "globalThis" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
    // Two pages: the game, and the public on-chain stats page (/stats).
    rollupOptions: { input: { main: "index.html", stats: "stats.html" } },
  },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
