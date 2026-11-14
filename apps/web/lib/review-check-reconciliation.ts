import "server-only";
import * as github from "@/lib/github";

export const REVIEW_CHECK_NAME = "Octopus Review";

/**
 * Complete one review request's check run as cancelled or timed out. Idempotent
 * and safe to retry: a missing or already-completed check is left untouched, so
 * a reconciliation sweep can never override a newer successful review.
 */
export async function reconcileReviewCheck(params: {
  installationId: number;
  fullName: string;
  headSha: string | null;
  pullRequestId: string;
  reviewRequestVersion: number;
  conclusion: "cancelled" | "timed_out";
}): Promise<boolean> {
  if (!params.headSha) return false;
  const [owner, repo] = params.fullName.split("/");
  if (!owner || !repo) return false;
  const check = await github.findCheckRunByExternalId(
    params.installationId, owner, repo, params.headSha, REVIEW_CHECK_NAME,
    `${params.pullRequestId}:${params.reviewRequestVersion}`,
  );
  if (!check || check.status === "completed") return true;
  await github.updateCheckRun(params.installationId, owner, repo, check.id, params.conclusion, {
    title: params.conclusion === "cancelled" ? "N/A · Review cancelled" : "N/A · Review timed out",
    summary: params.conclusion === "cancelled"
      ? "This review request was cancelled."
      : "This review did not finish before its timeout.",
  });
  return true;
}
