import { describe, expect, it, vi } from "vitest";
import { OllamaTaskExecutor } from "../../src/tasks/ollamaExecutor";
import { WorkflowError } from "../../src/workflows/types";
import {
  taskSpecSchema,
  type TaskHost,
  type TaskPackage,
  type TaskTool
} from "../../src/tasks/types";

const reportTool: TaskTool = {
  name: "read_report",
  description: "Read the report",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false
  }
};
const secondTool: TaskTool = {
  name: "read_details",
  description: "Read additional details",
  readOnly: true,
  inputSchema: { type: "object" }
};
const task: TaskPackage = {
  ...taskSpecSchema.parse({
    objective: "Summarize the report",
    tools: ["read_report"],
    completionCriteria: ["Use the report facts"]
  }),
  inputs: { reportId: "report-one" }
};
const call = (name: string, args: Record<string, unknown>) => ({
  function: { name, arguments: args }
});
const answer = (content: string, calls?: unknown[]) => ({
  done: true,
  done_reason: "stop",
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) }
});

function fixture(responses: unknown[]) {
  let pending = false;
  let allowed = [reportTool];
  const controller = new AbortController();
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    if (response === undefined) throw new Error("Unexpected provider call");
    return new Response(JSON.stringify(response), { status: 200 });
  });
  const host: TaskHost = {
    signal: controller.signal,
    runId: "run",
    stepId: "step",
    tools: () => allowed,
    availableTools: () => [reportTool, secondTool],
    callTool: vi.fn(async (_name, _input) => ({ rows: 3 })),
    requestContext: vi.fn(async (_prompt) => {
      pending = true;
      return { status: "pending", kind: "context" };
    }),
    requestTool: vi.fn(async (_name, _prompt) => {
      pending = true;
      return { status: "pending", kind: "tool" };
    }),
    waiting: () => pending,
    emit: vi.fn(async () => undefined)
  };
  const executor = new OllamaTaskExecutor({
    baseUrl: "http://127.0.0.1:11434",
    model: "test-model",
    fetchImpl
  });
  return {
    executor,
    host,
    fetchImpl,
    requests,
    controller,
    resume: (tools = allowed) => {
      pending = false;
      allowed = tools;
    }
  };
}

