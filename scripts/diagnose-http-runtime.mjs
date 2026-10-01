/**
 * Reproduces HTTP/fetch native crashes without application code or a test runner.
 * Each child owns its sockets and exits naturally. The parent reports native exit
 * codes and stops at the first failure; it never retries a failure into a pass.
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--child") {
  for (let cycle = 0; cycle < 20; cycle++) {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.write("data: hello\n\n");
      if (request.url !== "/stream") response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      writeSync(1, `cycle ${cycle}: fetch\n`);
      // Deliberately reproduce status-only consumers that leave the body unread.
      await fetch(base);
      const response = await fetch(`${base}/stream`);
      const reader = response.body.getReader();
      await reader.read();
      writeSync(1, `cycle ${cycle}: cancel\n`);
      await reader.cancel();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    writeSync(1, `cycle ${cycle}: closed\n`);
  }
} else {
  const iterations = Number(process.argv[2] ?? 25);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 200) {
    throw new Error("Usage: node scripts/diagnose-http-runtime.mjs [1-200]");
  }
  console.log(
    `Node ${process.version}, ${process.platform}/${process.arch}: ${iterations} children`
  );
  for (let attempt = 1; attempt <= iterations; attempt++) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
      maxBuffer: 65536
    });
    if (result.status !== 0 || result.error) {
      console.error(
        JSON.stringify(
          {
            attempt,
            exitCode: result.status,
            windowsStatus:
              process.platform === "win32" && result.status !== null
                ? `0x${(result.status >>> 0).toString(16).padStart(8, "0")}`
                : undefined,
            signal: result.signal,
            error: result.error?.message,
            lastPhase: result.stdout?.trim().split("\n").at(-1),
            stderr: result.stderr
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      break;
    }
    if (attempt === iterations)
      console.log(`Passed ${iterations} children (${iterations * 20} HTTP lifecycles).`);
  }
}
