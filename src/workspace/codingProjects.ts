import { z } from "zod";
import {
  coordinationStatus,
  DevCoordinationError,
  MAX_RESPONSE_BYTES,
  parseStrictJson,
  planApiBase,
  planViewSchema,
  type LeafState,
  type PlanProgressState
} from "../integrations/hekate/devCoordination";
import { WorkflowError } from "../workflows/types";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const listingSchema = z.object({
  contractVersion: z.literal("plan-contract/v1"),
  plans: z
    .array(
      z.object({
        rootId: uuid,
        projectId: uuid,
        name: z.string().max(65536).nullable(),
        contractVersion: z.string(),
        supported: z.boolean()
      })
    )
    .max(100),
  nextAfterRootId: uuid.nullable()
});

export interface CodingWorkItem {
  id: string;
  name: string;
  kind: "coding";
  status: PlanProgressState | "invalid" | "unavailable";
  nextStep?: { id: string; name: string; status: LeafState };
  decision?: { id: string; name: string };
  progress?: { done: number; total: number };
  alsoAllocated?: number;
  accepted?: { id: string; ref: string };
  cancelled?: boolean;
  prepared: boolean;
  error?: string;
}
export interface CodingProjectRead {
  work: CodingWorkItem[];
  truncated: boolean;
  unavailable: number;
}
export interface CodingProjectOptions {
  preparedRoots?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const refusal = (code: string, message: string, status = 502) =>
  new WorkflowError(code, message, status);

/** Bounded discovery and observation only; a catalog association never authorizes execution. */
export async function readCodingProject(
  apiUrl: string,
  hekateProjectId: string,
  options: CodingProjectOptions = {}
): Promise<CodingProjectRead> {
  const project = uuid.safeParse(hekateProjectId);
  if (!project.success)
    throw refusal("CODING_INVALID_PROJECT", "A valid coding project is required.", 400);
  hekateProjectId = project.data;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_RESPONSE_BYTES
  )
    throw refusal("CODING_INVALID_OPTIONS", "Coding observation bounds are invalid.", 400);
  let base: string;
  try {
    base = planApiBase(apiUrl);
  } catch {
    throw refusal("CODING_INVALID_API", "A local coding plan API is required.", 400);
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const prepared = new Set((options.preparedRoots ?? []).map((root) => root.toLowerCase()));
  // One project read has one deadline and a total body allowance, including all root views.
  let remainingBytes = 16 * 1024 * 1024;
  const read = async (path: string): Promise<string> => {
    try {
      signal.throwIfAborted();
      const response = await fetch(`${base}/api/plan-contract/v1${path}`, {
        redirect: "error",
        signal,
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw refusal(
          "CODING_HTTP_ERROR",
          "The coding plan API could not return the requested state."
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw refusal("CODING_INVALID_RESPONSE", "Coding plan state is invalid.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          bytes += value.byteLength;
          remainingBytes -= value.byteLength;
          if (bytes > maxBytes || remainingBytes < 0)
            throw refusal("CODING_RESPONSE_TOO_LARGE", "Coding plan state exceeds its limit.");
          chunks.push(value);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw refusal(
        signal.aborted ? "CODING_ABORTED" : "CODING_UNAVAILABLE",
        signal.aborted
          ? "Coding plan observation was interrupted or timed out."
          : "The coding plan API is unavailable.",
        503
      );
    }
  };
  let listing: z.infer<typeof listingSchema>;
  try {
    listing = listingSchema.parse(
      parseStrictJson(await read(`/plans?projectId=${hekateProjectId}&limit=100`))
    );
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw refusal("CODING_INVALID_RESPONSE", "The coding project listing is invalid.");
  }
  const roots = listing.plans.filter(
    (root, index, all) =>
      root.projectId === hekateProjectId &&
      all.findIndex((row) => row.rootId === root.rootId) === index
  );
  const work: Array<CodingWorkItem | undefined> = new Array(roots.length);
  let unavailable = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= roots.length) return;
      const root = roots[index];
      const item: CodingWorkItem = {
        id: root.rootId,
        name: (root.name?.trim() || "Untitled coding plan").slice(0, 400),
        kind: "coding",
        status: "unavailable",
        prepared: prepared.has(root.rootId)
      };
      try {
        const raw = await read(`/plans/${root.rootId}`);
        const graph = planViewSchema.parse(parseStrictJson(raw));
        if (graph.projectId !== hekateProjectId || graph.rootId !== root.rootId) {
          unavailable++;
          continue;
        }
        const rootNode = graph.nodes.find(
          (node) => node.id === root.rootId && node.parentId === null
        );
        if (!rootNode) throw refusal("CODING_INVALID_RESPONSE", "The coding plan root is invalid.");
        let marker: unknown;
        try {
          marker = JSON.parse(rootNode.value ?? "");
        } catch {
          // Ordinary coding roots may contain prose instead of a JSON application marker.
        }
        if (
          marker &&
          typeof marker === "object" &&
          "kind" in marker &&
          marker.kind === "chatagent-workflow"
        )
          continue;
        item.name = (rootNode.name?.trim() || item.name).slice(0, 400);
        // Reuse the exact projection used by fetchCoordinationStatus, with one graph exchange.
        const state = coordinationStatus(raw, root.rootId, maxBytes);
        if (state.status === "invalid") {
          item.status = "invalid";
          item.error = "CODING_INVALID_PLAN";
        } else {
          item.status = state.progress.state;
          item.progress = {
            done: state.leaves.filter((leaf) => leaf.state === "accepted").length,
            total: state.leaves.length
          };
          item.cancelled =
            rootNode.work === "cancelled" ||
            (state.leaves.length > 0 && state.leaves.every((leaf) => leaf.state === "cancelled"));
          const review = state.leaves.find((leaf) => leaf.state === "review_pending");
          item.alsoAllocated = state.leaves.filter(
            (leaf) => leaf.state === "in_progress" && leaf.nodeId !== review?.nodeId
          ).length;
          if (review)
            item.decision = {
              id: review.nodeId,
              name: (review.name?.trim() || "Untitled step").slice(0, 400)
            };
          const accepted = state.leaves.find(
            (leaf) =>
              leaf.state === "accepted" &&
              leaf.acceptance?.decision === "accepted" &&
              !leaf.acceptanceHistorical
          );
          if (accepted)
            item.accepted = {
              id: accepted.nodeId,
              ref: `hekate:${root.rootId}:node:${accepted.nodeId}:revision:${accepted.contentRevision}`
            };
          const next =
            state.leaves.find((leaf) => leaf.state === "in_progress") ??
            state.leaves.find((leaf) => leaf.state === "review_pending") ??
            state.leaves.find((leaf) => leaf.state === "ready") ??
            state.leaves.find((leaf) => leaf.state !== "accepted" && leaf.state !== "cancelled");
          if (next)
            item.nextStep = {
              id: next.nodeId,
              name: (next.name?.trim() || "Untitled step").slice(0, 400),
              status: next.state
            };
        }
      } catch (error) {
        item.error =
          error instanceof WorkflowError
            ? error.code
            : error instanceof DevCoordinationError
              ? `CODING_${error.code}`
              : "CODING_INVALID_RESPONSE";
        unavailable++;
      }
      work[index] = item;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, roots.length) }, worker));
  return {
    work: work.filter((item): item is CodingWorkItem => item !== undefined),
    truncated: listing.nextAfterRootId !== null,
    unavailable
  };
}
