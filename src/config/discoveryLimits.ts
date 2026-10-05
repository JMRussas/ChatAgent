import { z } from "zod";
export const discoveryLimitsSchema = z
  .object({
    maxModelsPerConnection: z.number().int().min(1).max(10000).default(1000),
    maxObservations: z.number().int().min(1).max(100000).default(4096),
    maxBytes: z.number().int().min(1).max(268435456).default(8388608),
    maxResponseBytes: z.number().int().min(1).max(67108864).default(4194304)
  })
  .strict();
export type DiscoveryLimits = z.infer<typeof discoveryLimitsSchema>;
export function loadDiscoveryLimits(env: NodeJS.ProcessEnv = process.env): DiscoveryLimits {
  const read = (name: string) => (env[name] === undefined ? undefined : Number(env[name]));
  return discoveryLimitsSchema.parse({
    maxModelsPerConnection: read("MODEL_DISCOVERY_MAX_MODELS"),
    maxObservations: read("MODEL_DISCOVERY_MAX_OBSERVATIONS"),
    maxBytes: read("MODEL_DISCOVERY_MAX_BYTES"),
    maxResponseBytes: read("MODEL_DISCOVERY_MAX_RESPONSE_BYTES")
  });
}
