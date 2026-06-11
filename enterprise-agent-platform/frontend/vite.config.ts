import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../enterprise_agent_platform/static",
    emptyOutDir: false,
    target: "es2020",
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunk-[name].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.names[0] ?? "";
          return name.endsWith(".css") ? "styles.css" : "asset-[name][extname]";
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
