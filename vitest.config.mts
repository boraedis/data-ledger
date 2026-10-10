import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each database test file boots its own PGlite (WASM), runs every
    // migration and seeds it; with the files running in parallel that
    // first setup can take well over the 10s default on a busy machine.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
