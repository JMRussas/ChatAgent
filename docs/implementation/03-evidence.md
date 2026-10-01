# Spec 03 implementation evidence

2026-09-29. Implements [03 — discovery, connections and account inventory](03-inventory.md)
and the RES-01/03/04/08 metadata fixtures from [08 resource policy](08-resource-policy.md)
named as spec 03's scope in [NEXT-HANDOFF](NEXT-HANDOFF.md). Dispatch/selection logic
that acts on this metadata (04), CLI execution (05), and the fuller admission/quota
enforcement described in 08-resource-policy.md (RES-02/05/06/07, 04+) remain separate.

## Contracts and behavior

- `src/models/connections.ts`: a `Connection` names one addressable way to reach a
  provider (`apiKind`, optional `baseUrl`/`region`, a credential _reference_ --
  an env var name, never a value) plus declared `resourceFacts` (execution scope,
  billing components), `quota`, and `compute` facts. These are always declared
  policy facts from explicit env vars (`<PROVIDER>_EXECUTION_SCOPE`,
  `<PROVIDER>_BILLING_COMPONENTS`, `<PROVIDER>_PROCESSING_REGION`); a `localhost`
  base URL or a provider name is never treated as evidence of locality or cost.
- `src/models/inventory.ts`: `ModelObservation` is per-binding discovery evidence
  (`installed`/`access`/`health`, freshness, safe `lastErrorCode` only). Readiness
  precedence is `disabled` > `unsupported-adapter` > `unchecked` > `stale` >
  `denied` > `unavailable` > `ready`, computed fresh per request, never cached.
  `InventoryStore` runs bounded-concurrency (`MODEL_DISCOVERY_TIMEOUT_MS`-scoped,
  `maxConcurrentRequests`-limited), per-connection single-flight refreshes; a
  failed refresh retains the prior observation without extending its expiry, and
  a successful full listing marks a previously-seen, now-disappeared binding as
  `installed: "no"`.
- `src/models/discovery/{ollamaDiscovery,azureDiscovery,bedrockDiscovery}.ts`: real
  discovery adapters (see "Adapter verification" below), not fixtures-only stubs.
  A missing-credentials connection throws a specific, named-variable error that
  `InventoryStore` swallows as "no observation," never crashing startup or other
  connections' refreshes.
