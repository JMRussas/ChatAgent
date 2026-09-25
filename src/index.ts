import { startServer } from "./server";
import { parsePositiveIntEnv } from "./config/runtimeEnv";

async function main() {
  const port = parsePositiveIntEnv(process.env.PORT, 3100, 1024, 65535);
  await startServer(port);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
