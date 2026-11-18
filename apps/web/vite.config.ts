import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development the page talks to apps/api on :8790 (run `npm run dev -w @sealed-scouts/api`).
const api = process.env.API_URL ?? "http://127.0.0.1:8790";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": api, "/health": api } },
  build: { target: "es2022", sourcemap: false },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
