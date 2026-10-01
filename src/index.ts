import "./config/loadEnv";
import { startServer } from "./server";
import { parsePositiveIntEnv } from "./config/runtimeEnv";

async function main() {
  const port = parsePositiveIntEnv(process.env.PORT, 3100, 1024, 65535);
  const runtime = await startServer(port);
  const stop = () => {
    void runtime
      .shutdown()
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      })
      .finally(() => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
