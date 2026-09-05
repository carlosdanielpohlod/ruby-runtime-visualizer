import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  assetsInclude: ["**/*.rvtrace"],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
