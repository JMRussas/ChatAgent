import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleWorkflowMcp, type WorkflowToolService } from "../../src/workflows/mcp";
import { WorkflowError, type WorkflowContext } from "../../src/workflows/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sharedTools() {
  const plans = new Map<string, { id: string; name: string; revision: number }>();
  const call = vi.fn(async (name: string, input: unknown, context: WorkflowContext) => {
    if (!context.principal.roles.has("operator"))
      throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
    const args = input as { name?: unknown; id?: unknown };
    if (name === "create_plan") {
      if (typeof args.name !== "string" || !args.name.trim())
        throw new WorkflowError("INVALID_INPUT", "A plan name is required.");
      const plan = { id: randomUUID(), name: args.name, revision: 1 };
      plans.set(plan.id, plan);
      return plan;
    }
    if (name === "get_plan") {
      const plan = typeof args.id === "string" ? plans.get(args.id) : undefined;
      if (!plan) throw new WorkflowError("PLAN_NOT_FOUND", "No such plan.", 404);
      return plan;
    }
    if (name === "fail_private") throw Error("private backend connection secret");
    throw new WorkflowError("UNKNOWN_TOOL", "Unknown workflow tool.", 404);
  });
  const service: WorkflowToolService = {
    tools: [
      {
        name: "create_plan",
        description: "Create a plan",
        readOnly: false,
        inputSchema: { type: "object", properties: { name: { type: "string" } } }
      },
      {
        name: "get_plan",
        description: "Read a plan",
        readOnly: true,
        inputSchema: { type: "object", properties: { id: { type: "string" } } }
      },
      {
        name: "fail_private",
        description: "Exercise an unavailable operation",
        readOnly: false,
        inputSchema: { type: "object" }
      }
    ],
    call
  };
  return { service, call, plans };
}
const operator: WorkflowContext = {
  principal: {
    principalId: "local-operator",
    roles: new Set(["client", "operator"]),
    via: "bearer"
  },
  operationId: "direct-ui-operation"
};

async function connect(service: WorkflowToolService, context = operator) {
  const server: HttpServer = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await handleWorkflowMcp(
        service,
        { ...context, operationId: randomUUID() },
        req,
        res,
        JSON.parse(Buffer.concat(chunks).toString("utf8"))
      );
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No HTTP test address");
  const client = new Client({ name: "workflow-integration-client", version: "1.0.0" });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`))
  );
  return client;
}

describe("standard workflow MCP transport", () => {
  it("initializes, discovers shared tools, and reads the same saved plans as direct application calls", async () => {
    const { service, call } = sharedTools();
    const direct = (await service.call(
      "create_plan",
      { name: "Created through direct controls" },
      operator
    )) as { id: string };
    const client = await connect(service);
    expect(client.getServerVersion()?.name).toBe("chatagent-workflows");
    const discovered = await client.listTools();
    expect(
      discovered.tools.find((tool) => tool.name === "create_plan")?.annotations?.readOnlyHint
    ).toBe(false);
    expect(
      discovered.tools.find((tool) => tool.name === "get_plan")?.annotations?.readOnlyHint
    ).toBe(true);
    const read = await client.callTool({ name: "get_plan", arguments: { id: direct.id } });
    expect(read.isError).toBe(false);
    expect(read.structuredContent).toEqual(direct);
    const created = await client.callTool({
      name: "create_plan",
      arguments: { name: "Created through MCP" }
    });
    expect(created.isError).toBe(false);
    const saved = created.structuredContent as { id: string; name: string; revision: number };
    expect(saved.name).toBe("Created through MCP");
    expect(saved.revision).toBe(1);
    expect(await service.call("get_plan", { id: saved.id }, operator)).toEqual(saved);
    expect(call.mock.calls[2][2].principal).toEqual(operator.principal);
    expect(call.mock.calls[2][2].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns explicit tool failure and safe error information without claiming a mutation succeeded", async () => {
    const { service, plans } = sharedTools();
    const client = await connect(service);
    const invalid = await client.callTool({ name: "create_plan", arguments: { name: "" } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toEqual({
      code: "INVALID_INPUT",
      message: "A plan name is required."
    });
    expect(plans.size).toBe(0);
    const unavailable = await client.callTool({ name: "fail_private", arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toEqual({
      code: "WORKFLOW_OPERATION_FAILED",
      message: "Workflow operation failed."
    });
    expect(JSON.stringify(unavailable)).not.toContain("private backend connection secret");
  });

  it("does not grant operator access from MCP arguments or expose tools to an unauthorized context", async () => {
    const { service, call, plans } = sharedTools();
    const client = await connect(service, {
      principal: { principalId: "client", roles: new Set(["client"]), via: "bearer" },
      operationId: "client-operation"
    });
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({
      name: "create_plan",
      arguments: { name: "Forged authority", principal: operator.principal }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "OPERATOR_REQUIRED",
      message: "An operator credential is required."
    });
    expect(call).not.toHaveBeenCalled();
    expect(plans.size).toBe(0);
  });
});
