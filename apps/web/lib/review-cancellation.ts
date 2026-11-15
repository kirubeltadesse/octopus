import "server-only";
import { prisma } from "@octopus/db";
import * as github from "@/lib/github";
import { reconcileReviewCheck } from "@/lib/review-check-reconciliation";
import { REVIEW_CANCELLED_MESSAGE, REVIEW_CANCELLED_STATUS, isReviewCancelledStatus } from "@/lib/review-status-state";

/** Statuses that represent work a cancellation command may stop. */
const ACTIVE_REVIEW_STATUSES = ["pending", "queued", "reviewing"] as const;
export type ActiveReviewStatus = (typeof ACTIVE_REVIEW_STATUSES)[number];
export const isActiveReviewStatus = (status: string): status is ActiveReviewStatus =>
  (ACTIVE_REVIEW_STATUSES as readonly string[]).includes(status);

const CANCEL_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export type ReviewRequestSnapshot = {
  headSha: string | null;
  reviewRequestVersion: number;
  status: string;
};

export type CancelReviewOutcome =
  | { outcome: "cancelled"; previousStatus: ActiveReviewStatus; headSha: string | null; reviewRequestVersion: number; queuedJobs: number }
  | { outcome: "already_cancelled"; headSha: string | null; reviewRequestVersion: number }
  | { outcome: "nothing_to_cancel"; status: string; headSha: string | null }
  | { outcome: "request_changed"; status: string };

/** True only for the exact request that was cancelled, never for a newer one. */
export async function isReviewRequestCancelled(
  pullRequestId: string,
  headSha: string | null,
  reviewRequestVersion: number,
): Promise<boolean> {
  const row = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: { status: true, headSha: true, reviewRequestVersion: true },
  });
  return isReviewCancelledStatus(row?.status)
    && row?.headSha === headSha
    && row?.reviewRequestVersion === reviewRequestVersion;
}

/**
 * Atomically persist cancellation for the observed request generation. A newer
 * request (different head or version) is never cancelled: the optimistic update
 * loses and the caller reports nothing changed.
 */
export async function cancelReviewRequest(params: {
  pullRequestId: string;
  snapshot: ReviewRequestSnapshot;
  installationId?: number | null;
  fullName?: string | null;
}): Promise<CancelReviewOutcome> {
  const { pullRequestId, snapshot } = params;
  let current = snapshot;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (isReviewCancelledStatus(current.status)) {
      return { outcome: "already_cancelled", headSha: current.headSha, reviewRequestVersion: current.reviewRequestVersion };
    }
    if (!isActiveReviewStatus(current.status)) {
      return { outcome: "nothing_to_cancel", status: current.status, headSha: current.headSha };
    }
    const updated = await prisma.pullRequest.updateMany({
      where: {
        id: pullRequestId,
        status: current.status,
        headSha: current.headSha,
        reviewRequestVersion: current.reviewRequestVersion,
      },
      data: { status: REVIEW_CANCELLED_STATUS, errorMessage: REVIEW_CANCELLED_MESSAGE },
    });
    if (updated.count) {
      // Lazy so importing the cancellation helpers does not force every caller
      // (and test fixture) to provide the queue implementation.
      const queuedJobs = await import("@/lib/queue")
        .then(module => module.cancelQueuedReviewJobs(pullRequestId, current.reviewRequestVersion))
        .catch(() => 0);
      if (params.installationId && params.fullName) {
        await reconcileReviewCheck({
          installationId: params.installationId,
          fullName: params.fullName,
          headSha: current.headSha,
          pullRequestId,
          reviewRequestVersion: current.reviewRequestVersion,
          conclusion: "cancelled",
        }).catch(error => console.warn("[review-cancellation] Failed to update the check run; the reaper will retry:", error instanceof Error ? error.message : "unknown error"));
      }
      return {
        outcome: "cancelled",
        previousStatus: current.status,
        headSha: current.headSha,
        reviewRequestVersion: current.reviewRequestVersion,
        queuedJobs,
      };
    }
    const latest = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      select: { status: true, headSha: true, reviewRequestVersion: true },
    });
    if (!latest) return { outcome: "nothing_to_cancel", status: "missing", headSha: null };
    if (latest.headSha !== snapshot.headSha || latest.reviewRequestVersion !== snapshot.reviewRequestVersion) {
      return { outcome: "request_changed", status: latest.status };
    }
    current = latest;
  }
  return { outcome: "request_changed", status: current.status };
}

