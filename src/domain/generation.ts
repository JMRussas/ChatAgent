export type FinishReason = "stop" | "length" | "cancelled";
export interface GenerationResult { text: string; finishReason: FinishReason }
export interface GenerationMetadata { provider: string; model: string; reasoningEnabled?: boolean; bindingId?: string; task?: string;
  selection?: import("../routing/modelSelector").ModelSelection }
export interface GenerationControl {
  signal: AbortSignal;
  attemptId: string;
  onDelta: (text: string) => Promise<void>;
  onQueued?: (reason: "concurrency" | "quota") => Promise<void>;
}
export class GenerationError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message = code) {
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
  if (["ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ModelStreamErrorException"].includes(name))
    return new GenerationError("PROVIDER_UNAVAILABLE", true);
  if (name === "TimeoutError") return new GenerationError("PROVIDER_TIMEOUT", true);
  if (name === "ValidationException") return new GenerationError("PROVIDER_REQUEST_INVALID", false);
  if (error instanceof TypeError) return new GenerationError("PROVIDER_UNAVAILABLE", true);
  return new GenerationError("PROVIDER_ERROR", false);
}
export function httpGenerationError(status: number): GenerationError {
  return new GenerationError(status === 413 ? "CONTEXT_TOO_LARGE" : status === 401 || status === 403 ? "PROVIDER_AUTH" : status === 429 || status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REQUEST_INVALID", status === 429 || status >= 500);
}
