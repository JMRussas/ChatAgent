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
