import {
  cloneConversationContext,
  utf8ConservativeTokenCounter
} from "../../../app/contextBuilder";
import type { ConversationContext, HandoffViewContext } from "../../../domain/context";
import { renderContextSystem } from "../../../domain/contextRendering";
import { buildSystemAndMessages, type SystemAndMessages } from "../../../providers/contextMessages";
import type { PlanTaskContext } from "../planTask";
import type { BudgetKey, Composition } from "./compose";
import { ExactJsonError, member, readExactJson, sha256Hex, type JsonNode } from "./exactJson";

/**
 * The host slot for a composed handoff view (CA-ISSUE-003): attaches the view to the
 * fresh worker context that ChatAgent's H1 built for the committed task, as
 * delimited untrusted data rendered after every instruction. H1 stays exactly one
 * user message; the instruction fields are unchanged; nothing here calls a provider,
 * creates a conversation or launches a worker. `attachHandoffView` is the explicit
 * factory for a context carrying a view.
 */

export const HANDOFF_VIEW_SLOT = "handoff-view-slot.v0";
const VIEW_HEADER = "<<handoff-view consumer-view.v0>>\n";
// ChatAgent's estimator framing (src/app/contextBuilder.ts): 32 per request, 16 per message.
const REQUEST_OVERHEAD = 32n;
const MESSAGE_OVERHEAD = 16n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const BUDGET_KEYS: readonly BudgetKey[] = [
  "windowTokens",
  "maxHistoryTurns",
  "safetyTokens",
  "fastOutputTokens",
  "deepOutputTokens"
];

export type AttachRefusalCode = "view_mismatch" | "task_mismatch" | "CONTEXT_TOO_LARGE";
/** A refusal to attach; it carries a stable code and never content. */
export class AttachRefusal extends Error {
  constructor(readonly code: AttachRefusalCode) {
    super(code);
    this.name = "AttachRefusal";
  }
}
const refuse = (code: AttachRefusalCode): never => {
  throw new AttachRefusal(code);
};
const bytes = (text: string) => BigInt(utf8ConservativeTokenCounter.estimateBytes(text));
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Present and empty: a missing array is not mistaken for an empty one. */
const isEmptyArray = (value: unknown) => Array.isArray(value) && value.length === 0;
const sha = (text: string) => sha256Hex(Buffer.from(text, "utf8"));

/** The view's own fields, read losslessly from its canonical body. */
function readView(c: Composition) {
  const fail = () => refuse("view_mismatch");
  if (typeof c?.part !== "string" || !c.part.startsWith(VIEW_HEADER)) fail();
  const rest = c.part.slice(VIEW_HEADER.length);
  const tail = `\n<<viewDigest ${c.viewDigest}>>\n`;
  if (!rest.endsWith(tail)) fail();
  const body = rest.slice(0, rest.length - tail.length);
  // Canonical JSON is one line: string contents carry escaped newlines only.
  if (body.includes("\n") || sha(body) !== c.viewDigest) fail();
  if (!isCount(c.viewCost) || bytes(c.part) + MESSAGE_OVERHEAD !== BigInt(c.viewCost)) fail();
  let root: JsonNode;
  try {
    root = readExactJson(Buffer.from(body, "utf8"), { maxBytes: 16 << 20, maxDepth: 64 }).root;
  } catch (error) {
    if (error instanceof ExactJsonError) return fail();
    throw error;
  }
  const get = (node: JsonNode | undefined, key: string) =>
    node?.kind === "object" ? member(node, key) : undefined;
  const text = (node: JsonNode | undefined) => (node?.kind === "string" ? node.value : fail());
  if (
    text(get(root, "candidateDigest")) !== c.candidateDigest ||
    text(get(root, "reservationTokens")) !== c.reservationTokens ||
    text(get(get(root, "h1"), "suppliedSha256")) !== c.h1?.suppliedSha256
  )
    fail();
  const budget = get(root, "budget");
  if (budget?.kind !== "object" || budget.entries.length !== BUDGET_KEYS.length) fail();
  for (const key of BUDGET_KEYS) {
    const node = get(budget, key);
    if (node?.kind !== "number" || !node.integer || BigInt(node.lexeme) !== c.budget?.[key]) fail();
    // H1's accepted option limits: windowTokens and outputs >= 1, the rest >= 0.
    const value = c.budget[key];
    const least = key === "maxHistoryTurns" || key === "safetyTokens" ? 0n : 1n;
    if (typeof value !== "bigint" || value < least || value > MAX_SAFE) fail();
  }
  const instructions = get(get(root, "h1"), "instructions");
  return {
    system: text(get(instructions, "system")),
    fast: text(get(instructions, "fast")),
    deep: text(get(instructions, "deep"))
  };
}