/**
 * Poll the persisted cancellation state while an in-process review runs. The
 * webhook and review workers are separate processes, so a DB poll is the only
 * cross-process signal available; aborting the shared window signal cancels
 * the provider request where it supports cancellation.
 */
export function createReviewCancellationWatcher(params: {
  pullRequestId: string;
  headSha: string | null;
  reviewRequestVersion: number;
  intervalMs?: number;
}): { signal: AbortSignal; cancelled: () => boolean; stop: () => void } {
  const controller = new AbortController();
  let cancelled = false;
  const timer = setInterval(() => {
    void isReviewRequestCancelled(params.pullRequestId, params.headSha, params.reviewRequestVersion)
      .then(value => {
        if (!value) return;
        cancelled = true;
        if (!controller.signal.aborted) controller.abort(new DOMException("Review cancelled", "AbortError"));
      })
      .catch(() => {});
  }, params.intervalMs ?? 15_000);
  timer.unref?.();
  return { signal: controller.signal, cancelled: () => cancelled, stop: () => clearInterval(timer) };
}

function shortSha(headSha: string | null | undefined): string {
  return headSha ? headSha.slice(0, 7) : "unknown";
}

function acknowledgement(body: string): string {
  return `> 🐙 **Octopus Review** ${body}`;
}

export type CancelCommandResult = { authorized: boolean; body: string; outcome?: CancelReviewOutcome };

/**
 * Handle an authenticated `@octopus cancel` command. The commenter's GitHub
 * repository permission is verified before any state changes; when that
 * verification is unavailable the command is denied rather than guessed.
 */
export async function handleReviewCancelCommand(params: {
  installationId: number;
  owner: string;
  repoName: string;
  repoId: string;
  prNumber: number;
  prHeadSha: string | null;
  commentAuthor: string;
}): Promise<CancelCommandResult> {
  // Only verified repository permissions authorize a cancellation. The signed
  // webhook's author_association is not proof of write access and is never used
  // as a fallback: when verification is unavailable we deny safely.
  const permission = params.commentAuthor
    ? await github.getCollaboratorPermission(params.installationId, params.owner, params.repoName, params.commentAuthor)
    : null;
  if (permission === null) {
    return {
      authorized: false,
      body: acknowledgement("could not verify your repository permission, so the review was not cancelled."),
    };
  }
  if (!CANCEL_PERMISSIONS.has(permission.toLowerCase())) {
    return {
      authorized: false,
      body: acknowledgement("only users with write, maintain, or admin access can cancel reviews."),
    };
  }

  const row = await prisma.pullRequest.findUnique({
    where: { repositoryId_number: { repositoryId: params.repoId, number: params.prNumber } },
    select: { id: true, headSha: true, reviewRequestVersion: true, status: true },
  });
  if (!row) {
    return {
      authorized: true,
      body: acknowledgement("has no queued or running review to cancel. Comment `@octopus` to start a review."),
    };
  }

  const outcome = await cancelReviewRequest({
    pullRequestId: row.id,
    snapshot: { headSha: row.headSha, reviewRequestVersion: row.reviewRequestVersion, status: row.status },
    installationId: params.installationId,
    fullName: `${params.owner}/${params.repoName}`,
  });

  switch (outcome.outcome) {
    case "cancelled": {
      const label = outcome.previousStatus === "reviewing" ? "running" : "queued";
      const queued = outcome.queuedJobs > 0 ? ` Stopped ${outcome.queuedJobs} queued job${outcome.queuedJobs === 1 ? "" : "s"}.` : "";
      return {
        authorized: true,
        outcome,
        body: acknowledgement(`cancelled the ${label} review for commit \`${shortSha(params.prHeadSha ?? outcome.headSha)}\`.${queued} Comment \`@octopus\` to start a fresh review.`),
      };
    }
    case "already_cancelled":
      return {
        authorized: true,
        outcome,
        body: acknowledgement(`is already cancelled for this review request. Comment \`@octopus\` to start a fresh review.`),
      };
    case "request_changed":
      return {
        authorized: true,
        outcome,
        body: acknowledgement(`did not cancel: a newer review request is already in progress.`),
      };
    case "nothing_to_cancel":
      return {
        authorized: true,
        outcome,
        body: acknowledgement(`has no queued or running review to cancel (current state: \`${outcome.status}\`). Comment \`@octopus\` to start a review.`),
      };
  }
}
