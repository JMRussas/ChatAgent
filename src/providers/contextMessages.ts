import { renderActiveTasksBlock, type ConversationContext } from "../app/contextBuilder";

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
  const systemParts = [context.systemInstruction, context.roleInstructions[role]];

  const tasksBlock = renderActiveTasksBlock(context.activeTasks);
  if (tasksBlock) systemParts.push(tasksBlock);

  return {
    system: systemParts.join("\n\n"),
    messages: context.messages.map((m) => ({ role: m.role, content: m.content }))
  };
}
