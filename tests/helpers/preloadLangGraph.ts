import { beforeAll } from "vitest";

/**
 * The langgraph planner engine imports its package on first use. A cold load
 * can take longer than a test's timeout, so pay for it in a hook with its own
 * limit. The first langgraph turn of a real server still pays this cost.
 */
export function preloadLangGraph(): void {
  beforeAll(async () => {
    await import("@langchain/langgraph");
  }, 60_000);
}
