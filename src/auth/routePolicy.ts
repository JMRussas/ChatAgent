import type { Principal } from "./authenticator";

export type Access = "public" | "client" | "operator";
export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RouteRule {
  method: HttpMethod;
  /** Anchored; one path segment never matches more than one. */
  pattern: RegExp;
  access: Access;
  /** Stable label for tests and logs. */
  name: string;
}

const SEGMENT = "[^/]+";
const rule = (
  method: HttpMethod,
  path: string,
  access: Access,
  name = `${method} ${path}`
): RouteRule => ({
  method,
  pattern: new RegExp(
    `^${path
      .split("/")
      .map((part) => (part.startsWith(":") ? SEGMENT : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      .join("/")}$`
  ),
  access,
  name
});

/**
 * Every route the server answers, as of commit 2cecb5b plus the pairing routes of the
 * activation slice and later additions. The server's handlers are inventoried in
 * docs/implementation/14-local-authentication.md; this list does not detect a handler
 * added later, so wiring must share these definitions or check for drift.
 */
export const ROUTES: readonly RouteRule[] = [
  rule("GET", "/", "public"),
  rule("GET", "/pair", "public"),
  rule("POST", "/pair", "public"),
  // Reports only whether the caller's own credentials are valid.
  rule("GET", "/auth/session", "public"),

  rule("POST", "/briefings", "client"),
  rule("POST", "/document-tasks", "client"),
  rule("POST", "/sports/games", "client"),
  rule("GET", "/sports/team-directories", "client"),
  rule("POST", "/conversation-context/detach", "client"),
  rule("POST", "/conversation-context", "client"),
  rule("POST", "/sports/conversations", "client"),
  rule("POST", "/sports/teams", "client"),
  rule("POST", "/sports/results", "client"),
  rule("POST", "/sports/chat", "client"),
  rule("POST", "/messages", "client"),
  rule("POST", "/conversations/:conversationId/messages/:messageId/cancel", "client"),
  rule("GET", "/telemetry/latency", "client"),
  rule("GET", "/run-controls", "client"),
  rule("GET", "/run-controls/thinking", "client"),
  rule("GET", "/models", "client"),
  rule("GET", "/conversations/:conversationId/events", "client"),
  rule("GET", "/conversations/:conversationId/events/stream", "client"),
  rule("POST", "/v1/conversations/:conversationId/messages", "client"),
  rule("GET", "/v1/conversations/:conversationId/events/stream", "client"),
  rule("POST", "/v1/conversations/:conversationId/messages/:messageId/cancel", "client"),

  rule("POST", "/pair/reissue", "operator"),
  rule("GET", "/telemetry/evaluation", "operator"),
  rule("POST", "/briefings/config/reload", "operator"),
  rule("POST", "/roles/config/reload", "operator"),
  rule("GET", "/workers/document-tasks/status", "operator"),
  rule("POST", "/workers/document-tasks/restart", "operator"),
  rule("GET", "/workers/document-tasks/recovery-candidates", "operator"),
  rule("POST", "/workers/document-tasks/inspect", "operator"),
  rule("POST", "/workers/document-tasks/abandon", "operator"),
  rule("POST", "/workers/deep/run-once", "operator"),
  rule("GET", "/workers/deep/dead-letters", "operator"),
  rule("DELETE", "/workers/deep/dead-letters/:taskId", "operator"),
  rule("POST", "/workers/deep/dead-letters/:taskId/replay", "operator"),
  rule("GET", "/telemetry/dispatch", "operator"),
  rule("GET", "/telemetry/context", "operator"),
  rule("POST", "/routing/policy/tune", "operator"),
  rule("POST", "/routing/policy/set", "operator"),
  // Runtime windows for envelope pools that configuration already declared.
  rule("POST", "/routing/quota-envelopes/declare", "operator"),
  rule("GET", "/routing/quota-envelopes", "operator"),
  rule("GET", "/conversations/retention", "operator"),
  // Global, read-only view of a Hekate plan; not scoped to any principal's conversations.
  rule("GET", "/development/plans/:rootId/status", "operator"),
  // Read-only projection of one node's selected attempt; enabled only by opt-in wiring.
  rule("GET", "/development/plans/:rootId/nodes/:nodeId/progress", "operator"),
  // Existing prepared-plan dispatch host only: observation, launch and graceful stop.
  rule("GET", "/development/plans/:rootId/dispatch", "operator"),
  rule("POST", "/development/plans/:rootId/dispatch/launch", "operator"),
  rule("POST", "/development/plans/:rootId/dispatch/stop", "operator"),
  rule("DELETE", "/conversations/:conversationId/identity", "operator")
];

/** The rule for this exact method and path, or undefined (default deny). */
export function classifyRoute(method: string, pathname: string): RouteRule | undefined {
  // Literal routes win over parameterized ones (for example /conversations/retention).
  const matches = ROUTES.filter((r) => r.method === method && r.pattern.test(pathname));
  return matches.find((r) => !r.pattern.source.includes(SEGMENT)) ?? matches[0];
}

export type AccessDecision =
  { allow: true } | { allow: false; status: 401 | 403 | 404; code: string };

/**
 * Unknown routes are 401 to an unauthenticated caller, so nothing is enumerated,
 * and 404 once authenticated. Operator routes need the operator role.
 */
export function decideAccess(
  rule: RouteRule | undefined,
  principal: Principal | undefined
): AccessDecision {
  if (rule?.access === "public") return { allow: true };
  if (!principal) return { allow: false, status: 401, code: "UNAUTHENTICATED" };
  if (!rule) return { allow: false, status: 404, code: "NOT_FOUND" };
  if (rule.access === "operator" && !principal.roles.has("operator"))
    return { allow: false, status: 403, code: "OPERATOR_REQUIRED" };
  if (!principal.roles.has("client")) return { allow: false, status: 403, code: "CLIENT_REQUIRED" };
  return { allow: true };
}
