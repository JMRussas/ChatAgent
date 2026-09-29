# 03 — Discovery, connections and account inventory

Status: implemented 2026-09-29. See [03 evidence](03-evidence.md) for the
acceptance-case-to-test mapping and validation results. Builds on current
model catalog; integrated after 02. No deployment, subscription activation,
billed health probe, or local model download was added by this task.

## Data model

Apply [resource policy](08-resource-policy.md): transport, execution scope, billing
components, quota and compute pools are independent per-binding metadata. Preserve
evidence/freshness and unknowns. V1 migration must not infer local/free from Ollama
or subscription entitlement from CLI. Implement RES-01/03/04/08 metadata fixtures.

Keep curated catalog preferences separate from runtime observations. Add
`src/models/connections.ts`, `inventory.ts` and `discovery/` adapters.

```ts
interface ModelObservation {
  bindingId: string;
  connectionId: string;
  model: string;
  revision?: string;
  observedAtIso: string;
  expiresAtIso: string;
  source: string;
  installed: "yes" | "no" | "unknown";
  access: "allowed" | "denied" | "unknown";
  health: "reachable" | "unreachable" | "unknown";
  apiCompatibility: string[];
  effectiveContextTokens?: number;
  effectiveOutputTokens?: number;
}
```

Observations cannot overwrite curated task preferences, billing policy or enabled
state. Metadata discovery is not proof of successful inference. A caller with list
permission but unknown invoke permission remains access unknown. Record last error
code separately; expose safe descriptions only.

Catalog v2 adds `connectionId` and explicit `apiKind` to entries. IDs are opaque
stable binding IDs, unique independently of human labels. Duplicate binding key is
connectionId + apiKind + model (+ CLI profile/adapter when applicable). Accept v1
through an in-memory migration using `default-<provider>` connections; do not rewrite
the user's file at startup. Existing env settings populate these default connections.

Connection configuration references credentials (environment variable names or
SDK credential-chain profiles), never embeds credential values. Public responses
expose connectionId, region/processing scope and apiKind, not secrets or login paths.
Initial apiKinds: mock, ollama-chat, azure-openai-chat, bedrock-converse, cli.
Additional Foundry protocols remain explicitly unsupported until an adapter exists.

## Discovery and refresh behavior

Implement `DiscoveryAdapter.discover(connection, signal): Promise<ModelObservation[]>`.
Use read-only provider listing/metadata APIs, verifying current official schemas:
Ollama installed models plus per-model metadata; Azure configured deployment
inventory via management credentials; Bedrock regional model/profile listings and
available access metadata. Missing cloud credentials produce an unavailable
connection result; they do not prevent local server startup.

Refresh on startup asynchronously and every 5 minutes; TTL 10 minutes. Use
`MODEL_DISCOVERY_INTERVAL_MS=300000`, `MODEL_DISCOVERY_TTL_MS=600000`,
`MODEL_DISCOVERY_TIMEOUT_MS=10000`, all validated positive integers. Limit four
metadata requests concurrently; one refresh per connection at a time. Failures
retain prior observations but never extend their expiration. Shutdown cancels
refresh requests/timers. A successful full listing marks disappeared models absent.

Expose GET /models with curated entries plus per-binding observation and readiness:
disabled, unsupported-adapter, unchecked, stale, denied, unavailable, or ready,
in that precedence. Ready requires fresh allowed access and reachable health plus
compatible implemented adapter. Do not fabricate permission evidence for cloud
models merely from listing them. Include discovered-but-uncurated entries separately;
they are disabled until curated. No public mutation/refresh endpoint is needed.

## Acceptance

- Unit fixtures for all three discovery adapters; no real cloud calls in tests.
- Two endpoints offering the same model produce separate bindings.
- V1 catalog migration preserves existing selections and emits valid v2 in memory.
- Partial provider failure leaves other connections usable; timeout obeys AbortSignal.
- Fake clock expiration makes ready become stale; a failed refresh cannot renew it.
- Listed-but-unauthorized models are not ready; disappeared models become unavailable.
- Discovery never overwrites preferences or enables new models; public JSON contains
  no credentials, including error paths.
- GET /models integration test includes a fresh ready local fixture and stale cloud fixture.

Live verification is opt-in read-only discovery per configured account. Without
credentials, report cloud live verification as not run; fixture tests still required.
