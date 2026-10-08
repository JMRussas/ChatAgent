// Test preload for tests/unit/agentStalls.test.ts: a transcript read that never
// returns, standing in for filesystem I/O that cannot be interrupted. Opening still
// uses the real file; only the read never settles.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const realOpen = fs.promises.open;
fs.promises.open = async (path, flags) => {
  const handle = await realOpen(path, flags);
  return {
    stat: () => handle.stat(),
    read: () => new Promise(() => {}),
    close: () => handle.close()
  };
};
syncBuiltinESMExports();
