import { z } from "zod";

/**
 * Trusted startup inventory for the executive overview. Roots are operator-written
 * configuration, never discovered and never supplied by a browser. Every refusal carries
 * the stable code below and never echoes the configured value.
 */

export const EXECUTIVE_ROOTS_ERROR = "INVALID_EXECUTIVE_ROOTS";
export const EXECUTIVE_MAX_ROOTS = 8;
export const EXECUTIVE_LABEL_MAX = 60;
export const EXECUTIVE_GOAL_MAX = 200;

export class ExecutiveConfigError extends Error {
  readonly code = EXECUTIVE_ROOTS_ERROR;
  constructor() {
    super(EXECUTIVE_ROOTS_ERROR);
    this.name = "ExecutiveConfigError";
  }
}

export interface ExecutiveRoot {
  rootId: string;
  label: string;
  /** Operator-written intent. Displayed as configured, never as a verified result. */
  goal?: string;
}

// C0/C1 controls, line/paragraph separators and bidi controls.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f  ‪-‮⁦-⁩]/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bounded = (max: number) =>
  z
    .string()
    .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= max)
    .refine((value) => !UNSAFE.test(value));

const rootSchema = z
  .object({
    rootId: z.string().regex(GUID),
    label: bounded(EXECUTIVE_LABEL_MAX),
    goal: bounded(EXECUTIVE_GOAL_MAX).optional()
  })
  .strict();
const rootsSchema = z
  .array(rootSchema)
  .min(1)
  .max(EXECUTIVE_MAX_ROOTS)
  .refine((roots) => new Set(roots.map((root) => root.rootId)).size === roots.length);

/** Strict validation of an already parsed inventory; returns detached copies. */
export function parseExecutiveRoots(value: unknown): ExecutiveRoot[] {
  const parsed = rootsSchema.safeParse(value);
  if (!parsed.success) throw new ExecutiveConfigError();
  return parsed.data.map((root) => ({
    rootId: root.rootId,
    label: root.label,
    ...(root.goal === undefined ? {} : { goal: root.goal })
  }));
}

/**
 * Reads the two enabling variables. Not enabled (`HEKATE_EXECUTIVE_OVERVIEW` unset) leaves the
 * feature off. Enabled needs exactly "1", a valid inventory and a plan API URL.
 */
export function loadExecutiveOverviewConfig(
  env: NodeJS.ProcessEnv = process.env
): { roots: ExecutiveRoot[] } | undefined {
  const enable = env.HEKATE_EXECUTIVE_OVERVIEW;
  if (enable === undefined || enable === "") return undefined;
  if (enable !== "1" || !env.HEKATE_PLAN_API_URL) throw new ExecutiveConfigError();
  const raw = env.HEKATE_EXECUTIVE_ROOTS_JSON;
  if (raw === undefined || raw === "") throw new ExecutiveConfigError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExecutiveConfigError();
  }
  return { roots: parseExecutiveRoots(parsed) };
}
