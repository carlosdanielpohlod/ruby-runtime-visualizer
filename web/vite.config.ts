import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Set VITE_BASE when the viewer is served from a sub-path (GitHub Pages).
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  assetsInclude: ["**/*.rvtrace"],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
