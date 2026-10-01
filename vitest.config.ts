import { defineConfig } from "vitest/config";

// Reproduced outside Vitest with scripts/diagnose-http-runtime.mjs. Do not
// conceal this native Windows HTTP crash by retrying tests or changing pools.
if (process.platform === "win32" && process.version === "v24.15.0") {
  throw new Error(
    "Node 24.15.0 on Windows crashes during HTTP/fetch tests (0xc0000409). " +
      "Use Node 24.21.0 from .node-version. See README.md; no tests were run."
  );
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
