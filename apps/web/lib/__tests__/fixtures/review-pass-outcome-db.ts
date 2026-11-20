import { mock } from "bun:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
assert.match(url.pathname, /(^|[-_])test($|[-_])/);
assert.equal(url.search, "");
assert.equal(url.hash, "");
url.hostname = "127.0.0.1";
process.env.DATABASE_URL = url.toString();
mock.module("server-only", () => ({}));
const { prisma } = await import("@octopus/db");
const { claimReviewPass, completeReviewPass, failReviewPass } = await import("../../review-pass-outcome");

const id = randomUUID();
const org = await prisma.organization.create({ data: { name: "Synthetic", slug: `review-pass-test-${id}`, creditBalance: 100 } });
const log = console.log, error = console.error;
console.log = console.error = () => {};
try {
  const repo = await prisma.repository.create({ data: { organizationId: org.id, name: "Synthetic", fullName: `fixture/${id}`, externalId: id } });
  const pr = await prisma.pullRequest.create({ data: { repositoryId: repo.id, number: 1, title: "Synthetic", url: "", author: "fixture", status: "reviewing", reviewRequestVersion: 1 } });
  const key = stepKey => ({ organizationId: org.id, repositoryId: repo.id, pullRequestId: pr.id, requestVersion: 1, stepKey });
  const identity = "a".repeat(64);

  const raced = await Promise.all(Array.from({ length: 6 }, () => claimReviewPass(key("batch:0"), { kind: "batch", identity, limit: 2 })));
  assert.equal(raced.filter(claim => claim.allowed).length, 2, "only the bounded number of claims is granted");
  const row = await prisma.reviewPass.findUniqueOrThrow({ where: { pullRequestId_requestVersion_stepKey: { pullRequestId: pr.id, requestVersion: 1, stepKey: "batch:0" } } });
  assert.equal(row.claims, 2);
  assert.equal(await claimReviewPass(key("batch:0"), { kind: "batch", identity, limit: 2 }).then(claim => claim.allowed), false, "a third dispatch is refused");

  const result = { findings: [], responseSha256: "b".repeat(64) };
  assert.equal(await completeReviewPass(key("batch:0"), identity, result, result.responseSha256), true);
  const reused = await claimReviewPass(key("batch:0"), { kind: "batch", identity, limit: 2 });
  assert.equal(reused.completed, true);
  assert.deepEqual(reused.result, result, "a completed pass returns its stored result without a second dispatch");
  assert.equal(await claimReviewPass(key("batch:0"), { kind: "batch", identity: "c".repeat(64), limit: 2 }).then(claim => claim.reason), "plan-changed");

  assert.equal((await claimReviewPass(key("synthesis"), { kind: "synthesis", identity, limit: 2 })).allowed, true);
  await failReviewPass(key("synthesis"), identity, "http_524");
  const failed = await prisma.reviewPass.findUniqueOrThrow({ where: { pullRequestId_requestVersion_stepKey: { pullRequestId: pr.id, requestVersion: 1, stepKey: "synthesis" } } });
  assert.equal(failed.failureCode, "http_524", "only the sanitized code is stored");
  log("PASS durable review pass claims, idempotent result reuse and bounded budget");
} finally {
  console.log = log; console.error = error;
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
}
