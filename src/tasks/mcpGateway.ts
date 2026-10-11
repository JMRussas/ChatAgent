import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleWorkflowMcp } from "../workflows/mcp";
import { WorkflowError, type WorkflowToolService } from "../workflows/types";
import type { TaskHost } from "./types";
import { dispatchTaskTool, taskTools } from "./taskTools";

const MAX_BODY_BYTES = 1024 * 1024;
export interface TaskMcpGateway {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}
/** One invocation's loopback capability; no global application tool registry is exposed. */
export async function openTaskMcpGateway(host: TaskHost): Promise<TaskMcpGateway> {
  host.signal.throwIfAborted();
  const token = randomBytes(32).toString("base64url");
  const credential = Buffer.from(`Bearer ${token}`);
  let expectedHost = "";
  const respond = (res: ServerResponse, status: number, code: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ code }));
  };
  const authorized = (req: IncomingMessage) => {
    const values = req.headersDistinct.authorization;
    if (values?.length !== 1 || values[0].length > 256) return false;
    const supplied = Buffer.from(values[0]);
    return supplied.length === credential.length && timingSafeEqual(supplied, credential);
  };
  const tools: WorkflowToolService = {
    get tools() {
      return taskTools(host);
    },
    call: (name, input) => dispatchTaskTool(host, name, input)
  };
  const server = createServer(async (req, res) => {
    if (
      req.headersDistinct.host?.length !== 1 ||
      req.headersDistinct.host[0] !== expectedHost ||
      req.headersDistinct.origin !== undefined
    ) {
      respond(res, 403, "LOCAL_REQUEST_REQUIRED");
      return;
    }
    if (!authorized(req)) {
      respond(res, 401, "UNAUTHENTICATED");
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      respond(res, 404, "NOT_FOUND");
      return;
    }
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      res.setHeader("connection", "close");
      respond(res, 413, "BODY_TOO_LARGE");
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > MAX_BODY_BYTES) {
          respond(res, 413, "BODY_TOO_LARGE");
          return;
        }
        chunks.push(value);
      }
      host.signal.throwIfAborted();
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
      );
      await handleWorkflowMcp(
        tools,
        {
          principal: {
            principalId: `task:${host.runId}:${host.stepId}`,
            roles: new Set(["client", "operator"]),
            via: "bearer"
          },
          operationId: randomUUID(),
          signal: host.signal
        },
        req,
        res,
        body
      );
    } catch (error) {
      if (!res.headersSent)
        respond(res, error instanceof WorkflowError ? error.status : 400, "TASK_REQUEST_FAILED");
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve, reject) => {
      host.signal.removeEventListener("abort", aborted);
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return closing;
  };
  const aborted = () => {
    void close().catch(() => undefined);
  };
  host.signal.addEventListener("abort", aborted, { once: true });
  if (host.signal.aborted) {
    await close();
    host.signal.throwIfAborted();
  }
  return { url: `http://${expectedHost}/mcp`, token, close };
}