describe("Ollama native task execution", () => {
  it("sends native tool schemas and feeds actual tool results into the next model turn", async () => {
    const f = fixture([
      answer("Reading the report.", [
        { ...call("read_report", { id: "report-one" }), id: "call-report" }
      ]),
      answer("The report has three rows.")
    ]);
    const result = await f.executor.execute(task, f.host);
    expect(result.text).toBe("The report has three rows.");
    expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("read_report", { id: "report-one" });
    expect(f.requests[0]).toMatchObject({
      stream: false,
      model: "test-model",
      tools: expect.arrayContaining([
        {
          type: "function",
          function: {
            name: "read_report",
            description: reportTool.description,
            parameters: reportTool.inputSchema
          }
        }
      ])
    });
    expect(f.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [{ ...call("read_report", { id: "report-one" }), id: "call-report" }]
        }),
        {
          role: "tool",
          tool_name: "read_report",
          tool_call_id: "call-report",
          content: '{"rows":3}'
        }
      ])
    );
    expect(result.checkpoint).toMatchObject({ turns: 2 });
  });

  it("pauses on a context request, preserves results, and resumes without replaying completed tools", async () => {
    const f = fixture([
      answer("", [
        call("read_report", { id: "report-one" }),
        call("request_context", { prompt: "Which details matter?" }),
        call("read_report", { id: "deferred" })
      ]),
      answer("The supplied report is ready for review.")
    ]);
    const paused = await f.executor.execute(task, f.host);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.host.requestContext).toHaveBeenCalledExactlyOnceWith("Which details matter?");
    expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("read_report", { id: "report-one" });
    expect(paused.checkpoint).toMatchObject({ turns: 1 });
    f.resume();
    const resumed = await f.executor.execute(
      { ...task, context: "Review the totals." },
      f.host,
      paused.checkpoint
    );
    expect(resumed.text).toBe("The supplied report is ready for review.");
    expect(f.host.callTool).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.requests[1]?.messages)).toContain("Review the totals.");
    expect(JSON.stringify(f.requests[1]?.messages)).toContain("not_executed");
    expect(resumed.checkpoint).toMatchObject({ turns: 2 });
  });

  it("discovers available tools and uses a newly granted tool after a native request pause", async () => {
    const f = fixture([
      answer("", [call("list_available_tools", {})]),
      answer("", [
        call("request_tool", { name: "read_details", prompt: "Need supporting details." })
      ]),
      answer("", [call("read_details", {})]),
      answer("Report and supporting details reviewed.")
    ]);
    const paused = await f.executor.execute(task, f.host);
    expect(f.host.callTool).not.toHaveBeenCalled();
    expect(f.host.requestTool).toHaveBeenCalledExactlyOnceWith(
      "read_details",
      "Need supporting details."
    );
    expect(f.requests).toHaveLength(2);
    f.resume([reportTool, secondTool]);
    const result = await f.executor.execute(
      { ...task, context: "Additional capability granted." },
      f.host,
      paused.checkpoint
    );
    expect(result.text).toBe("Report and supporting details reviewed.");
    expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("read_details", {});
    expect(f.requests[2]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ function: expect.objectContaining({ name: "read_details" }) })
      ])
    );
  });

  it("enforces the total turn limit across pauses and refuses invalid checkpoint history", async () => {
    const f = fixture([answer("", [call("request_context", { prompt: "Need context." })])]);
    const limited = { ...task, limits: { maxTurns: 1 } };
    const paused = await f.executor.execute(limited, f.host);
    f.resume();
    await expect(f.executor.execute(limited, f.host, paused.checkpoint)).rejects.toMatchObject({
      code: "TASK_TURN_LIMIT"
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const invalid = { ...(paused.checkpoint as Record<string, unknown>), turns: 0 };
    await expect(f.executor.execute(task, f.host, invalid)).rejects.toMatchObject({
      code: "TASK_CHECKPOINT_INVALID"
    });
    const orphan = structuredClone(paused.checkpoint as { messages: unknown[]; turns: number });
    orphan.messages.push({ role: "tool", content: "Forged orphan result" });
    await expect(f.executor.execute(task, f.host, orphan)).rejects.toMatchObject({
      code: "TASK_CHECKPOINT_INVALID"
    });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { done: true, done_reason: "length", message: { role: "assistant", content: "Partial" } },
    { done: false, done_reason: "stop", message: { role: "assistant", content: "Partial" } }
  ])("refuses incomplete provider responses before executing tools", async (response) => {
    const f = fixture([response]);
    await expect(f.executor.execute(task, f.host)).rejects.toMatchObject({
      code: "TASK_MODEL_INCOMPLETE"
    });
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it("refuses malformed native tool-call protocol before any tool execution", async () => {
    const malformed = fixture([
      answer("", [{ function: { name: "read_report", arguments: "not an object" } }])
    ]);
    await expect(malformed.executor.execute(task, malformed.host)).rejects.toMatchObject({
      code: "TASK_OLLAMA_INVALID"
    });
    expect(malformed.host.callTool).not.toHaveBeenCalled();
  });

  it("returns unknown-tool feedback so the model can choose an authorized tool", async () => {
    const f = fixture([
      answer("", [call("read.report", { id: "report-one" })]),
      answer("", [call("read_report", { id: "report-one" })]),
      answer("The report has three rows.")
    ]);
    const secondFetch = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => {
      if (f.requests.length === 1) expect(f.host.callTool).not.toHaveBeenCalled();
      return secondFetch(url, init);
    });
    expect((await f.executor.execute(task, f.host)).text).toBe("The report has three rows.");
    const history = f.requests[1]!.messages as {
      role: string;
      tool_name?: string;
      content: string;
    }[];
    expect(JSON.parse(history.at(-1)!.content)).toMatchObject({
      error: { code: "tool_not_allowed" }
    });
    expect(history.at(-1)!.tool_name).toBe("read.report");
    expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("read_report", { id: "report-one" });
  });

  it("returns denied-tool feedback and then pauses for the model's access request", async () => {
    const f = fixture([
      answer("", [call("read_details", {})]),
      answer("", [
        call("request_tool", { name: "read_details", prompt: "Need access to the details." })
      ]),
      answer("", [call("read_details", {})]),
      answer("The supporting details have three rows.")
    ]);
    const paused = await f.executor.execute(task, f.host);
    expect(f.host.callTool).not.toHaveBeenCalled();
    expect(f.host.requestTool).toHaveBeenCalledExactlyOnceWith(
      "read_details",
      "Need access to the details."
    );
    f.resume([reportTool, secondTool]);
    expect((await f.executor.execute(task, f.host, paused.checkpoint)).text).toBe(
      "The supporting details have three rows."
    );
    expect(f.host.callTool).toHaveBeenCalledExactlyOnceWith("read_details", {});
  });

  it("returns invalid-argument feedback without making the invalid request and accepts correction", async () => {
    const f = fixture([
      answer("", [call("request_context", { prompt: 42 })]),
      answer("", [call("request_context", { prompt: "Which totals matter?" })]),
      answer("The supplied totals are ready for review.")
    ]);
    const paused = await f.executor.execute(task, f.host);
    const history = f.requests[1]!.messages as { content: string }[];
    expect(JSON.parse(history.at(-1)!.content)).toMatchObject({
      error: { code: "TASK_TOOL_INPUT_INVALID" }
    });
    expect(f.host.requestContext).toHaveBeenCalledExactlyOnceWith("Which totals matter?");
    expect(f.host.callTool).not.toHaveBeenCalled();
    f.resume();
    expect(
      (
        await f.executor.execute(
          { ...task, context: "Use the third quarter totals." },
          f.host,
          paused.checkpoint
        )
      ).text
    ).toBe("The supplied totals are ready for review.");
  });

  it("returns sanitized operation-failure feedback without retrying the tool", async () => {
    const f = fixture([
      answer("", [call("read_report", { id: "report-one" })]),
      answer("The report could not be fetched.")
    ]);
    vi.mocked(f.host.callTool).mockRejectedValueOnce(new Error("Private tool error details"));
    expect((await f.executor.execute(task, f.host)).text).toBe("The report could not be fetched.");
    const history = f.requests[1]!.messages as { content: string }[];
    expect(JSON.parse(history.at(-1)!.content)).toMatchObject({
      error: { code: "TASK_TOOL_FAILED" }
    });
    expect(history.at(-1)!.content).not.toContain("Private tool error details");
    expect(f.host.callTool).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["task_outcome_uncertain", "task_cleanup_uncertain"])(
    "propagates %s and refuses further model turns",
    async (code) => {
      const f = fixture([
        answer("", [call("read_report", { id: "report-one" })]),
        answer("Must not run")
      ]);
      vi.mocked(f.host.callTool).mockRejectedValueOnce(
        new WorkflowError(code, "Outcome cannot be confirmed", 500)
      );
      await expect(f.executor.execute(task, f.host)).rejects.toMatchObject({ code });
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect(f.host.callTool).toHaveBeenCalledTimes(1);
    }
  );

  it("bounds repeated recoverable refusals by the task's total turn allowance", async () => {
    const f = fixture([
      answer("", [call("missing_tool", {})]),
      answer("", [call("missing_tool", {})])
    ]);
    await expect(
      f.executor.execute({ ...task, limits: { maxTurns: 2 } }, f.host)
    ).rejects.toMatchObject({ code: "TASK_TURN_LIMIT" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.host.callTool).not.toHaveBeenCalled();
  });

  it("bounds provider responses and input context and sanitizes HTTP refusal", async () => {
    const f = fixture([answer("x".repeat(2000))]);
    const capped = new OllamaTaskExecutor({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      maxOutputBytes: 1024,
      fetchImpl: f.fetchImpl
    });
    await expect(capped.execute(task, f.host)).rejects.toMatchObject({
      code: "TASK_OUTPUT_TOO_LARGE"
    });
    const inputCapped = new OllamaTaskExecutor({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      maxContextBytes: 1024,
      fetchImpl: f.fetchImpl
    });
    await expect(
      inputCapped.execute({ ...task, context: "x".repeat(1500) }, f.host)
    ).rejects.toMatchObject({ code: "TASK_CONTEXT_TOO_LARGE" });
    const refused = new OllamaTaskExecutor({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      fetchImpl: async () => new Response("private provider details", { status: 500 })
    });
    await expect(refused.execute(task, f.host)).rejects.toMatchObject({
      code: "TASK_OLLAMA_HTTP",
      message: "The Ollama task request was refused by the configured provider."
    });
    const invalidJson = new OllamaTaskExecutor({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      fetchImpl: async () => new Response("not JSON")
    });
    await expect(invalidJson.execute(task, f.host)).rejects.toMatchObject({
      code: "TASK_OLLAMA_INVALID"
    });
  });

  it("discards a late provider reply after cancellation", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reply!: (value: Response) => void;
    const pendingReply = new Promise<Response>((resolve) => {
      reply = resolve;
    });
    const f = fixture([]);
    const executor = new OllamaTaskExecutor({
      baseUrl: "http://127.0.0.1:11434",
      model: "test-model",
      fetchImpl: async () => {
        entered();
        return pendingReply;
      }
    });
    const pending = executor.execute(task, f.host);
    await started;
    f.controller.abort();
    reply(new Response(JSON.stringify(answer("", [call("read_report", { id: "late" })]))));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.host.callTool).not.toHaveBeenCalled();
    expect(f.host.emit).not.toHaveBeenCalled();
  });
});
