import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openTaskMcpGateway } from "../../src/tasks/mcpGateway";
import type { TaskHost, TaskTool } from "../../src/tasks/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const tool = (name: string): TaskTool => ({
  name,
  description: name,
  readOnly: true,
  inputSchema: { type: "object" }
});
function fixture() {
  const controller = new AbortController();
  let waiting = false;
  const callTool = vi.fn(async () => ({ recorded: true }));
  const requestContext = vi.fn(async (prompt: string) => {
    waiting = true;
    return { prompt, status: "pending" };
  });
  const requestTool = vi.fn(async (name: string, prompt: string) => {
    waiting = true;
    return { name, prompt, status: "pending" };
  });
  const host: TaskHost = {
    signal: controller.signal,
    runId: randomUUID(),
    stepId: "agent-step",
    tools: () => [tool("read_report")],
    availableTools: () => [tool("read_report"), tool("write_report")],
    callTool,
    requestContext,
    requestTool,
    waiting: () => waiting,
    emit: async () => undefined
  };
  return { host, controller, callTool, requestContext, requestTool };
}
async function connect(host: TaskHost) {
  const gateway = await openTaskMcpGateway(host);
  cleanups.push(() => gateway.close());
  const client = new Client({ name: "native-task-test", version: "1.0.0" });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${gateway.token}` } }
    })
  );
  return { client, gateway };
}
describe("scoped task MCP gateway", () => {
  it("exposes granted tools and request controls without granting available tools", async () => {
    const f = fixture();
    const { client } = await connect(f.host);
    expect((await client.listTools()).tools.map((entry) => entry.name).sort()).toEqual([
      "list_available_tools",
      "read_report",
      "request_context",
      "request_tool"
    ]);
    expect(
      (await client.callTool({ name: "read_report", arguments: { report: "today" } }))
        .structuredContent
    ).toEqual({ recorded: true });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect((await client.callTool({ name: "write_report", arguments: {} })).isError).toBe(true);
    expect(f.callTool).toHaveBeenCalledTimes(1);
    const available = await client.callTool({ name: "list_available_tools", arguments: {} });
    expect(available.structuredContent).toEqual({ tools: f.host.availableTools() });
    expect(
      (
        await client.callTool({
          name: "request_tool",
          arguments: { name: "write_report", prompt: "May I save the report?" }
        })
      ).structuredContent
    ).toEqual({ name: "write_report", prompt: "May I save the report?", status: "pending" });
    expect(f.requestTool).toHaveBeenCalledOnce();
    expect((await client.callTool({ name: "read_report", arguments: {} })).isError).toBe(true);
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it("requires its private credential, exact loopback host and bounded request body", async () => {
    const f = fixture();
    const { gateway } = await connect(f.host);
    const send = (headers: Record<string, string>, body = "{}") =>
      fetch(gateway.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body
      });
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: "Bearer wrong" })).status).toBe(401);
    const auth = { authorization: `Bearer ${gateway.token}` };
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        gateway.url,
        { method: "POST", headers: { ...auth, host: "example.invalid" } },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        }
      );
      req.once("error", reject);
      req.end("{}");
    });
    expect(foreignHost).toBe(403);
    expect((await send({ ...auth, origin: "http://127.0.0.1" })).status).toBe(403);
    expect((await send(auth, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect(f.callTool).not.toHaveBeenCalled();
  });

  it("closes its connections when the owning task is aborted", async () => {
    const f = fixture();
    const { gateway } = await connect(f.host);
    f.controller.abort();
    await gateway.close();
    await expect(
      fetch(gateway.url, {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}` },
        body: "{}"
      })
    ).rejects.toThrow();
  });
});
