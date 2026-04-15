import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy Functions: browser calls Vite origin; forward to 7071 (CORS bypass).
      "/api": {
        target: "http://127.0.0.1:7071",
        changeOrigin: true
      },
      // Optional: proxy storage emulator blob paths if SAS points at 127.0.0.1:10000.
      "/devstoreaccount1": {
        target: "http://127.0.0.1:10000",
        changeOrigin: true
      }
    }
  }
});
