import { z } from "zod";
import { BriefingCoordinator } from "./briefingCoordinator";
import { briefingProfileSchema } from "./briefingConfig";
import { briefingRequestSchema } from "./briefingPlan";
const userId = z.string().trim().min(1).max(200);
const commandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), userId, requestId: z.string().trim().min(1).max(200), request: briefingRequestSchema }).strict(),
  z.object({ op: z.literal("status"), userId, runId: z.string().uuid() }).strict(),
  z.object({ op: z.literal("cancel"), userId, runId: z.string().uuid(), taskId: z.string().uuid().optional() }).strict()
]);

/** Server-owned profile; clients cannot choose adapters, budgets or executable code. */
export class BriefingHttp {
  chatCapabilities() { return { league: this.profile.league, maxWindowHours: this.profile.maxCatchupHours }; }
  startChat(value: unknown) {
    const input = z.object({ userId, requestId: userId,
      kind: z.enum(["games", "news"]), league: z.enum(["NBA", "NFL"]),
      request: briefingRequestSchema
    }).strict().parse(value);
    if (input.league !== this.profile.league) throw new Error("SPORTS_LEAGUE_UNAVAILABLE");
    const request = briefingRequestSchema.parse(input.request);
    const from = request.lastSuccessful[request.team ? "team" : "league"];
    if (!from || Date.parse(request.now) > Date.now() || Date.parse(from) >= Date.parse(request.now) ||
      Date.parse(request.now) - Date.parse(from) > this.profile.maxCatchupHours * 3600000) throw new Error("SPORTS_WINDOW_INVALID");
    const tasks = this.profile.tasks.filter(task => task.scope === (request.team ? "team" : "league"))
      .map(task => ({ ...task, sources: task.sources.filter(source => source.kind === input.kind) })).filter(task => task.sources.length);
    if (!tasks.length) throw new Error("SPORTS_SOURCE_UNAVAILABLE");
    return this.coordinator.start(input.userId, input.requestId, request, { ...this.profile, tasks });
  }
  private profile: z.infer<typeof briefingProfileSchema>;
  reload?: () => Promise<{ version: string; changed: boolean }>;
  setProfile(profile: unknown) { this.profile = briefingProfileSchema.parse(profile); }
  constructor(private readonly coordinator: BriefingCoordinator, profile: unknown) {
    this.profile = briefingProfileSchema.parse(profile);
  }
  request(value: unknown): { status: number; body: unknown } {
    const command = commandSchema.parse(value);
    try {
      if (command.op === "start") return { status: 202, body: this.coordinator.start(command.userId, command.requestId, command.request, this.profile) };
      if (command.op === "status") return { status: 200, body: this.coordinator.snapshot(command.userId, command.runId) };
      return { status: 200, body: this.coordinator.cancel(command.userId, command.runId, command.taskId) };
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      const message = error instanceof Error ? error.message : "";
      const statuses: Record<string, number> = {
        BRIEFING_NOT_FOUND: 404, BRIEFING_TASK_NOT_FOUND: 404, BRIEFING_REQUEST_CONFLICT: 409,
        BRIEFING_CAPACITY: 429, BRIEFING_CLOSED: 503
      };
      const code = Object.hasOwn(statuses, message) ? message : message === "Briefing checkpoint is in the future"
        ? "INVALID_CHECKPOINT" : "BRIEFING_UNAVAILABLE";
      return { status: statuses[code] ?? (code === "INVALID_CHECKPOINT" ? 400 : 503), body: { code, error: "Briefing request failed" } };
    }
  }
  close() { this.coordinator.close(); }
}
