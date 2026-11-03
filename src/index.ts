#!/usr/bin/env bun
import { main } from "./server.ts";
import { runRadar, type RadarTools } from "./radar.ts";
import { readVersion } from "./server.ts";

const USAGE = `SEO Radar MCP

  seo-mcp                     start the MCP server on stdio
  seo-mcp radar --niche "x"  write the daily radar for a niche
  seo-mcp --version           print the version
  seo-mcp --help              print this text

Radar options:
  --niche "<topic>"     the niche to report on (required)
  --seed "<keyword>"    the keyword to expand (defaults to the niche)
  --limit <n>           rows per section (default 8)
  --out <file>          write the markdown to a file
`;

/**
 * Runs one command. The function takes the arguments and the radar tools so a
 * test can call it without a network or a server on stdio.
 */
export async function runCli(
  argv: string[],
  tools?: RadarTools,
): Promise<number> {
  const first = argv[0];
  if (first === "radar") {
    try {
      return await runRadar(argv.slice(1), tools);
    } catch (error: unknown) {
      console.error(
        "Radar failed:",
        error instanceof Error ? error.message : String(error),
      );
      return 1;
    }
  }
  if (first === "--version" || first === "-v" || first === "version") {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    await main();
  } catch (error: unknown) {
    console.error("Fatal error in SEO Radar MCP:", error);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
