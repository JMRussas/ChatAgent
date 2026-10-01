import type { RouteDecision } from "../domain/types";

export type ModelTask = "conversation" | "coding" | "summarization" | "extraction" | "reasoning";
export interface TaskRequirements {
  task: ModelTask;
  requiredCapabilities: ("tools" | "vision" | "structuredOutput")[];
  inputTokens: number;
  outputTokens: number;
}

// Task classification is independent of direct/deep routing. Keep these rules
// ordered: code > summary > extraction > reasoning > conversation (spec 04).
const coding = /\b(code|coding|debug(?:ging)?|refactor(?:ing)?|compiler|type[ -]?error)\b/i;
const stackTrace = /\b(?:stack\s*trace|traceback)\b|^\s*at\s+\S+.*:\d+:\d+\)?\s*$/im;
const codeFence = /`{3,}|^\s*~{3,}/m;
const summary = /\b(?:summari[sz]e|summari[sz]ing|summary)\b/i;
const extractFields = /\bextract\s+(?:(?:the|these|those|named|following)\s+)?fields\b/i;
const reasoning = /\b(?:compare|design|trade[ -]?offs?|analy[sz]e)\b/i;

// Mentioning JSON is not an output request (e.g. "What is JSON?"). Avoid
// inferring tool/vision requirements from words in ordinary conversation too.
const jsonOutput =
  /\b(?:return|respond|reply|output|emit|produce|format|summari[sz]e)\s+(?:(?:only|strictly|valid|a|an|the|result|answer|response|as|in)\s+)*json\b|\bgive\s+(?:me\s+)?(?:the\s+)?(?:answer\s+as\s+)?(?:valid\s+)?json\b/i;

export function classifyTask(text: string): ModelTask {
  if (codeFence.test(text) || coding.test(text) || stackTrace.test(text)) return "coding";
  if (summary.test(text)) return "summarization";
  if (extractFields.test(text) || jsonOutput.test(text)) return "extraction";
  if (reasoning.test(text)) return "reasoning";
  return "conversation";
}

/** Requirements for the answering phase; deep provisional responders use
 * conversation separately. Token counts come from the captured context preview,
 * never from guessed model-name limits. This function does not dispatch a call. */
export function classifyTaskRequirements(input: {
  text: string;
  routeDecision: RouteDecision;
  inputTokens: number;
  outputTokens: number;
}): TaskRequirements {
  for (const count of [input.inputTokens, input.outputTokens]) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Token requirements must be nonnegative safe integers");
  }
  const clarify = input.routeDecision === "clarify";
  return {
    task: clarify ? "conversation" : classifyTask(input.text),
    requiredCapabilities: !clarify && jsonOutput.test(input.text) ? ["structuredOutput"] : [],
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens
  };
}
