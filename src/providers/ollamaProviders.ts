import { GenerationError, httpGenerationError, type GenerationControl, type GenerationResult } from "../domain/generation";
import { AnswerCollector, parseFrame, streamLines, withGenerationDeadline } from "./streaming";
// Source: Ollama official API docs (github.com/ollama/ollama, docs/api.md),
// verified 2026-09-25. POST /api/chat request: {model, messages, stream, options}.
// Non-streaming response: {message: {role, content, thinking?}, done, done_reason}.
// (Previously used /api/generate's {prompt} request / {response, thinking, done_reason}
// response shape; migrated per spec 01 so role-based system/history messages can be sent.)
import { buildSystemAndMessages } from "./contextMessages";
import type { ConversationContext } from "../domain/context";
import type { DeepResult, DeepTask, UserMessage } from "../domain/types";
import type { DeepModelProvider, FastModelProvider } from "./interfaces";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaChatMessage[],
  temperature: number,
  timeoutMs: number,
  numPredict: number,
  control?: GenerationControl,
  think?: boolean
): Promise<GenerationResult> {
  return withGenerationDeadline("Ollama", timeoutMs, control, async (signal) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        stream: Boolean(control),
        ...(think === undefined ? {} : { think }),
        options: {
          temperature,
          num_predict: numPredict
        }
      }),
      signal
    });

    if (!response.ok) throw httpGenerationError(response.status);
    const collector = new AnswerCollector(control);
    if (!control) {
      const payload = await response.json();
      await collector.add(payload.message?.content ?? "");
      return collector.finish(payload.done_reason ?? "stop");
    }
    for await (const line of streamLines(response, signal)) {
      if (!line.trim()) continue;
      const frame = parseFrame(line);
      if (frame.error || typeof frame.done !== "boolean" || !frame.message || typeof frame.message !== "object") throw new GenerationError("INVALID_STREAM", false);
      await collector.add(frame.message.content ?? ""); // Never expose message.thinking.
      if (frame.done) return collector.finish(frame.done_reason);
    }
    throw new GenerationError("INVALID_STREAM", false);

  });
}

function legacyFastMessages(input: { message: UserMessage; correctedText: string; routeDecision: string }): OllamaChatMessage[] {
  const prompt = [
    "You are the fast-response layer for a dual-path assistant.",
    "Return concise, practical text.",
    `Route: ${input.routeDecision}`,
    `TimestampUTC: ${input.message.timestampIso}`,
    `Original: ${input.message.text}`,
    `Normalized: ${input.correctedText}`,
    "If route is deep, provide a short provisional response that says deeper analysis is in progress.",
    "If route is clarify, ask one concise clarifying question.",
    "If route is direct, provide a direct short answer.",
    "For temporal questions (day/date/time), assume the user means now at TimestampUTC unless they specify a timezone.",
    "Answer first, then optionally ask one concise timezone clarifier if needed."
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function legacyDeepMessages(normalizedPrompt: string): OllamaChatMessage[] {
  const prompt = [
    "You are the deep-analysis layer for a dual-path assistant.",
    "Produce a refined answer with concise reasoning and references if available.",
    `Prompt: ${normalizedPrompt}`
  ].join("\n");

  return [{ role: "user", content: prompt }];
}

function contextMessagesFor(context: ConversationContext, role: "fast" | "deep"): OllamaChatMessage[] {
  const { system, messages } = buildSystemAndMessages(context, role);
  return [{ role: "system", content: system }, ...messages];
}

export class OllamaFastProvider implements FastModelProvider {
  async thinkingOptions(): Promise<("on" | "off")[]> {
    return withGenerationDeadline("Ollama thinking options",5000,undefined,async signal => {
      const base=this.baseUrl.replace(/\/$/,"");
      const response=await fetch(`${base}/api/show`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:this.model}),signal});
      if(!response.ok) throw new GenerationError("THINKING_CONFIG_UNVERIFIED",false);
      const metadata=await response.json();
      const values=metadata.thinking?.values;
      return Array.isArray(values) ? (["on","off"] as const).filter(v=>values.includes(v === "on")) : [];
    });
  }
  async withThinking(value: "on" | "off"): Promise<FastModelProvider> {
    if(!(await this.thinkingOptions()).includes(value)) throw new GenerationError("THINKING_CONFIG_UNSUPPORTED",false);
    return new OllamaFastProvider(this.baseUrl,this.model,this.temperature,this.timeoutMs,this.numPredict,value === "on");
  }
  get metadata() { return { provider: "ollama", model: this.model, ...(this.think === undefined ? {} : { reasoningEnabled: this.think }) }; }
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly numPredict: number = 384,
    private readonly think?: boolean
  ) {}

  async createProvisionalReply(input: {
    message: UserMessage;
    correctedText: string;
    routeDecision: "direct" | "deep" | "clarify";
    context?: ConversationContext;
  }, control?: GenerationControl): Promise<GenerationResult> {
    const messages = input.context ? contextMessagesFor(input.context, "fast") : legacyFastMessages(input);

    return callOllamaChat(this.baseUrl, this.model, messages, this.temperature, this.timeoutMs, this.numPredict, control, this.think);
  }
}

export class OllamaDeepProvider implements DeepModelProvider {
  get metadata() { return { provider: "ollama", model: this.model, ...(this.think === undefined ? {} : { reasoningEnabled: this.think }) }; }
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly temperature: number,
    private readonly timeoutMs: number = 10_000,
    private readonly numPredict: number = 768,
    private readonly think?: boolean
  ) {}

  async resolveDeepTask(input: DeepTask, control?: GenerationControl): Promise<DeepResult> {
    const start = Date.now();
    const messages = input.context ? contextMessagesFor(input.context, "deep") : legacyDeepMessages(input.normalizedPrompt);

    const result = await callOllamaChat(this.baseUrl, this.model, messages, this.temperature, this.timeoutMs, this.numPredict, control, this.think);

    return {
      taskId: input.taskId,
      finalReply: result.text,
      finishReason: result.finishReason,
      confidence: 0.8,
      citations: [],
      totalLatencyMs: Date.now() - start
    };
  }
}
