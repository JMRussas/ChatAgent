import { z } from "zod";
import { formatWorkDigest, workDigestSchema, type WorkDigest } from "./workDigest";

export const workStates = [
  "needs_decision",
  "needs_attention",
  "running",
  "allocated",
  "ready",
  "completed",
  "cancelled"
] as const;
export const outstandingStates = workStates.slice(0, 5);
export const workStateSchema = z.enum(workStates);
const count = z.number().int().nonnegative();
export const listWorkSchema = z
  .object({
    scope: z
      .object({
        projectId: z.string().uuid().nullable(),
        projectsRead: count,
        source: z.enum(["explicit", "conversation", "all_active"]),
        state: z.array(workStateSchema).min(1).max(7)
      })
      .strict(),
    counts: z
      .object({
        read: count,
        needs_decision: count,
        needs_attention: count,
        running: count,
        allocated: count,
        ready: count,
        completed: count,
        cancelled: count
      })
      .strict(),
    source: z.object({ truncated: z.boolean(), errorCount: count }).strict(),
    selection: z.object({ matched: count, returned: count, omitted: count }).strict(),
    items: z.array(workDigestSchema).max(25),
    errors: z
      .array(
        z
          .object({
            projectId: z.string().uuid(),
            workId: z.string().max(200).nullable(),
            message: z.string().max(200)
          })
          .strict()
      )
      .max(20),
    errorsOmitted: count
  })
  .strict();
export type WorkList = z.infer<typeof listWorkSchema>;
export type WorkReadError = WorkList["errors"][number];

/** Counts refer only to observed rows; response selection never changes their meaning. */
export function projectWorkList(
  digests: readonly WorkDigest[],
  scope: WorkList["scope"],
  errors: readonly WorkReadError[],
  truncated: boolean,
  limit = 25
): WorkList {
  const counts = {
    read: digests.length,
    needs_decision: 0,
    needs_attention: 0,
    running: 0,
    allocated: 0,
    ready: 0,
    completed: 0,
    cancelled: 0
  };
  for (const digest of digests) counts[digest.state]++;
  const latest = (digest: WorkDigest) =>
    Math.max(
      Date.parse(digest.run?.updatedAt ?? "") || 0,
      Date.parse(digest.lastOutcome?.at ?? "") || 0
    );
  const matching = digests
    .filter((digest) => scope.state.includes(digest.state))
    .sort(
      (a, b) =>
        workStates.indexOf(a.state) - workStates.indexOf(b.state) ||
        latest(b) - latest(a) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
  const result: WorkList = {
    scope,
    counts,
    source: { truncated, errorCount: errors.length },
    selection: { matched: matching.length, returned: 0, omitted: matching.length },
    items: [],
    errors: errors
      .slice(0, 20)
      .map((error) => ({ ...error, message: error.message.slice(0, 200) })),
    errorsOmitted: Math.max(0, errors.length - 20)
  };
  // UTF-8 and escaped JSON are measured. Retain whole records, references and
  // counts; budget omissions are selection, not missing source observations.
  for (const digest of matching.slice(0, Math.max(1, Math.min(limit, 25)))) {
    result.items.push(digest);
    result.selection.returned = result.items.length;
    result.selection.omitted = matching.length - result.items.length;
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) {
      result.items.pop();
      result.selection.returned = result.items.length;
      result.selection.omitted = matching.length - result.items.length;
      break;
    }
  }
  return listWorkSchema.parse(result);
}

/** Whole-record text; header notices survive the existing chat display cut. */
export function formatWorkList(result: WorkList): string {
  const counts = workStates.map((state) => `${state}: ${result.counts[state]}`).join(" · ");
  const notices = [
    `Observed work: ${result.counts.read}. ${counts}.`,
    `Scope: ${result.scope.projectId ?? "all owned active projects"} (${result.scope.source}; ${result.scope.projectsRead} projects queried).`
  ];
  if (result.source.truncated || result.source.errorCount)
    notices.push("Counts are lower bounds: source observations are incomplete.");
  if (result.source.truncated)
    notices.push("Source truncated: existing observation limits or deadline omitted work.");
  if (result.source.errorCount)
    notices.push(
      `Source read errors: ${result.source.errorCount}${result.errorsOmitted ? `; ${result.errorsOmitted} error details omitted` : ""}.`
    );
  if (result.selection.omitted)
    notices.push(
      `Selection omitted: ${result.selection.omitted} matching items. Narrow by state or project, or call get_work_digest.`
    );
  let text = notices.join("\n"),
    shown = 0;
  for (const item of result.items) {
    const record = `\n\nWork ${item.id} · project ${item.projectId ?? "unknown"}\n${formatWorkDigest(item)}${item.truncated ? "\nDigest metadata abridged; get_work_digest provides fuller metadata and decision prompts. Use get_plan/get_run for saved definitions and results." : ""}`;
    if (text.length + record.length > 48000 - 160) break;
    text += record;
    shown++;
  }
  if (shown < result.items.length)
    text += `\n${result.items.length - shown} further items not shown. Narrow by state or project, or call get_work_digest.`;
  return text;
}
