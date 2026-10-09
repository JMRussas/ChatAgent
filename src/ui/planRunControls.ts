/** Frozen task bounds; implementation is the supervised conversation-controls task. */
export const PLAN_RUN_LIMITS = {
  deadlineMs: 10000,
  maxResponseBytes: 1024 * 1024,
  maxTextChars: 200
} as const;
export function planRunControlsHtml(): string {
  return "";
}
export function planRunControlsScript(): string {
  return "";
}
