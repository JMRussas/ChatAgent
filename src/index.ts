import { startServer } from "./server";

async function main() {
  const port = Number(process.env.PORT ?? "3000");
  await startServer(port);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
