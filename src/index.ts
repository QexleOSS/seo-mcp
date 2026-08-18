import { main } from "./server.ts";

main().catch((error: unknown) => {
  console.error("Fatal error in SEO Toolkit MCP:", error);
  process.exitCode = 1;
});
