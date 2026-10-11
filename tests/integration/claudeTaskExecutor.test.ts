import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as filePrivacy from "../../src/auth/filePrivacy";
import { ClaudeTaskExecutor, type ClaudeTaskOptions } from "../../src/tasks/claudeExecutor";
import {
  taskSpecSchema,
  type TaskEvent,
  type TaskHost,
  type TaskPackage
} from "../../src/tasks/types";
import { WorkflowError } from "../../src/workflows/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const sdk = resolve("node_modules/@modelcontextprotocol/sdk/dist/esm");
const fixtureSource = `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),{pathToFileURL}=require('node:url');
let input=''; process.stdin.on('data',b=>input+=b); process.stdin.on('end',async()=>{
 const args=process.argv.slice(2),arg=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1]},configPath=arg('--mcp-config'),config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 const task=JSON.parse(input.slice(input.indexOf('Task package:\\n')+'Task package:\\n'.length)),mode=task.inputs.mode;
 const session=arg('--resume')||'11111111-2222-4333-8444-555555555555';
 const probe={args,cwd:process.cwd(),configPath,pid:process.pid};
 const save=()=>fs.writeFileSync('probe.json',JSON.stringify(probe));save();
 const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 emit({type:'system',session_id:session});
 emit({type:'assistant',session_id:session,message:{id:'msg-'+mode,content:[{type:'thinking',thinking:'PRIVATE_THINKING_CANARY'},{type:'text',text:'Working on the requested task.'}]}});
 process.stderr.write('PRIVATE_STDERR_CANARY');
 if(mode==='hold') { const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});probe.descendant=child.pid;save();setInterval(()=>{},1000);return; }
 if(mode==='malformed') {process.stdout.write('not JSON\\n');setInterval(()=>{},1000);return;}
 if(mode==='oversize') {process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);return;}
 if(mode==='is_error') {emit({type:'result',session_id:session,is_error:true,result:'PRIVATE_PROVIDER_CANARY',num_turns:1});return;}
 const {Client}=await import(pathToFileURL(path.join(${JSON.stringify(sdk)},'client/index.js')).href);
 const {StreamableHTTPClientTransport}=await import(pathToFileURL(path.join(${JSON.stringify(sdk)},'client/streamableHttp.js')).href);
 const client=new Client({name:'claude-process-fixture',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.task.url),{requestInit:{headers:config.mcpServers.task.headers}}));
 probe.tools=(await client.listTools()).tools.map(t=>t.name);
 let text,turns=1;
 if(mode==='request') {const r=await client.callTool({name:'request_context',arguments:{prompt:'Which report should I use?'}});text='Waiting for the report context.';turns=2;probe.request=r.structuredContent;}
 else {const r=await client.callTool({name:'read_report',arguments:{source:'current'}});probe.toolResult=r.structuredContent;text='The granted tool returned recorded: '+r.structuredContent.recorded+'.';
  const denied=await client.callTool({name:'admin_write',arguments:{}});probe.denied=denied.isError;}
 await client.close();save();
 emit({type:'result',session_id:session,is_error:false,result:text,num_turns:turns});
 if(mode==='nonzero') process.exitCode=4;
}).on('error',()=>process.exitCode=1);
`;

async function setup(options: Partial<ClaudeTaskOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "claude-task-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "native-fixture.cjs");
  await writeFile(script, fixtureSource);
  const workDir = join(directory, "work");
  const executor = new ClaudeTaskExecutor({
    executable: process.execPath,
    executableArgs: [script],
    workDir,
    model: "fixture-model",
    budgetUsd: 1,
    timeoutMs: 5000,
    ...options
  });
  const controller = new AbortController();
  let waiting = false;
  const events: Omit<TaskEvent, "at">[] = [];
  const callTool = vi.fn(async () => ({ recorded: true }));
  const requestContext = vi.fn(async (prompt: string) => {
    waiting = true;
    return { prompt, status: "pending" };
  });
  const host: TaskHost = {
    runId: randomUUID(),
    stepId: "agent-step",
    signal: controller.signal,
    tools: () => [
      {
        name: "read_report",
        description: "Read the report",
        readOnly: true,
        inputSchema: { type: "object" }
      }
    ],
    availableTools: () => [],
    callTool,
    requestContext,
    requestTool: async () => ({}),
    waiting: () => waiting,
    emit: async (event) => {
      events.push(event);
    }
  };
  const task = (mode: string): TaskPackage => ({
    ...taskSpecSchema.parse({
      objective: "Read the report",
      tools: ["read_report"],
      completionCriteria: ["Use the actual report"],
      limits: { maxTurns: 4 }
    }),
    inputs: { mode }
  });
  const cwd = join(workDir, host.runId, host.stepId);
  const probe = async () => JSON.parse(await readFile(join(cwd, "probe.json"), "utf8"));
  return {
    executor,
    host,
    controller,
    events,
    callTool,
    requestContext,
    task,
    probe,
    cwd,
    resume: () => {
      waiting = false;
    }
  };
}

