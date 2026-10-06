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
refresh requests/timers. A successful complete listing atomically replaces that connection's observations.
Disappeared bindings become unchecked: missing evidence never authorizes dispatch.
Arrays returned by custom discovery adapters declare a complete listing; partial
results must use `{ observations, complete: false }`, or throw. Partial, failed,
aborted, malformed or over-limit listings leave the previous snapshot and expiry
unchanged. No absent-model tombstones accumulate.

Discovery limits (validated at construction): 1000 models per listing, 4096 total
observations, 8 MiB of serialized retained observations, and 4 MiB of response
bytes. `MODEL_DISCOVERY_MAX_MODELS`, `MODEL_DISCOVERY_MAX_OBSERVATIONS`,
`MODEL_DISCOVERY_MAX_BYTES` and `MODEL_DISCOVERY_MAX_RESPONSE_BYTES` override them.
Ollama and Azure cap bodies before JSON parsing; Azure shares the response budget
across listing pages and rejects a still-paginated result after 20 pages. Bedrock
caps the SDK HTTP stream before deserialization. Ollama per-model metadata has a
separate response budget per request and stays best-effort. Custom adapters must
bound their own transport; inventory can reject their returned objects only after
the adapter has allocated them. These byte counts exclude heap overhead.

Expose GET /models with curated entries plus per-binding observation and readiness:
disabled, unsupported-adapter, unchecked, stale, denied, unavailable, or ready,
in that precedence. Ready requires fresh allowed access and reachable health plus
compatible implemented adapter. Do not fabricate permission evidence for cloud
models merely from listing them. Include discovered-but-uncurated entries separately;
they are disabled until curated. No public mutation/refresh endpoint is needed.

### Batch validation and refresh status (2026-10-06)

`InventoryStore` validates a complete listing at run time before it publishes
anything; publication itself stays the existing atomic per-connection replacement.

- The envelope is an array or a strict `{observations, complete}`; every row has
  bounded strings (binding ids up to 2048 characters, to fit composed keys), the
  installed/access/health enums, bounded compatibility lists, positive safe-integer
  capacities and an optional `lastErrorCode` constrained to an uppercase code
  format (not to the fixed list below, which applies to refresh statuses). A row
  of the wrong shape rejects the whole batch.
- Validation uses one sample of the injected clock, taken after the adapter
  returns (failure reporting may read it again, if that sample was unusable). Rows
  observed after it, rows naming another connection, duplicate binding ids in the batch, and
  bindings currently owned by another connection reject the batch. Timestamps may
  carry offsets but must denote real instants; they are stored in canonical UTC.
  A malformed expiry now rejects the batch instead of being published as
  observed-time expiry; an expiry before the observation is rejected, while one
  equal to it or already past is accepted as stale. Validity remains capped by the
  configured TTL.
- A partial listing, a timeout, shutdown or any rejection keeps the connection's
  previous observations and their expiry. A successful empty listing removes only
  that connection's observations. A late result after a timeout or shutdown is
  never published; the in-flight entry is held until the adapter settles, so one
  connection's discovery never overlaps itself, and a timeout is recorded when an
  adapter that ignores the abort finally settles.
- Each completed refresh records the latest attempt per connection (nothing is
  recorded after shutdown, for a connection with no adapter, or for an invalid
  connection id): outcome
  (succeeded, failed, partial), an owned failure code, completion time and the
  observation count. Codes come from a fixed list; an adapter error whose message
  is not exactly one of the known adapter codes is `DISCOVERY_FAILED`, so no raw
  text, URL or credential is kept. An unusable clock publishes nothing
  (`DISCOVERY_INVALID_CLOCK`); status recording never reads the clock after
  publication and may carry no completion time.
- Statuses are bounded by `MODEL_DISCOVERY_MAX_REFRESH_STATUSES` (default 256,
  at most 4096); the least recently updated connection's status is evicted first,
  and eviction never changes observations. A connection id that is empty or over
  256 characters is never sent to an adapter and leaves no status.
- `GET /models` (client route) adds
  `discoveryRefresh: {connections, retained, limit}`. It lists latest completed
  attempts, not real-time readiness.

Validation: 1,159 tests across 125 files, 34 browser tests, format and lint passed.
The sustained-memory gate passed 163 assertions with heap within tolerance,
including refresh-status churn. Independent review passed 51 inventory, retained
bounds and startup tests. No live provider calls.

## Acceptance

- Unit fixtures for all three discovery adapters; no real cloud calls in tests.
- Two endpoints offering the same model produce separate bindings.
- V1 catalog migration preserves existing selections and emits valid v2 in memory.
- Partial provider failure leaves other connections usable; timeout obeys AbortSignal.
- Fake clock expiration makes ready become stale; a failed refresh cannot renew it.
- Listed-but-unauthorized models are not ready; disappeared models become unchecked and remain ineligible.
- Discovery never overwrites preferences or enables new models; public JSON contains
  no credentials, including error paths.
- GET /models integration test includes a fresh ready local fixture and stale cloud fixture.

Live verification is opt-in read-only discovery per configured account. Without
credentials, report cloud live verification as not run; fixture tests still required.
