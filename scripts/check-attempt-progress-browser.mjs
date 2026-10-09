import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// Runs the fixed read-only status, run-controls and attempt-progress browser specs, headless
// and finite (one worker, no retries, a hard deadline). Evidence goes beside the owned
// worktree, in a directory this run creates exclusively under a unique name, so nothing is
// ever overwritten.
const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
const output = join(
  dirname(process.cwd()),
  `browser-progress-${basename(process.cwd())}-${stamp}-${process.pid}`
);
mkdirSync(output);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/playwright/cli.js",
    "test",
    "tests/browser/planStatus.spec.ts",
    "tests/browser/planRunControls.spec.ts",
    "tests/browser/attemptProgress.spec.ts",
    "--workers=1",
    "--retries=0",
    "--reporter=list",
    "--output=" + output
  ],
  { windowsHide: true, shell: false, stdio: "inherit", timeout: 240_000 }
);
console.log(JSON.stringify({ browserEvidence: output, code: result.status }));
process.exitCode = result.status === 0 ? 0 : 1;
