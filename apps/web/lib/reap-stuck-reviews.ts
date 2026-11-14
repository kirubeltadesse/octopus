import "server-only";
import { prisma } from "@octopus/db";
import { enqueue, loadQueueConfig, computeStaleReclaimMs } from "./queue";
import { recordInterruptedAttempt } from "./review-attempt";
import { reconcileReviewCheck } from "./review-check-reconciliation";
import { REVIEW_CANCELLED_STATUS, isReviewCancelledStatus } from "./review-status-state";
import { safeErrorDetails } from "./provider-failure";

// Reviews that die mid-flight (engine restart on deploy, crash, OOM, or a hang
// past the job timeout) are left in "reviewing"/"queued" forever: the finalize
// path never runs, so no error is written, and pg-boss's own retries hit the
// claim guard inside the stale-reclaim window and get skipped. Without this
// reaper they accumulate as permanent silent orphans (observed: 37 days' worth).
//
// The reaper marks every orphan `failed` with a real message - `failed` is
// re-claimable, so a future push / @octopus re-review works cleanly - and, for
// PRs young enough that a re-review is still wanted, enqueues one auto-retry.
// The singletonKey throttles that to at most one reaper-requeue per PR per hour,
// so a genuinely poison PR can't be re-reviewed in a tight loop.
//
// It also reconciles the GitHub check run for the same request: an orphaned
// check is completed as `timed_out`, and a recent failed/cancelled check whose
// PATCH failed transiently is retried on later sweeps. A missing or already
// completed check is never touched, so a newer successful review is preserved.

const REQUEUE_MAX_AGE_MS =
  (Number(process.env.OCTOPUS_REAP_REQUEUE_MAX_AGE_HOURS) || 6) * 60 * 60 * 1000;
const CHECK_RECONCILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CHECK_RECONCILE_BATCH = 50;

export const REAP_FAILED_MESSAGE =
  "Review interrupted by a server restart or timeout. Push a new commit or comment @octopus to retry.";

type ReapRepository = {
  provider: string;
  fullName?: string | null;
  installationId?: number | null;
  organization?: { githubInstallationId?: number | null } | null;
};

type ReapRow = {
  id: string;
  createdAt?: Date;
  status: string;
  updatedAt?: Date;
  reviewRequestVersion: number;
  reviewAttemptId?: string | null;
  headSha?: string | null;
  repository?: ReapRepository | null;
};

async function reconcileCheck(pr: ReapRow, conclusion: "cancelled" | "timed_out"): Promise<void> {
  const repo = pr.repository;
  const installationId = repo?.installationId ?? repo?.organization?.githubInstallationId ?? null;
  if (repo?.provider !== "github" || !installationId || !repo.fullName || !pr.headSha) return;
  try {
    await reconcileReviewCheck({
      installationId, fullName: repo.fullName, headSha: pr.headSha,
      pullRequestId: pr.id, reviewRequestVersion: pr.reviewRequestVersion, conclusion,
      legacyNotAfter: pr.updatedAt,
    });
  } catch (error) {
    // The row stays failed/cancelled; the next sweep retries this PATCH. Never
    // retry a cancelled request as a review, and never touch a completed check.
    console.warn(
      `[reaper] Check reconciliation failed for PR ${pr.id}; will retry:`,
      safeErrorDetails(error),
    );
  }
}

export async function reapStuckReviews(
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number }> {
  const config = await loadQueueConfig();
  // Same two windows as the claim guard (reviewer.ts): "reviewing" uses the
  // in-process timeout, "queued" the longer internal-cli timeout. Both exceed
  // the pg-boss job timeout, so a row past the window is genuinely dead - a live
  // worker would have been killed by pg-boss before its updatedAt got this old.
  const reviewingStale = new Date(
    now.getTime() - computeStaleReclaimMs(config.reviewTimeoutSeconds),
  );
  const queuedStale = new Date(
    now.getTime() - computeStaleReclaimMs(config.largeReviewTimeoutSeconds),
  );

  const orphans = await prisma.pullRequest.findMany({
    where: {
      OR: [
        { status: "reviewing", updatedAt: { lt: reviewingStale } },
        { status: "queued", updatedAt: { lt: queuedStale } },
      ],
    },
    select: {
      id: true, createdAt: true, status: true, updatedAt: true, reviewRequestVersion: true,
      reviewAttemptId: true, headSha: true,
      repository: { select: { provider: true, fullName: true, installationId: true, organization: { select: { githubInstallationId: true } } } },
    },
  });

  const requeueCutoff = new Date(now.getTime() - REQUEUE_MAX_AGE_MS);
  let requeued = 0;
  let failed = 0;

  for (const pr of orphans) {
    // A new claim, a cancellation, or a new request may have replaced the stale
    // row since selection. Only the exact observed state is reaped, so an
    // explicitly cancelled job is never auto-retried.
    const updated = await prisma.$transaction(async tx => {
      const updated = await tx.pullRequest.updateMany({
        where: { id: pr.id, status: pr.status, updatedAt: pr.updatedAt, reviewRequestVersion: pr.reviewRequestVersion },
        data: { status: "failed", errorMessage: REAP_FAILED_MESSAGE },
      });
      if (updated.count && pr.status === "reviewing") await recordInterruptedAttempt(pr, tx);
      return updated;
    });
    if (updated.count === 0) continue;

    await reconcileCheck(pr, "timed_out");

    if (pr.createdAt && pr.createdAt > requeueCutoff) {
      await enqueue(
        "process-review",
        { pullRequestId: pr.id, reviewRequestVersion: pr.reviewRequestVersion },
        { singletonKey: `reap:${pr.id}`, singletonSeconds: 3600 },
      );
      requeued++;
    } else {
      failed++;
    }
  }

  // Retry check PATCHes that failed transiently when the row was first reaped or
  // cancelled. The reconciliation is idempotent and skips completed checks.
  const unsettled = await prisma.pullRequest.findMany({
    where: {
      status: { in: ["failed", REVIEW_CANCELLED_STATUS] },
      updatedAt: { gte: new Date(now.getTime() - CHECK_RECONCILE_MAX_AGE_MS) },
      repository: { provider: "github" },
    },
    select: {
      id: true, status: true, updatedAt: true, headSha: true, reviewRequestVersion: true,
      repository: { select: { provider: true, fullName: true, installationId: true, organization: { select: { githubInstallationId: true } } } },
    },
    take: CHECK_RECONCILE_BATCH,
  });
  for (const pr of unsettled) {
    await reconcileCheck(pr, isReviewCancelledStatus(pr.status) ? "cancelled" : "timed_out");
  }

  return { requeued, failed };
}
