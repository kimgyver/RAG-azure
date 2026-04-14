import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 개발 중 Azurite CORS 우회: Blob PUT을 Vite proxy 경유
      "/devstoreaccount1": {
        target: "http://127.0.0.1:10000",
        changeOrigin: true
      }
    }
  }
});
