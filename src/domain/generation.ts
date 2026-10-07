export type FinishReason = "stop" | "length" | "cancelled";
/**
 * Token counts the provider reported for one completed call in that call's own
 * response. Never an estimate, a text-derived count or a provider aggregate.
 */
export interface ProviderUsage {
  source: "provider-response";
  inputTokens: number;
  outputTokens: number;
}
export interface GenerationResult {
  text: string;
  finishReason: FinishReason;
  /** Present only when the completed response reported valid counts. */
  usage?: ProviderUsage;
}
const tokenCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
/**
 * Normalizes raw provider counts. Returns undefined unless both are non-negative
 * safe integers whose sum is also a safe integer.
 */
export function providerUsage(
  inputTokens: unknown,
  outputTokens: unknown
): ProviderUsage | undefined {
  if (
    !tokenCount(inputTokens) ||
    !tokenCount(outputTokens) ||
    !Number.isSafeInteger(inputTokens + outputTokens)
  )
    return undefined;
  return { source: "provider-response", inputTokens, outputTokens };
}
/** Revalidates usage crossing a boundary: its declared type alone is not trusted. */
export function validProviderUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  return usage.source === "provider-response"
    ? providerUsage(usage.inputTokens, usage.outputTokens)
    : undefined;
}
export interface GenerationMetadata {
  provider: string;
  model: string;
  reasoningEnabled?: boolean;
  bindingId?: string;
  task?: string;
  selection?: import("../routing/modelSelector").ModelSelection;
}
export interface GenerationControl {
  signal: AbortSignal;
  attemptId: string;
  onDelta: (text: string) => Promise<void>;
  onQueued?: (reason: "concurrency" | "quota") => Promise<void>;
}
export class GenerationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code
  ) {
    super(message);
    this.name = "GenerationError";
  }
}
export function normalizeGenerationError(error: unknown): GenerationError {
  if (error instanceof GenerationError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return new GenerationError("CANCELLED", false);
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (status) return httpGenerationError(status);
  if (
    [
      "ThrottlingException",
      "ServiceUnavailableException",
      "InternalServerException",
      "ModelStreamErrorException"
    ].includes(name)
  )
    return new GenerationError("PROVIDER_UNAVAILABLE", true);
  if (name === "TimeoutError") return new GenerationError("PROVIDER_TIMEOUT", true);
  if (name === "ValidationException") return new GenerationError("PROVIDER_REQUEST_INVALID", false);
  if (error instanceof TypeError) return new GenerationError("PROVIDER_UNAVAILABLE", true);
  return new GenerationError("PROVIDER_ERROR", false);
}
export function httpGenerationError(status: number): GenerationError {
  return new GenerationError(
    status === 413
      ? "CONTEXT_TOO_LARGE"
      : status === 401 || status === 403
        ? "PROVIDER_AUTH"
        : status === 429 || status >= 500
          ? "PROVIDER_UNAVAILABLE"
          : "PROVIDER_REQUEST_INVALID",
    status === 429 || status >= 500
  );
}
