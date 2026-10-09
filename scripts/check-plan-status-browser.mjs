import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// Keep each verifier's browser evidence beside its owned worktree. Exclusive
// creation refuses reuse, so a later round cannot overwrite earlier evidence.
const output = join(dirname(process.cwd()), "browser-" + basename(process.cwd()));
mkdirSync(output);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/playwright/cli.js",
    "test",
    "tests/browser/planStatus.spec.ts",
    "--workers=1",
    "--reporter=list",
    "--output=" + output
  ],
  { windowsHide: true, shell: false, stdio: "inherit", timeout: 240_000 }
);
console.log(JSON.stringify({ browserEvidence: output, code: result.status }));
process.exitCode = result.status === 0 ? 0 : 1;
