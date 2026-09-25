import type { ConversationContext } from "../domain/context";
import { renderContextSystem } from "../domain/contextRendering";

export interface RoleMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SystemAndMessages {
  system: string;
  messages: RoleMessage[];
}

/**
 * Assembles the shared request shape ("base instructions, verified runtime facts,
 * role-specific instructions, a delimited task-data block, then context messages")
 * from a frozen ConversationContext. Each adapter maps `system`/`messages` onto its
 * own transport (a leading system message for Azure/Ollama, a separate `system`
 * field for Bedrock).
 */
export function buildSystemAndMessages(context: ConversationContext, role: "fast" | "deep"): SystemAndMessages {
  return {
    system: renderContextSystem(context.systemInstruction, context.roleInstructions[role], context.activeTasks),
    messages: context.messages.map((m) => ({ role: m.role, content: m.content }))
  };
}
