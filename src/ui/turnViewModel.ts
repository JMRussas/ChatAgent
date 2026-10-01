import type { ChatTimelineEvent } from "../domain/types";

/** Pure snapshot projection, also embedded in the browser. No external runtime dependencies. */
export function deriveTurns(events: ChatTimelineEvent[]) {
  type Attempt = {
    answerReferences?: ChatTimelineEvent["answerReferences"];
    payloadResults?: ChatTimelineEvent["payloadResults"];
    id: string;
    phase: "fast" | "deep";
    text: string;
    answerKind: string;
    state: string;
    queuedAt?: string;
    startedAt?: string;
    endedAt?: string;
    model?: string;
    provider?: string;
    bindingId?: string;
    selectionReasons?: string[];
    reasoningEnabled: boolean;
    terminal: boolean;
    steps: string[];
  };
  type Turn = {
    messageId: string;
    userText: string;
    attempts: Attempt[];
    routeDecision?: string;
    planAction?: string;
  };
  const turns: Turn[] = [];
  const seen = new Set<string | number>();
  for (const event of events) {
    const identity = event.sequence ?? event.eventId;
    if (identity !== undefined) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    if (!event.messageId) continue;
    if (event.type === "user") {
      if (!turns.some((t) => t.messageId === event.messageId))
        turns.push({ messageId: event.messageId, userText: event.text, attempts: [] });
      continue;
    }
    const turn = turns.find((t) => t.messageId === event.messageId);
    if (!turn) continue;
    turn.routeDecision = event.routeDecision ?? turn.routeDecision;
    if (
      event.capabilityPlan &&
      typeof event.capabilityPlan === "object" &&
      "action" in event.capabilityPlan
    )
      turn.planAction = String(event.capabilityPlan.action);
    const phase =
      event.phase ?? (event.type === "refined" || event.type === "activity" ? "deep" : "fast");
    const id = event.attemptId ?? phase;
    let attempt = turn.attempts.find((a) => a.id === id);
    if (!attempt) {
      attempt = {
        id,
        phase,
        text: "",
        answerKind: "substantive",
        state: "Working",
        terminal: false,
        reasoningEnabled: false,
        steps: []
      };
      turn.attempts.push(attempt);
    }
    // Attempts freeze at their first terminal event. The runtime may append one
    // app-owned acknowledgment after an empty fast failure; it is not a new answer.
    if (
      event.attemptId &&
      attempt.terminal &&
      !(
        event.type === "provisional" &&
        phase === "fast" &&
        attempt.state === "Failed" &&
        !attempt.text &&
        event.answerKind === "acknowledgment"
      )
    )
      continue;
    if (event.model) {
      attempt.model = event.model.model;
      attempt.provider = event.model.provider;
      attempt.bindingId = event.model.bindingId;
      attempt.selectionReasons = event.model.selection?.reasons;
      attempt.reasoningEnabled = event.model.reasoningEnabled === true;
    }
    if (event.type === "activity" && !attempt.terminal) {
      const label =
        (
          {
            queued: "Queued",
            running: "Working",
            thinking: "Working",
            generating: "Generating",
            retrying: "Retrying",
            failed: "Failed"
          } as Record<string, string>
        )[event.activity ?? ""] ?? "Working";
      attempt.state = label;
      attempt.steps.push(label);
      if (label === "Queued" || label === "Retrying") attempt.queuedAt ??= event.createdAtIso;
      else if (label === "Working") attempt.startedAt ??= event.createdAtIso;
      if (label === "Failed") {
        attempt.terminal = true;
        attempt.endedAt = event.createdAtIso;
      }
    }
    if (event.type === "delta" && !attempt.terminal) {
      attempt.text += event.text;
      if (attempt.state !== "Generating") attempt.steps.push("Generating");
      attempt.state = "Generating";
    }
    if (event.type === "provisional" || event.type === "refined") {
      // Full answer events are authoritative, including app-owned fallback acknowledgments.
      attempt.text = event.text;
      attempt.payloadResults = event.payloadResults;
      attempt.answerReferences = event.answerReferences;
      attempt.answerKind = event.answerKind ?? "substantive";
      if (!event.attemptId) {
        attempt.terminal = true;
        attempt.state = event.finishReason === "length" ? "Incomplete" : "Complete";
        attempt.endedAt = event.createdAtIso;
      }
    }
    if (event.type === "terminal") {
      attempt.terminal = true;
      attempt.endedAt = event.createdAtIso;
      attempt.state =
        event.finishReason === "stop"
          ? "Complete"
          : event.finishReason === "length"
            ? "Incomplete — output limit reached"
            : event.finishReason === "cancelled"
              ? "Cancelled"
              : event.retrying
                ? "Retrying"
                : "Failed";
      attempt.steps.push(attempt.state);
    }
  }
  return turns.map((turn) => {
    // This function is serialized into the page. Named local functions can
    // acquire a module-scoped __name helper under tsx and fail in the browser.
    const fast = turn.attempts.filter((a) => a.phase === "fast").at(-1);
    const deep = turn.attempts.filter((a) => a.phase === "deep").at(-1);
    const active = [fast, deep].filter((a) => a && !a.terminal);
    const current = active.at(-1) ?? deep ?? fast;
    const hasDeepText = turn.attempts.some((a) => a.phase === "deep" && a.text);
    const answers = turn.attempts
      .filter((a) => a.text && !(a.answerKind === "acknowledgment" && hasDeepText))
      .sort((a, b) => (a.phase === "fast" ? 0 : 1) - (b.phase === "fast" ? 0 : 1))
      .map((a) => ({
        id: a.id,
        text: a.text,
        answerReferences: a.answerReferences,
        payloadResults: a.payloadResults,
        label:
          a.phase === "deep" &&
          turn.attempts.some(
            (f) => f.phase === "fast" && f.text && f.answerKind !== "acknowledgment"
          )
            ? "Update"
            : "Answer",
        state: a.state,
        model: a.model,
        provider: a.provider,
        bindingId: a.bindingId,
        selectionReasons: a.selectionReasons
      }));
    const phaseOutcomes = [fast, deep]
      .filter((a) => a?.terminal && a.state !== "Complete" && a.state !== "Retrying")
      .map((a) => ({ phase: a!.phase, state: a!.state }));
    return {
      ...turn,
      answers,
      phaseOutcomes,
      current,
      active: current ? active.length > 0 : true,
      status: current?.state ?? "Working"
    };
  });
}
