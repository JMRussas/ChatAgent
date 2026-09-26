import type { ChatTimelineEvent } from "../domain/types";

/** Pure snapshot projection, also embedded in the browser. No external runtime dependencies. */
export function deriveTurns(events: ChatTimelineEvent[]) {
  type Attempt = { id: string; phase: "fast" | "deep"; text: string; answerKind: string; state: string;
    queuedAt?: string; startedAt?: string; endedAt?: string; model?: string; reasoningEnabled: boolean; terminal: boolean; steps: string[] };
  type Turn = { messageId: string; userText: string; attempts: Attempt[]; routeDecision?: string };
  const turns: Turn[] = [];
  const seen = new Set<string | number>();
  for (const event of events) {
    const identity = event.sequence ?? event.eventId;
    if (identity !== undefined) { if (seen.has(identity)) continue; seen.add(identity); }
    if (!event.messageId) continue;
    if (event.type === "user") {
      if (!turns.some(t => t.messageId === event.messageId)) turns.push({ messageId: event.messageId, userText: event.text, attempts: [] });
      continue;
    }
    const turn = turns.find(t => t.messageId === event.messageId);
    if (!turn) continue;
    turn.routeDecision = event.routeDecision ?? turn.routeDecision;
    const phase = event.phase ?? (event.type === "refined" || event.type === "activity" ? "deep" : "fast");
    const id = event.attemptId ?? phase;
    let attempt = turn.attempts.find(a => a.id === id);
    if (!attempt) {
      attempt = { id, phase, text: "", answerKind: "substantive", state: "Working", terminal: false, reasoningEnabled: false, steps: [] };
      turn.attempts.push(attempt);
    }
    if (event.model) {
      attempt.model = event.model.model;
      attempt.reasoningEnabled = event.model.reasoningEnabled === true;
    }
    if (event.type === "activity" && !attempt.terminal) {
      const label = ({ queued: "Queued", running: "Working", thinking: "Working", generating: "Generating", retrying: "Retrying", failed: "Failed" } as Record<string, string>)[event.activity ?? ""] ?? "Working";
      attempt.state = label;
      attempt.steps.push(label);
      if (label === "Queued" || label === "Retrying") attempt.queuedAt ??= event.createdAtIso;
      else if (label === "Working") attempt.startedAt ??= event.createdAtIso;
      if (label === "Failed") { attempt.terminal = true; attempt.endedAt = event.createdAtIso; }
    }
    if (event.type === "delta" && !attempt.terminal) {
      attempt.text += event.text;
      if (attempt.state !== "Generating") attempt.steps.push("Generating");
      attempt.state = "Generating";
    }
    if (event.type === "provisional" || event.type === "refined") {
      // Full answer events are authoritative, including app-owned fallback acknowledgments.
      attempt.text = event.text;
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
      attempt.state = event.finishReason === "stop" ? "Complete" : event.finishReason === "length" ? "Incomplete — output limit reached" : event.finishReason === "cancelled" ? "Cancelled" : event.retrying ? "Retrying" : "Failed";
      attempt.steps.push(attempt.state);
    }
  }
  return turns.map(turn => {
    const latest = (phase: "fast" | "deep") => turn.attempts.filter(a => a.phase === phase).at(-1);
    const fast = latest("fast"), deep = latest("deep");
    const active = [fast, deep].filter(a => a && !a.terminal);
    const current = active.at(-1) ?? deep ?? fast;
    const hasDeepText = turn.attempts.some(a => a.phase === "deep" && a.text);
    const answers = turn.attempts.filter(a => a.text && !(a.answerKind === "acknowledgment" && hasDeepText))
      .sort((a, b) => (a.phase === "fast" ? 0 : 1) - (b.phase === "fast" ? 0 : 1)).map(a => ({
      id: a.id, text: a.text, label: a.phase === "deep" && turn.attempts.some(f => f.phase === "fast" && f.text && f.answerKind !== "acknowledgment") ? "Update" : "Answer",
      state: a.state
    }));
    return { ...turn, answers, current, active: current ? active.length > 0 : true, status: current?.state ?? "Working" };
  });
}