describe("owned native Claude task executor", () => {
  it("refuses an unsecured workspace before creating credentials or starting tool work", async () => {
    const f = await setup();
    vi.spyOn(filePrivacy, "makePrivate").mockRejectedValue(new Error("PRIVATE_ACL_DETAILS"));
    await expect(f.executor.execute(f.task("normal"), f.host)).rejects.toMatchObject({
      code: "task_workspace_not_private",
      message: expect.stringContaining("could not be made private")
    });
    expect(f.callTool).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    expect(await readdir(f.cwd)).toEqual([]);
  });
  it("uses scoped native MCP calls, explicit restricted execution, and emits no thinking or stderr", async () => {
    const f = await setup();
    const result = await f.executor.execute(f.task("normal"), f.host);
    expect(result.text).toBe("The granted tool returned recorded: true.");
    expect(result.checkpoint).toEqual({
      sessionId: "11111111-2222-4333-8444-555555555555",
      turns: 1
    });
    expect(f.callTool).toHaveBeenCalledOnce();
    const observed = await f.probe();
    expect(observed.denied).toBe(true);
    expect(observed.tools).not.toContain("admin_write");
    expect(observed.args).toContain("--restricted");
    expect(observed.args).toContain("--strict-mcp-config");
    expect(observed.args[observed.args.indexOf("--tools") + 1]).toBe("");
    expect(observed.args[observed.args.indexOf("--allowedTools") + 1]).toBe("mcp__task__*");
    expect((await readdir(f.cwd)).some((name) => name.startsWith(".task-mcp-"))).toBe(false);
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE_THINKING_CANARY|PRIVATE_STDERR_CANARY/);
  }, 15000);

  it("resumes the native conversation in the same workspace with the remaining total turn allowance", async () => {
    const f = await setup();
    const first = await f.executor.execute(f.task("request"), f.host);
    expect(f.requestContext).toHaveBeenCalledOnce();
    expect(f.host.waiting()).toBe(true);
    const firstProbe = await f.probe();
    f.resume();
    const second = await f.executor.execute(
      { ...f.task("resume"), context: "The operator supplied the current report context." },
      f.host,
      first.checkpoint
    );
    const secondProbe = await f.probe();
    expect(secondProbe.cwd).toBe(firstProbe.cwd);
    expect(secondProbe.args[secondProbe.args.indexOf("--resume") + 1]).toBe(
      (first.checkpoint as { sessionId: string }).sessionId
    );
    expect(secondProbe.args[secondProbe.args.indexOf("--max-turns") + 1]).toBe("2");
    expect(second.checkpoint).toMatchObject({ turns: 3 });
    await expect(
      f.executor.execute(f.task("normal"), f.host, { ...(second.checkpoint as object), turns: 4 })
    ).rejects.toMatchObject({ code: "task_turn_limit" });
  }, 15000);

  it("waits for owned parent and descendant processes to stop on cancellation", async () => {
    const f = await setup();
    const pending = f.executor.execute(f.task("hold"), f.host);
    const rejected = expect(pending).rejects.toMatchObject({ code: "task_cancelled" });
    let observed: { pid: number; descendant: number } | undefined;
    await vi.waitFor(
      async () => {
        observed = await f.probe();
        expect(observed?.descendant).toBeTruthy();
      },
      { timeout: 8000 }
    );
    f.controller.abort();
    await rejected;
    for (const pid of [observed!.pid, observed!.descendant])
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
    expect((await readdir(f.cwd)).some((name) => name.startsWith(".task-mcp-"))).toBe(false);
  }, 15000);

  it.each([
    ["nonzero", "task_nonzero_exit"],
    ["malformed", "task_protocol_invalid"],
    ["oversize", "task_output_limit"],
    ["is_error", "task_protocol_invalid"]
  ])(
    "rejects %s without accepting a complete task result",
    async (mode, code) => {
      const f = await setup({ maxOutputBytes: mode === "oversize" ? 512 : 1048576 });
      await expect(f.executor.execute(f.task(mode), f.host)).rejects.toMatchObject({ code });
      expect((await readdir(f.cwd)).some((name) => name.startsWith(".task-mcp-"))).toBe(false);
      expect(JSON.stringify(f.events)).not.toContain("PRIVATE_PROVIDER_CANARY");
    },
    15000
  );

  it("preserves an uncertain persistence outcome and refuses success when cleanup cannot be confirmed", async () => {
    const uncertain = await setup();
    uncertain.host.emit = async () => {
      throw new WorkflowError("task_outcome_uncertain", "Task outcome could not be recorded", 503);
    };
    await expect(
      uncertain.executor.execute(uncertain.task("normal"), uncertain.host)
    ).rejects.toMatchObject({ code: "task_outcome_uncertain" });
    const cleanup = await setup({
      terminator: {
        terminate: async () => {
          throw Error("private cleanup details");
        }
      }
    });
    await expect(
      cleanup.executor.execute(cleanup.task("normal"), cleanup.host)
    ).rejects.toMatchObject({ code: "task_cleanup_uncertain" });
  }, 20000);
});
