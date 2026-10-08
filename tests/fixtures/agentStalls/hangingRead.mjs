// Test preload for tests/unit/agentStalls.test.ts: a transcript read that never
// returns, standing in for filesystem I/O that cannot be interrupted. Opening still
// uses the real file; only the read never settles.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Opened handles are kept reachable until the process stops. Otherwise the garbage
// collector can close one first and Node prints a DEP0137 warning to stderr, which
// would make the test's stderr depend on collection timing.
const opened = [];
globalThis.__agentStallsHangingHandles = opened;

const realOpen = fs.promises.open;
fs.promises.open = async (path, flags) => {
  const handle = await realOpen(path, flags);
  opened.push(handle);
  return {
    stat: () => handle.stat(),
    read: () => new Promise(() => {}),
    close: () => handle.close()
  };
};
syncBuiltinESMExports();
