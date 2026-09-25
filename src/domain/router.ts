import type { FastAnalysis, UserMessage } from "./types";

const DATA_KEYWORDS = ["latest", "current", "look up", "search", "cite", "source"];
const CLARIFY_KEYWORDS = ["this", "that", "it", "they", "do it"];

export function detectNeedsExternalData(text: string): boolean {
  const lower = text.toLowerCase();
  return DATA_KEYWORDS.some((k) => lower.includes(k));
}

export function detectNeedsClarification(text: string): boolean {
  const compact = text.trim();
  if (compact.length < 8) return true;

  const lower = compact.toLowerCase();
  return CLARIFY_KEYWORDS.some((k) => lower === k || lower.includes(` ${k} `));
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function analyzeFast(message: UserMessage): FastAnalysis {
  const correctedText = normalizeText(message.text);
  const needsExternalData = detectNeedsExternalData(correctedText);
  const needsClarification = detectNeedsClarification(correctedText);

  let routeDecision: FastAnalysis["routeDecision"] = "direct";
  const reasons: string[] = [];

  if (needsClarification) {
    routeDecision = "clarify";
    reasons.push("Prompt appears underspecified.");
  } else if (needsExternalData) {
    routeDecision = "deep";
    reasons.push("External information or sources requested.");
  } else {
    reasons.push("Can answer from in-context reasoning.");
  }

  const confidence = routeDecision === "clarify" ? 0.45 : routeDecision === "deep" ? 0.72 : 0.84;

  return {
    correctedText,
    needsExternalData,
    needsClarification,
    routeDecision,
    confidence,
    reasons
  };
}
