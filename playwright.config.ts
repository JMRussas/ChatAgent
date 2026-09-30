import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests/browser", testMatch: "**/*.spec.ts", workers: 1,
  timeout: 20000, expect: { timeout: 6000 }, use: { browserName: "chromium", trace: "retain-on-failure" },
  reporter: "list" });
