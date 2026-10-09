/** Frozen panel bounds; implementation follows in the prepared task. */
export const PLAN_STATUS_LIMITS = {
  maxLeaves: 200,
  maxTextChars: 200,
  deadlineMs: 10_000,
  maxResponseBytes: 1024 * 1024
} as const;

export function planStatusPanelHtml(): string {
  return "";
}

export function planStatusScript(): string {
  return "<script></script>";
}