/** The estimate of a plan-task context, recomputed from its fields, never trusted. */
function planTaskEstimate(context: ConversationContext, text: string, view?: { part: string }) {
  const { fast, deep } = context.roleInstructions;
  const role = bytes(fast) >= bytes(deep) ? fast : deep;
  const system = renderContextSystem(context.systemInstruction, role, [], null, [], [], view);
  return REQUEST_OVERHEAD + bytes(system) + MESSAGE_OVERHEAD + bytes(text) + MESSAGE_OVERHEAD;
}

/**
 * Attaches a verified composition's view to the H1 context it was composed with.
 * Refuses a tampered view (view_mismatch), a planTask that is not the composition's
 * H1 result or whose estimate was altered (task_mismatch), and a request that no
 * longer fits the composition's ORIGINAL budget once the block is rendered
 * (CONTEXT_TOO_LARGE).
 */
export function attachHandoffView(planTask: PlanTaskContext, c: Composition): ConversationContext {
  const digests = readView(c);
  const mismatch = () => refuse("task_mismatch");
  const context = planTask?.context;
  if (
    typeof planTask?.text !== "string" ||
    planTask.text !== c.h1.text ||
    planTask.suppliedSha256 !== c.h1.suppliedSha256 ||
    typeof context !== "object" ||
    context === null
  )
    mismatch();
  // Types first, so nothing malformed reaches a hash or a property read.
  const roles = context.roleInstructions;
  if (
    typeof context.systemInstruction !== "string" ||
    typeof roles !== "object" ||
    roles === null ||
    typeof roles.fast !== "string" ||
    typeof roles.deep !== "string" ||
    sha(context.systemInstruction) !== digests.system ||
    sha(roles.fast) !== digests.fast ||
    sha(roles.deep) !== digests.deep
  )
    mismatch();
  // H1's single package message and nothing else: every optional part present and empty.
  const messages: unknown = context.messages;
  if (!Array.isArray(messages) || messages.length !== 1 || !Object.hasOwn(messages, 0)) mismatch();
  const only: unknown = (messages as unknown[])[0];
  if (
    typeof only !== "object" ||
    only === null ||
    (only as { role?: unknown }).role !== "user" ||
    (only as { content?: unknown }).content !== planTask.text ||
    context.memory !== null ||
    !isEmptyArray(context.resolvedSources) ||
    !isEmptyArray(context.unavailableSources) ||
    context.omittedSourceCount !== 0 ||
    !isEmptyArray(context.activeTasks) ||
    !isEmptyArray(context.omittedActiveTaskIds) ||
    !isEmptyArray(context.includedTurnIds) ||
    !isEmptyArray(context.omittedTurnIds) ||
    context.handoffView !== undefined ||
    !isCount(context.estimatedInputTokens)
  )
    mismatch();
  const baseline = planTaskEstimate(context, planTask.text);
  if (BigInt(context.estimatedInputTokens) !== baseline) mismatch();
  const total = planTaskEstimate(context, planTask.text, { part: c.part });
  const b = c.budget;
  const reserve =
    (b.fastOutputTokens > b.deepOutputTokens ? b.fastOutputTokens : b.deepOutputTokens) +
    b.safetyTokens;
  const available = b.windowTokens - reserve;
  if (total > available || total > MAX_SAFE) refuse("CONTEXT_TOO_LARGE");
  const handoffView: HandoffViewContext = Object.freeze({
    part: c.part,
    viewDigest: c.viewDigest,
    candidateDigest: c.candidateDigest,
    viewCost: c.viewCost,
    renderedTokens: Number(total - baseline)
  });
  const copy = cloneConversationContext(context);
  const attached: ConversationContext = {
    ...copy,
    handoffView,
    estimatedInputTokens: Number(total),
    ...(copy.budgetUsage
      ? {
          budgetUsage: {
            ...copy.budgetUsage,
            windowTokens: Number(b.windowTokens),
            outputReserve: Number(reserve - b.safetyTokens),
            safetyReserve: Number(b.safetyTokens),
            availableInputTokens: Number(available),
            totalInputTokens: Number(total),
            handoffView: Number(total - baseline)
          }
        }
      : {})
  };
  return attached;
}

/** The provider request a worker would receive: the shared adapter seam, offline. */
export function handoffWorkerRequest(
  planTask: PlanTaskContext,
  c: Composition,
  role: "fast" | "deep"
): SystemAndMessages {
  return buildSystemAndMessages(attachHandoffView(planTask, c), role);
}
