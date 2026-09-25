export type PromptComplexity = "simple" | "moderate" | "complex";
export type AmbiguityLevel = "low" | "high";
export type PromptSizeBand = "small" | "medium" | "large";

export interface PromptClassification {
  complexity: PromptComplexity;
  ambiguity: AmbiguityLevel;
  externalDataNeeded: boolean;
  sizeBand: PromptSizeBand;
}

const COMPLEXITY_CUES = ["compare", "tradeoff", "design", "architecture", "multi-step", "evaluate", "benchmark"];
const EXTERNAL_DATA_CUES = ["latest", "current", "search", "look up", "cite", "source", "news"];
const AMBIGUOUS_CUES = ["do it", "same as before", "this one", "that one"];

function detectExternalDataNeeded(text: string): boolean {
  const lower = text.toLowerCase();
  return EXTERNAL_DATA_CUES.some((cue) => lower.includes(cue));
}

function detectAmbiguity(text: string): AmbiguityLevel {
  const trimmed = text.trim().toLowerCase();
  if (trimmed.length < 8) return "high";

  // Common standalone questions (who/what/when/where/why/how) are usually specific enough
  // even when they contain pronouns like "it" (for example: "what day is it?").
  if (/^(who|what|when|where|why|how)\b/.test(trimmed) && trimmed.length >= 10) {
    return "low";
  }

  if (AMBIGUOUS_CUES.some((cue) => trimmed === cue)) return "high";
  if (trimmed.length < 24 && AMBIGUOUS_CUES.some((cue) => trimmed.includes(cue))) return "high";
  return "low";
}

function detectComplexity(text: string): PromptComplexity {
  const lower = text.toLowerCase();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  const cueHits = COMPLEXITY_CUES.filter((cue) => lower.includes(cue)).length;

  if (cueHits >= 2 || wordCount > 60) return "complex";
  if (cueHits >= 1 || wordCount > 20) return "moderate";
  return "simple";
}

function detectSizeBand(text: string): PromptSizeBand {
  const length = text.trim().length;
  if (length < 80) return "small";
  if (length < 300) return "medium";
  return "large";
}

export function classifyPrompt(text: string): PromptClassification {
  return {
    complexity: detectComplexity(text),
    ambiguity: detectAmbiguity(text),
    externalDataNeeded: detectExternalDataNeeded(text),
    sizeBand: detectSizeBand(text)
  };
}
