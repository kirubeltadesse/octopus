import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

(process.env.RUN_REVIEW_PASS_DB_TESTS === "1" ? describe : describe.skip)("multi-pass durable claims with PostgreSQL", () => {
  it("bounds claims, reuses completed results and records sanitized failures", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/review-pass-outcome-db.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  }, 30_000);
});
