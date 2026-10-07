import { referenceSelectionsSchema } from "./referenceSelection";
import { runControlsSchema } from "./runControls";
import { rejectUnsupportedInputs } from "../providers/interfaces";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GenerationError } from "../domain/generation";
import type { ChatService } from "./chatService";
import type { ChatTimelineEvent } from "../domain/types";
import { sseFrame, type EventStreamRegistry } from "./eventStreams";
import { scopedOwnerKey } from "../auth/authenticator";

/**
 * Serialized event bytes one v1 poll may copy; a single larger event is still sent
 * alone. A local-use choice, not a measurement.
 */
export const V1_READ_BYTES = 256 * 1024;

const scopeSchema = z.object({
  accountId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200)
});
const submitSchema = scopeSchema.extend({
  referenceSelections: referenceSelectionsSchema.optional(),
  runControls: runControlsSchema.optional(),
  protocolVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  text: z.string().min(1),
  clientTimestampIso: z.string().datetime()
});

/** Additive wire projection; timeline sequences may have gaps (user records are omitted). */
export function projectTurnEvent(conversationId: string, event: ChatTimelineEvent) {
  if (event.type === "user" || !event.messageId || !event.phase || event.sequence === undefined)
    return undefined;
  return {
    protocolVersion: "1.0",
    conversationId,
    messageId: event.messageId,
    ...(event.answerReferences ? { answerReferences: event.answerReferences } : {}),
    ...(event.groundedAnswer ? { groundedAnswer: event.groundedAnswer } : {}),
    ...(event.contextBudget ? { contextBudget: event.contextBudget } : {}),
    taskId: event.taskId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    type: event.type === "provisional" || event.type === "refined" ? "answer" : event.type,
    phase: event.phase,
    activity:
      event.activity === "thinking" || event.activity === "generating" ? "running" : event.activity,
    answerRevision:
      event.type === "provisional" || event.type === "refined" ? event.sequence : undefined,
    ...(event.payloadResults?.length ? { payloadResults: event.payloadResults } : {}),
    text: event.text,
    finishReason: event.finishReason,
    retrying: event.retrying,
    answerKind: event.answerKind,
    processingStatus: event.processingStatus,
    model: event.model
      ? { ...event.model, bindingId: event.model.bindingId ?? event.phase }
      : undefined,
    usage: null,
    createdAtIso: event.createdAtIso
  };
}

