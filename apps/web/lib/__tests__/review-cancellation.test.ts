import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("cancels pending and running reviews, authorizes, and retries check updates", async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/review-cancellation-harness.ts", import.meta.url))], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS review cancellation");
}, 30_000);
