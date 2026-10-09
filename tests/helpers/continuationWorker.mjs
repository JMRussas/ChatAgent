// Owned stand-in for the coding worker: argv = scenario. It edits the worktree it was spawned in
// (its cwd), records its exit time outside the worktree and prints one scripted assistant line.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [scenario] = process.argv.slice(2);
const exitLog = join(process.cwd(), "..", "worker-exit.log");

process.stdin.resume();
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => run());

const say = () =>
  process.stdout.write(
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [] } }) + "\n"
  );
const done = (code) => {
  appendFileSync(exitLog, `${Date.now()}\n`);
  process.stdout.write("", () => process.exit(code));
};

function run() {
  say();
  switch (scenario) {
    case "edit":
      writeFileSync("src/a.ts", "export const a = 2;\n");
      mkdirSync("src", { recursive: true });
      writeFileSync("src/new.ts", "export const added = true;\n");
      rmSync("docs/x.md");
      return done(0);
    case "outside":
      writeFileSync("src/a.ts", "export const a = 3;\n");
      writeFileSync("package.json", '{"name":"changed"}\n');
      return done(0);
    case "none":
      return done(0);
    case "fail":
      writeFileSync("src/a.ts", "export const a = 9;\n");
      return done(3);
    default:
      return done(9);
  }
}
