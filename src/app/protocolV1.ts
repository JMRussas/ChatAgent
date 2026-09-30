import { runControlsSchema } from "./runControls";
import { rejectUnsupportedInputs } from "../providers/interfaces";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GenerationError } from "../domain/generation";
import type { ChatService } from "./chatService";
import type { ChatTimelineEvent } from "../domain/types";

const scopeSchema = z.object({ accountId: z.string().min(1).max(200), projectId: z.string().min(1).max(200) });
const submitSchema = scopeSchema.extend({
  runControls: runControlsSchema.optional(),
  protocolVersion: z.literal("1.0"), messageId: z.string().uuid(),
  text: z.string().min(1), clientTimestampIso: z.string().datetime()
});

/** Additive wire projection; timeline sequences may have gaps (user records are omitted). */
export function projectTurnEvent(conversationId: string, event: ChatTimelineEvent) {
  if (event.type === "user" || !event.messageId || !event.phase || event.sequence === undefined) return undefined;
  return {
    protocolVersion: "1.0", conversationId, messageId: event.messageId,
    taskId: event.taskId, attemptId: event.attemptId, sequence: event.sequence,
    type: event.type === "provisional" || event.type === "refined" ? "answer" : event.type,
    phase: event.phase,
    activity: event.activity === "thinking" || event.activity === "generating" ? "running" : event.activity,
    answerRevision: event.type === "provisional" || event.type === "refined" ? event.sequence : undefined,
    ...(event.payloadResults?.length ? { payloadResults: event.payloadResults } : {}),
    text: event.text, finishReason: event.finishReason, retrying: event.retrying,
    answerKind: event.answerKind, processingStatus: event.processingStatus,
    model: event.model ? { ...event.model, bindingId: event.model.bindingId ?? event.phase } : undefined,
    usage: null, createdAtIso: event.createdAtIso
  };
}

/** Process-lifetime scope and replay only. Declared scope is not authentication. */
export function createProtocolV1Handler(service: ChatService) {
  const runtimeId = randomUUID();
  const conversations = new Map<string, string>();
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL, parseBody: () => Promise<unknown>): Promise<boolean> => {
    const match = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/(messages|events\/stream|messages\/([^/]+)\/cancel)$/);
    if (!match) return false;
    const conversationId = z.string().uuid().parse(decodeURIComponent(match[1]));
    const submit = req.method === "POST" && match[2] === "messages";
    const stream = req.method === "GET" && match[2] === "events/stream";
    const cancel = req.method === "POST" && !!match[3];
    if (!submit && !stream && !cancel) return false;
    const raw = submit ? await parseBody() : undefined;
    if (submit) rejectUnsupportedInputs(raw);
    const body = submit ? submitSchema.parse(raw) : undefined;
    const scope = scopeSchema.parse(body ?? Object.fromEntries(url.searchParams));
    const key = JSON.stringify([scope.accountId, scope.projectId, conversationId]);
    let internalId = conversations.get(key);
    if (!internalId) { internalId = randomUUID(); conversations.set(key, internalId); }
    if (submit && body) {
      let result;
      try {
        result = await service.submitMessage({ conversationId: internalId, userId: scope.accountId,
          messageId: body.messageId, runControls:body.runControls, text: body.text, timestampIso: body.clientTimestampIso });
      } catch (error) {
        // A failed generation is still an accepted turn. Let clients consume its
        // partial text and terminal event instead of treating it as a transport failure.
        const timeline = await service.getTimeline(internalId);
        const terminal = timeline.slice().reverse().find(event =>
          event.messageId === body.messageId && event.phase === "fast" && event.type === "terminal" && !event.retrying);
        if (!(error instanceof GenerationError) || !terminal) throw error;
        json(res, 200, { protocolVersion: "1.0", runtimeId, conversationId, messageId: body.messageId,
          fastResponse: { provisionalReply: terminal.text, routeDecision: timeline.find(event => event.messageId === body.messageId && event.type === "user")?.routeDecision ?? "direct", processingStatus: "failed" } });
        return true;
      }
      json(res, 200, { protocolVersion: "1.0", runtimeId, conversationId, messageId: body.messageId,
        fastResponse: { provisionalReply: result.fastResponse.provisionalReply,
          routeDecision: result.fastResponse.analysis.routeDecision, processingStatus: result.fastResponse.processingStatus },
        deepTask: result.deepTask ? { taskId: result.deepTask.taskId } : undefined });
      return true;
    }
    if (cancel) {
      const result = await service.cancelMessage(internalId, z.string().uuid().parse(decodeURIComponent(match[3])));
      json(res, result ? 200 : 404, result ?? { code: "MESSAGE_NOT_FOUND" }); return true;
    }
    const rawCursor = url.searchParams.get("afterSequence") ?? "0";
    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) {
      json(res, 400, { code: "INVALID_CURSOR" }); return true;
    }
    let cursor = Number(rawCursor);
    if (url.searchParams.has("runtimeId") && url.searchParams.get("runtimeId") !== runtimeId) {
      json(res, 409, { code: "RUNTIME_RESTARTED" }); return true;
    }
    const initial = await service.getTimeline(internalId);
    if (cursor > (initial.at(-1)?.sequence ?? 0)) { json(res, 409, { code: "CURSOR_UNAVAILABLE" }); return true; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" });
    res.write(`event: ready\ndata: ${JSON.stringify({ protocolVersion: "1.0", runtimeId })}\n\n`);
    let busy = false;
    const push = async () => {
      if (busy || res.destroyed) return;
      busy = true;
      try {
        for (const event of await service.getTimeline(internalId!)) {
          if ((event.sequence ?? 0) <= cursor) continue;
          const wire = projectTurnEvent(conversationId, event);
          if (wire) res.write(`id: ${wire.sequence}\nevent: turn\ndata: ${JSON.stringify(wire)}\n\n`);
          cursor = event.sequence!;
        }
      } finally { busy = false; }
    };
    const poll = setInterval(() => void push().catch(() => res.destroy()), 100);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    res.on("close", () => { clearInterval(poll); clearInterval(heartbeat); });
    await push(); return true;
  };
}