- `src/config/modelCatalog.ts`: v1 catalog entries (naming only a `provider`) are
  migrated in memory to v2's `connectionId`/`apiKind`/binding-key shape via
  `apiKindForEntry`/`connectionIdForEntry`, deriving `default-<provider>`
  connections deterministically -- the catalog file is never rewritten.
  `describeModelCatalog` now computes real `availability` from live observations
  (falling back to `unchecked` when none exist, keeping existing callers that
  don't pass inventory data unchanged) and surfaces declared `resourceFacts`/
  `quota`/`compute` from the matching connection, never fabricated. Observations
  with no matching curated entry appear separately under `discovered`, always
  disabled -- discovery never auto-curates a model into routability.
- `src/server.ts`: `GET /models` is now a per-request live computation (a
  function, not a startup-time snapshot), fed by a real `InventoryStore` refreshed
  asynchronously on startup and every `MODEL_DISCOVERY_INTERVAL_MS`; discovery
  timers/in-flight requests are cancelled on shutdown alongside `ContextManager`.

## Adapter verification

Protocol facts checked 2026-09-29, against installed versions/current official docs:

- [Ollama API docs](https://github.com/ollama/ollama/blob/main/docs/api.md):
  `GET /api/tags` lists installed models; `POST /api/show` returns per-model
  metadata, with context length under `model_info["<family>.context_length"]`
  (not a fixed key -- varies by architecture, e.g. `llama.context_length`).
- [Ollama cloud docs](https://github.com/ollama/ollama/blob/main/docs/cloud.mdx):
  the _only_ documented signal distinguishing a cloud-backed model in local
  listings is the `:cloud` name suffix convention -- there is no separate API
  field. This is why execution scope is a **declared connection fact**, not
  something the Ollama discovery adapter infers from a model name.
- Azure deployment listing: the direct Azure OpenAI resource endpoint's own
  deployments-list API (`/openai/deployments?api-version=2023-03-15-preview`)
  was retired in 2024. Current listing requires the
  [ARM management plane, "Deployments - List"](https://learn.microsoft.com/en-us/rest/api/aiservices/accountmanagement/deployments/list)
  (api-version `2024-10-01`) and a separate AAD app-registration credential
  (client-credentials grant), distinct from `AZURE_OPENAI_API_KEY`.
- Bedrock: `@aws-sdk/client-bedrock`'s `ListFoundationModelsCommand` verified
  against the **installed package's own TypeScript definitions**
  (`node_modules/@aws-sdk/client-bedrock/dist-types/models/models_1.d.ts`):
  `ListFoundationModelsResponse.modelSummaries: FoundationModelSummary[]`, with
  `modelId`, `modelName?`, `providerName?`, `inferenceTypesSupported?`, and
  `modelLifecycle?.status` (`ACTIVE` | `LEGACY`). This is the Bedrock
  _control-plane_ client, distinct from `@aws-sdk/client-bedrock-runtime`
  (already a dependency, used for actual inference).

No live cloud discovery was run (no Azure ARM or AWS credentials configured in
this environment); those live acceptance cases are explicitly not run, not
faked. All three adapters have fixture-based unit tests using mocked
`fetch`/SDK clients -- no real network or cloud calls in the test suite.

## Acceptance mapping

| Spec 03 requirement                                                                                                                       | Test file and test names                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit fixtures for all three discovery adapters, no real cloud calls                                                                       | `discovery/ollamaDiscovery.test.ts`, `discovery/azureDiscovery.test.ts`, `discovery/bedrockDiscovery.test.ts` (all `fetch`/SDK-mocked)                                                                                                                                                        |
| Two endpoints offering the same model produce separate bindings                                                                           | `connections.test.ts`: `produces a distinct binding key per connection/apiKind/model combination`; `modelCatalog.test.ts`: `two connections offering the same model produce separate bindings`                                                                                                |
| V1 catalog migration preserves selections, emits valid v2 in memory, never rewrites the file                                              | `modelCatalog.test.ts`: `v1 -> v2: derives a stable connectionId/apiKind per entry without rewriting the catalog file (RES-08)`                                                                                                                                                               |
| Partial provider failure leaves other connections usable; timeout obeys AbortSignal                                                       | `inventory.test.ts`: `a partial provider failure leaves other connections usable`, `obeys the discovery timeout via AbortSignal`                                                                                                                                                              |
| Fake clock expiration makes ready become stale; a failed refresh cannot renew it                                                          | `inventory.test.ts`: `fake-clock expiration makes a ready binding become stale, and a failed refresh cannot renew it`, `a failed refresh retains the prior observation without extending its expiration`                                                                                      |
| Listed-but-unauthorized models are not ready; disappeared models become unavailable                                                       | `inventory.test.ts`: readiness-precedence suite (`unavailable when health is unreachable or access is merely unknown`), `a full successful listing marks a previously-seen, now-disappeared binding unavailable`                                                                              |
| Discovery never overwrites preferences/enables new models; public JSON has no credentials                                                 | `modelCatalog.test.ts`: `lists a discovered-but-uncurated model separately, always disabled, never auto-curated`, `reports active and unlisted models without exposing provider credentials or claiming health`; `connections.test.ts`: `references credentials by name only, never by value` |
| GET /models integration test: fresh ready local fixture + stale cloud fixture                                                             | `tests/integration/server.test.ts`: `serves fresh-ready local and stale cloud fixtures with distinct availability over GET /models (spec 03)`                                                                                                                                                 |
| RES-01: two Ollama bindings, verified local vs. cloud-backed, no locality/URL inference                                                   | `connections.test.ts`: `never infers execution scope or billing from a localhost URL or provider name (RES-08)`, `supports two bindings on localhost with different declared execution (RES-01 data-model requirement)`                                                                       |
| RES-03: remote self-hosted GPU + owned/rented compute kept separate from incremental billing                                              | `connections.test.ts`: `represents owned/rented compute separately from incremental billing components (RES-03)`; `modelCatalog.test.ts`: `surfaces declared execution/billing/compute facts from the connection, never inferred (RES-01/03)`                                                 |
| RES-04: missing/stale price vs. verified zero cost are different states, zero never a default                                             | `modelCatalog.test.ts`: `never coerces a missing price into zero, and distinguishes it from a verified zero-cost entry (RES-04)`                                                                                                                                                              |
| RES-08: public metadata distinguishes execution/billing/unknowns without leaking secrets; migration infers neither locality nor zero cost | `connections.test.ts`, `modelCatalog.test.ts` (RES-08-tagged cases above)                                                                                                                                                                                                                     |

Readiness precedence itself (`disabled` > `unsupported-adapter` > `unchecked` >
`stale` > `denied` > `unavailable` > `ready`) is exhaustively covered by
`inventory.test.ts`'s `computeReadiness precedence` suite (7 cases, one per state).

## Executed verification

**299 tests across 51 files passed** (up from 258/46 before this milestone --
34 new tests added: 7 connections, 16 inventory, 4 Ollama discovery, 4 Azure
discovery, 3 Bedrock discovery, plus extensions to `modelCatalog.test.ts` and
`server.test.ts`). Type checking (`npm run lint`) and `npm run build` passed.
`npm run verify:release` passed with `BENCH_MODE=simulate`
`BENCH_SIM_SEED=default-v1`: fixture evaluation and seeded benchmark comparison
both passed. The regenerated `reports/benchmark-summary.json` timestamp-only
diff was not retained (no benchmark logic changed). No live provider discovery,
deployment, or credential-bearing test was run in this environment; those
specific live acceptance cases are recorded here as **not run**, not simulated
as passing.

## Known limits carried forward

- Azure deployment discovery requires separately-configured ARM management
  credentials (`AZURE_ARM_*`), distinct from the existing `AZURE_OPENAI_API_KEY`
  data-plane key. Neither this session nor prior ones has these configured;
  Azure discovery has only been exercised against fixtures.
- Bedrock/Ollama access-permission evidence stays `unknown`/`allowed` per the
  documented reasoning in each adapter -- neither API can distinguish list
  permission from invoke permission, and a billed invoke probe is out of scope.
- Execution scope and billing components are populated only when explicitly
  declared via the new env vars; nothing infers them from defaults. This is
  intentional (RES-08), not an oversight -- fixed correctly rather than left
  as a TODO.
- `InventoryStore`/observations are in-memory only; a restart loses discovery
  state and re-discovers from a cold start, consistent with the rest of this
  prototype's persistence posture.
