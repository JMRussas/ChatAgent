// Loads variables from a local `.env` file into `process.env`, for local development only.
//
// Security notes:
// - `.env` is gitignored and must never be committed. Use `.env.example` as the template.
// - A variable already present in the real process environment (shell, CI, container,
//   secret manager injection) always wins; values from `.env` never override it. This
//   keeps production/CI secret injection authoritative over any local file.
// - This module must be the first import in every CLI entrypoint (src/index.ts,
//   src/bench/runBenchmark.ts, src/bench/compareBenchmarks.ts, src/eval/generateReport.ts)
//   so that provider config, which is read lazily at call time, sees `.env` values.
// - Never log the return value of `config()` here: on success it includes the parsed
//   key/value pairs, which may contain secrets (e.g. AZURE_OPENAI_API_KEY).
import { config } from "dotenv";

// `quiet: true` suppresses dotenv's own startup banner ("injected env (N)
// from .env"). That banner never includes values, only a count and file
// path, so this is purely to keep logs clean, not a secrecy requirement.
config({ quiet: true });
