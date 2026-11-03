import { describe, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";

process.env.CAPSOLVER_API_KEY = "test-key";

let stdioFails = true;

mock.module("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: () =>
    stdioFails
      ? Promise.reject(new Error("mock stdio failure"))
      : Promise.resolve(undefined),
}));

const { runCli } = await import("../src/index.ts");

function captureStdout(): { text: () => string; restore: () => void } {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    written.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  };
  return {
    text: () => written.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("command line", () => {
  test("returns 1 when the server fails to start", async () => {
    stdioFails = true;
    expect(await runCli([])).toBe(1);
  });

  test("returns 0 when the server ends cleanly", async () => {
    stdioFails = false;
    try {
      expect(await runCli([])).toBe(0);
    } finally {
      stdioFails = true;
    }
  });

  test("prints the version", async () => {
    const out = captureStdout();
    try {
      expect(await runCli(["--version"])).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text().trim()).toBe("0.3.0");
  });

  test("prints the usage text", async () => {
    const out = captureStdout();
    try {
      expect(await runCli(["--help"])).toBe(0);
    } finally {
      out.restore();
    }
    expect(out.text()).toContain("seo-mcp radar --niche");
  });

  test("returns 2 when a radar run has no niche", async () => {
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      errors.push(
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
      );
      return true;
    };
    try {
      expect(await runCli(["radar"])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(errors.join("")).toContain("usage: seo-mcp radar");
  });

  test("returns 1 when the radar fails", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    };
    const failing = {
      trending: async () => {
        throw new Error("source down");
      },
      keywordResearch: async () => ({ content: [] }),
      serpSnapshot: async () => ({ content: [] }),
    };
    try {
      expect(await runCli(["radar", "--niche", "x"], failing)).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors.join("")).toContain("Radar failed: source down");
  });
});

describe("the installed command", () => {
  const cli = [process.execPath, "run", "src/index.ts"];
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  test("prints the version", async () => {
    const proc = Bun.spawn([...cli, "--version"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("0.3.0");
  });

  test("refuses a radar run without a niche", async () => {
    const proc = Bun.spawn([...cli, "radar"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).toBe(2);
    expect(err).toContain("usage: seo-mcp radar");
  });
});
