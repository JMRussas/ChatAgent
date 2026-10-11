import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WorkflowError, type WorkflowContext, type WorkflowToolService } from "./types";
export type { WorkflowToolService } from "./types";

/** Caller identity is supplied by authenticated application wiring, never MCP arguments. */
export function createWorkflowMcpServer(service: WorkflowToolService, context: WorkflowContext) {
  const server = new Server(
    { name: "chatagent-workflows", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: context.principal.roles.has("operator")
      ? service.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: { ...tool.inputSchema, type: "object" as const },
          annotations: { readOnlyHint: tool.readOnly }
        }))
      : []
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (!context.principal.roles.has("operator"))
        throw new WorkflowError("OPERATOR_REQUIRED", "An operator credential is required.", 403);
      const value = await service.call(request.params.name, request.params.arguments ?? {}, {
        ...context,
        operationId: `${context.operationId}:${extra.requestId}`,
        signal: context.signal ? AbortSignal.any([context.signal, extra.signal]) : extra.signal
      });
      const structuredContent =
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { result: value ?? null };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: false
      };
    } catch (error) {
      const failure =
        error instanceof WorkflowError
          ? { code: error.code, message: error.message }
          : { code: "WORKFLOW_OPERATION_FAILED", message: "Workflow operation failed." };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(failure) }],
        structuredContent: failure,
        isError: true
      };
    }
  });
  return server;
}

/** Stateless MCP POST transport; disconnecting a client does not close the work service. */
export async function handleWorkflowMcp(
  service: WorkflowToolService,
  context: WorkflowContext,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown
) {
  const server = createWorkflowMcpServer(service, context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const close = () => {
    void server.close().catch(() => undefined);
  };
  res.once("close", close);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    res.removeListener("close", close);
    await server.close();
    throw error;
  }
}
