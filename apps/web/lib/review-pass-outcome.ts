import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@octopus/db";

export type ReviewPassKey = {
  organizationId: string;
  repositoryId: string;
  pullRequestId: string;
  requestVersion: number;
  stepKey: string;
};

export type ReviewPassClaim = {
  allowed: boolean;
  completed: boolean;
  reason: string | null;
  result: unknown | null;
};

type PassRow = {
  identity: string;
  status: string;
  claims: number;
  result: unknown | null;
};

const REASON = {
  completed: "already-completed",
  identity: "plan-changed",
  budget: "request-budget-exhausted",
} as const;

/**
 * Atomically claim one bounded review pass. A second delivery of the same step
 * never dispatches twice: an identical completed pass returns its stored result,
 * while a changed plan or an exhausted budget refuses the claim.
 */
export async function claimReviewPass(
  key: ReviewPassKey,
  input: { kind: "batch" | "synthesis"; identity: string; limit: number },
): Promise<ReviewPassClaim> {
  const claimed = await prisma.$queryRaw<unknown[]>`
    INSERT INTO review_passes
      ("id", "organizationId", "repositoryId", "pullRequestId", "requestVersion", "stepKey", "kind", "identity", "claims", "status", "firstClaimedAt")
    VALUES (${randomUUID()}, ${key.organizationId}, ${key.repositoryId}, ${key.pullRequestId}, ${key.requestVersion}, ${key.stepKey}, ${input.kind}, ${input.identity}, 1, 'pending', NOW())
    ON CONFLICT ("pullRequestId", "requestVersion", "stepKey") DO UPDATE
      SET "claims" = review_passes."claims" + 1
      WHERE review_passes."identity" = ${input.identity}
        AND review_passes."status" = 'pending'
        AND review_passes."claims" < ${input.limit}
    RETURNING "claims"
  `;
  if (claimed.length === 1) return { allowed: true, completed: false, reason: null, result: null };

  const [row] = await prisma.$queryRaw<PassRow[]>`
    SELECT "identity", "status", "claims", "result" FROM review_passes
    WHERE "pullRequestId" = ${key.pullRequestId} AND "requestVersion" = ${key.requestVersion} AND "stepKey" = ${key.stepKey}
  `;
  if (!row) return { allowed: false, completed: false, reason: "claim-unavailable", result: null };
  if (row.status === "completed" && row.identity === input.identity) {
    return { allowed: false, completed: true, reason: REASON.completed, result: row.result };
  }
  if (row.identity !== input.identity) return { allowed: false, completed: false, reason: REASON.identity, result: null };
  return { allowed: false, completed: false, reason: REASON.budget, result: null };
}

/** Persist a pass result only when the claimed identity still matches. */
export async function completeReviewPass(
  key: ReviewPassKey,
  identity: string,
  result: unknown,
  responseSha256: string,
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE review_passes SET status = 'completed', result = ${JSON.stringify(result)}::jsonb,
      "responseSha256" = ${responseSha256}, "completedAt" = NOW(), "failureCode" = NULL
    WHERE "pullRequestId" = ${key.pullRequestId} AND "requestVersion" = ${key.requestVersion}
      AND "stepKey" = ${key.stepKey} AND "identity" = ${identity} AND status = 'pending'
  `;
  return updated === 1;
}

/** Record only a sanitized failure code, never a provider message or response excerpt. */
export async function failReviewPass(key: ReviewPassKey, identity: string, failureCode: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE review_passes SET "failureCode" = ${failureCode.slice(0, 64)}
    WHERE "pullRequestId" = ${key.pullRequestId} AND "requestVersion" = ${key.requestVersion}
      AND "stepKey" = ${key.stepKey} AND "identity" = ${identity}
  `;
}
