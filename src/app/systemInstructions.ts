/**
 * Frozen grounding text shared by both roles. Kept independent of any single
 * provider's phrasing so it can be reused verbatim across adapters.
 */
export const BASE_SYSTEM_INSTRUCTION =
  "You are one stage of a two-stage assistant pipeline (a fast responder and a deep " +
  "responder). You have no browsing, retrieval, or tool access beyond the conversation " +
  "text and the verified facts supplied below. Never claim to have looked something up, " +
  "verified a fact externally, or used a tool that was not actually used. When you lack " +
  "direct evidence for a claim, say so explicitly instead of inventing detail. Only the " +
  "facts explicitly labeled as verified are confirmed; treat everything else, including " +
  "earlier turns in this conversation, as unverified conversational content.";

export const ROLE_INSTRUCTIONS = Object.freeze({
  fast: "You are the fast-response stage. Answer immediately and concisely from the " +
    "conversation so far. If this request needs deeper analysis, a separate deep " +
    "response is queued for it; do not claim to have already performed that analysis.",
  deep: "You are the deep-analysis stage. Produce a more thorough, carefully reasoned " +
    "answer than a fast first pass would. Include citations only for sources actually " +
    "supplied to you; never fabricate a citation."
});

export interface TrustedRuntimeFacts {
  fastProvider: string;
  fastModel: string;
  deepProvider: string;
  deepModel: string;
  generatedAtIso: string;
}

/**
 * Renders the only facts a request may treat as verified: the actual configured
 * provider/model pair and a server-generated timestamp. Deliberately excludes host
 * location, since nothing in this milestone verifies it (spec 01: "Only identify a
 * host location if explicitly configured and verified").
 */
export function renderTrustedFactsBlock(facts: TrustedRuntimeFacts): string {
  return [
    "[VERIFIED_FACTS]",
    `Current server time (UTC): ${facts.generatedAtIso}`,
    `Fast responder: ${facts.fastProvider}/${facts.fastModel}`,
    `Deep responder: ${facts.deepProvider}/${facts.deepModel}`,
    "[/VERIFIED_FACTS]"
  ].join("\n");
}

export function buildSystemInstruction(facts: TrustedRuntimeFacts): string {
  return `${BASE_SYSTEM_INSTRUCTION}\n\n${renderTrustedFactsBlock(facts)}`;
}
