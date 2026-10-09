// Owned stand-in for the Claude worker: argv = scenario, marker file, pid file.
// It records every spawn in the marker, may start a grandchild, and emits scripted stdout.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [scenario, marker, pidFile] = process.argv.slice(2);
appendFileSync(marker, "spawned\n");

const out = (text) => process.stdout.write(text);
const assistant = (id, text = "hello") =>
  JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }] } }) + "\n";
const hold = () => setInterval(() => undefined, 1000);
const finish = (code) => process.stdout.write("", () => process.exit(code));
const grandchild = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  writeFileSync(pidFile, JSON.stringify({ child: process.pid, grand: child.pid }));
};

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => run());

function run() {
  switch (scenario) {
    case "ids_repeat":
      out(assistant("m1") + assistant("m1") + assistant("m1", "again") + assistant("m2"));
      out('{"type":"user","message":{"content":"ignored"}}\n');
      out('{"type":"result","num_turns":3,"total_cost_usd":0.0123}\n');
      return finish(0);
    case "flood": {
      grandchild();
      let i = 0;
      setInterval(() => {
        if (i < 300) out(assistant(`m${i++}`));
      }, 5);
      return;
    }
    case "wait":
      grandchild();
      return void hold();
    case "noise":
      grandchild();
      setInterval(() => {
        out('{"type":"system"}\n'.repeat(50));
        process.stderr.write("x".repeat(100));
      }, 5);
      return;
    case "slow_ok":
      out(assistant("m1"));
      setTimeout(() => {
        out(assistant("m2"));
        finish(0);
      }, 600);
      return;
    case "exit_nonzero":
      out(assistant("m1"));
      return finish(3);
    case "result_bad":
      out(assistant("m1"));
      out('{"type":"result","num_turns":1.5,"total_cost_usd":-1}\n');
      return finish(0);
    case "privacy":
      out(assistant("m1", `echo ${prompt.trim()}`));
      out(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":"TOOL_SENTINEL"}]}}\n'
      );
      process.stderr.write("STDERR_SENTINEL\n");
      out('{"type":"result","num_turns":1,"total_cost_usd":0.5,"result":"RESULT_SENTINEL"}\n');
      return finish(0);
    case "unterminated":
      out(assistant("ok1"));
      out(assistant("ok2").trimEnd());
      return finish(0);
    default: {
      if (!scenario.startsWith("bad_")) return finish(9);
      grandchild();
      out(assistant("ok1"));
      const bad = {
        bad_malformed: "{not json}\n",
        bad_oversize: `{"type":"x","pad":"${"a".repeat(2000)}"}\n`,
        bad_missing_id: '{"type":"assistant","message":{}}\n',
        bad_dup_key: '{"type":"assistant","type":"assistant","message":{"id":"zz"}}\n',
        bad_id: '{"type":"assistant","message":{"id":"has space"}}\n',
        bad_utf8: Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])
      }[scenario];
      out(bad);
      return void hold();
    }
  }
}
