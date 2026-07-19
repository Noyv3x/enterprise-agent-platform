import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    // Direct `vite build` is deliberately safe: it can only replace this local
    // scratch directory. `npm run build` supplies a unique same-filesystem
    // staging path and publishes it only after validation.
    outDir: ".vite-static-staging",
    emptyOutDir: true,
    target: "es2020",
    rollupOptions: {
      output: {
        entryFileNames: "app-[hash].js",
        chunkFileNames: "chunk-[name]-[hash].js",
        manualChunks(id) {
          // Keep the framework payload stable across frequent platform
          // releases so browsers can reuse it while application code changes.
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names[0] ?? "";
          return name.endsWith(".css") ? "styles-[hash].css" : "asset-[name]-[hash][extname]";
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765"
    }
  }
});
