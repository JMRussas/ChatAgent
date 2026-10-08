import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { windowsPosixReplace } from "../../src/auth/localIdentity";

// The replacement helper's process lifetime, on a fake child process. A helper stopped
// at its deadline has no valid result, even when it had already printed one and then
// closes cleanly before the exit wait ends.
describe("windowsPosixReplace deadline", () => {
  it("rejects a helper killed at the deadline that then closes cleanly with a printed result", async () => {
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      kill() {
        kills++;
        setTimeout(() => child.emit("close", 0), 10);
        return true;
      }
    });
    const start = () => {
      queueMicrotask(() => child.stdout.emit("data", Buffer.from("rc=0\r\n")));
      return child;
    };
    const result = await windowsPosixReplace("a", "b", {
      spawn: start,
      timeoutMs: 50,
      exitMs: 1000
    }).then(
      (rc) => `rc:${rc}`,
      (e: Error) => e.name
    );
    expect(result).toBe("Error");
    expect(kills).toBe(1);
  });
});
