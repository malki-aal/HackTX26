import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure UI logic (contract mapping, approval gate, navigation, research progress).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