/** Process-lifetime scope and replay only. Declared scope is not authentication. */
export function createProtocolV1Handler(service: ChatService, streams: EventStreamRegistry) {
  const runtimeId = randomUUID();
  const conversations = new Map<string, string>();
  // Internal ids this protocol allocated, so legacy routes can refuse them.
  const internalIds = new Set<string>();
  // Retirement releases the wire mapping with the identity it points at.
  service.addRetirementParticipant({
    forget: (internalId) => {
      for (const [key, id] of conversations) if (id === internalId) conversations.delete(key);
      internalIds.delete(internalId);
    }
  });
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    parseBody: () => Promise<unknown>,
    principalId: string
  ): Promise<boolean> => {
    const match = url.pathname.match(
      /^\/v1\/conversations\/([^/]+)\/(messages|events\/stream|messages\/([^/]+)\/cancel)$/
    );
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
    // Scope is per principal: the same declared account, project and conversation
    // under another principal is a different conversation.
    const key = JSON.stringify([principalId, scope.accountId, scope.projectId, conversationId]);
    let internalId = conversations.get(key);
    if (submit && !internalId) {
      if (conversations.size >= service.maxConversationIdentities)
        throw new GenerationError("CONVERSATION_CAPACITY", false);
      internalId = randomUUID();
      conversations.set(key, internalId);
      internalIds.add(internalId);
    }
    if (submit && body) {
      let result;
      try {
        result = await service.submitMessage({
          conversationId: internalId!,
          userId: scopedOwnerKey(principalId, [scope.accountId, scope.projectId]),
          messageId: body.messageId,
          runControls: body.runControls,
          referenceSelections: body.referenceSelections,
          text: body.text,
          timestampIso: body.clientTimestampIso
        });
      } catch (error) {
        // Admission failures before ownership is claimed must not consume a slot.
        if (
          !service.hasConversationIdentity(internalId!) &&
          conversations.get(key) === internalId
        ) {
          conversations.delete(key);
          internalIds.delete(internalId!);
        }
        // Admission refusal did not start a generation. An earlier terminal for
        // this message ID must not turn the refusal into an accepted response.
        if (error instanceof GenerationError && error.code === "TURN_CAPACITY") throw error;
        // A failed generation is still an accepted turn. Let clients consume its
        // partial text and terminal event instead of treating it as a transport failure.
        const timeline = await service.getTimeline(internalId!);
        const terminal = timeline
          .slice()
          .reverse()
          .find(
            (event) =>
              event.messageId === body.messageId &&
              event.phase === "fast" &&
              event.type === "terminal" &&
              !event.retrying
          );
        if (!(error instanceof GenerationError) || !terminal) throw error;
        json(res, 200, {
          protocolVersion: "1.0",
          runtimeId,
          conversationId,
          messageId: body.messageId,
          fastResponse: {
            provisionalReply: terminal.text,
            routeDecision:
              timeline.find((event) => event.messageId === body.messageId && event.type === "user")
                ?.routeDecision ?? "direct",
            processingStatus: "failed"
          }
        });
        return true;
      }
      json(res, 200, {
        protocolVersion: "1.0",
        runtimeId,
        conversationId,
        messageId: body.messageId,
        fastResponse: {
          provisionalReply: result.fastResponse.provisionalReply,
          routeDecision: result.fastResponse.analysis.routeDecision,
          processingStatus: result.fastResponse.processingStatus
        },
        deepTask: result.deepTask ? { taskId: result.deepTask.taskId } : undefined
      });
      return true;
    }
    if (cancel) {
      const messageId = z.string().uuid().parse(decodeURIComponent(match[3]));
      if (!internalId) {
        json(res, 404, { code: "MESSAGE_NOT_FOUND" });
        return true;
      }
      const result = await service.cancelMessage(internalId, messageId);
      json(res, result ? 200 : 404, result ?? { code: "MESSAGE_NOT_FOUND" });
      return true;
    }
    const rawCursor = url.searchParams.get("afterSequence") ?? "0";
    // A native EventSource reconnects to the original URL and reports the last event
    // it received in Last-Event-ID. Both are "deliver after N": the later one wins, so
    // a reconnect does not replay delivered events and a query skip is never undone.
    const lastEventIds = req.headersDistinct["last-event-id"];
    const cursorOf = (raw: string) =>
      /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
    const queryCursor = cursorOf(rawCursor);
    const headerCursor =
      lastEventIds === undefined
        ? 0
        : lastEventIds.length === 1
          ? cursorOf(lastEventIds[0])
          : undefined;
    if (queryCursor === undefined || headerCursor === undefined) {
      json(res, 400, { code: "INVALID_CURSOR" });
      return true;
    }
    let cursor = Math.max(queryCursor, headerCursor);
    if (url.searchParams.has("runtimeId") && url.searchParams.get("runtimeId") !== runtimeId) {
      json(res, 409, { code: "RUNTIME_RESTARTED" });
      return true;
    }
    // Admitted before any timeline read; a refused stream allocates no identity.
    const sse = streams.open(res);
    // Only the high-water mark is needed here; no events are copied to check it.
    let highWater: number;
    try {
      highWater = internalId ? await sse.read(() => service.lastTimelineSequence(internalId!)) : 0;
    } catch (error) {
      sse.close();
      throw error;
    }
    if (!sse.open) return true;
    if (cursor > highWater) {
      sse.close();
      json(res, 409, { code: "CURSOR_UNAVAILABLE" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform"
    });
    sse.write(sseFrame("ready", JSON.stringify({ protocolVersion: "1.0", runtimeId })));
    let boundId = internalId;
    await sse.start(
      async () => {
        // A stream may open before its first submission. It owns no identity slot.
        const currentId = conversations.get(key);
        // One stream follows one internal conversation. After retirement the wire ID
        // can map to unrelated work whose sequences restart, so the cursor is void.
        if (boundId && currentId !== boundId)
          throw new GenerationError("CONVERSATION_EXPIRED", false);
        boundId = currentId;
        if (!currentId) return;
        // Only events after the cursor are copied, within a per-poll byte budget; the
        // rest follow on later polls from the advanced cursor.
        for (const event of await service.getTimelineAfter(currentId, cursor, V1_READ_BYTES)) {
          const wire = projectTurnEvent(conversationId, event);
          if (wire) {
            const written = sse.write(sseFrame("turn", JSON.stringify(wire), wire.sequence));
            // Not written: the cursor stays, so this event is sent after drain.
            if (written === "closed" || written === "blocked") return;
            // A full write was still buffered: advance past it, then wait for drain.
            cursor = event.sequence!;
            if (written === "full") return;
          } else cursor = event.sequence!;
        }
      },
      () => res.destroy()
    );
    sse.every(100, () => void sse.pump());
    sse.heartbeat(15_000);
    return true;
  };
  return Object.assign(handle, {
    retentionStats: () => ({ conversations: conversations.size }),
    /** True for an internal id allocated here; legacy routes must not reach it. */
    isProtocolConversation: (id: string) => internalIds.has(id)
  });
}
