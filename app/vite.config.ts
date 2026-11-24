import { defineConfig } from "vite";

export default defineConfig({
  define: { global: "globalThis" },
  build: { target: "es2022", chunkSizeWarningLimit: 2500 },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
