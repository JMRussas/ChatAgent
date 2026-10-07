/**
 * Offline composition of one Hekate handoff delivery into a new output directory.
 *
 *   npx tsx scripts/handoff.ts compose --delivery <dir> --fresh <file> --policy <file> \
 *     --request <file> --out <new-dir> [--retrieval <recorded.json>]
 *
 * It reads only the named files and writes only the new directory. The snapshot file
 * is a historical as-of input, not live authority. Failures print a code only.
 */
import { runHandoffCompose } from "../src/integrations/hekate/handoffConsumer/cli";

process.exitCode = runHandoffCompose(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
