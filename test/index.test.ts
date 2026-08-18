import { describe, expect, mock, test } from "bun:test";

process.env.CAPSOLVER_API_KEY = "test-key";

mock.module("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: () => Promise.reject(new Error("mock stdio failure")),
}));

describe("entrypoint", () => {
  test("sets exit code 1 when main fails", async () => {
    const previous = process.exitCode;
    await import("../src/index.ts");
    expect(process.exitCode).toBe(1);
    process.exitCode = typeof previous === "number" ? previous : 0;
  });
});
