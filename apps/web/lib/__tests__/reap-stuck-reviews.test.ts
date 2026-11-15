import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

type Orphan = {
  id: string; createdAt: Date; status: string; updatedAt: Date; reviewRequestVersion: number;
  reviewAttemptId?: string | null; headSha?: string | null;
  repository?: { provider: string; fullName?: string; installationId?: number; organization?: { githubInstallationId?: number } };
};
type Where = { status?: string | { in?: string[] }; errorMessage?: string; OR?: unknown };

let orphans: Orphan[] = [];
let timeoutRows: Orphan[] = [];
let cancelledRows: Orphan[] = [];
let reapMessage = "";
let updateCount = 1;
const findManyCalls: Where[] = [];
const findMany = mock(async ({ where }: { where?: Where } = {}) => {
  findManyCalls.push(where ?? {});
  if (where?.status === "failed") return where.errorMessage === reapMessage ? timeoutRows : [];
  if (where?.status === "cancelled") return cancelledRows;
  return orphans;
});
const updateMany = mock(async () => ({ count: updateCount }));
mock.module("@octopus/db", () => ({
  prisma: { pullRequest: { findMany, updateMany }, $transaction: (run: (tx: unknown) => unknown) => run({ pullRequest: { updateMany } }) },
}));

const enqueue = mock(async () => "job-id");
mock.module("@/lib/queue", () => ({
  enqueue,
  loadQueueConfig: async () => ({
    reviewTimeoutSeconds: 900,
    largeReviewTimeoutSeconds: 1800,
    reviewConcurrency: 2,
  }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));

let failReconcile = false;
const reconcile = mock(async () => {
  if (failReconcile) throw new Error("503 from GitHub");
  return true;
});
mock.module("@/lib/review-check-reconciliation", () => ({ reconcileReviewCheck: reconcile }));

const { reapStuckReviews, REAP_FAILED_MESSAGE } = await import(
  "@/lib/reap-stuck-reviews"
);
reapMessage = REAP_FAILED_MESSAGE;

const NOW = new Date("2026-08-06T13:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const orphan = (id: string, createdAt: Date): Orphan => ({ id, createdAt, status: "reviewing", updatedAt: minutesAgo(30), reviewRequestVersion: 1 });
const githubOrphan = (id: string, status = "reviewing"): Orphan => ({
  ...orphan(id, minutesAgo(30)), status, headSha: "a".repeat(40),
  repository: { provider: "github", fullName: "owner/repo", installationId: 123, organization: { githubInstallationId: 123 } },
});

describe("reapStuckReviews", () => {
  beforeEach(() => {
    orphans = [];
    timeoutRows = [];
    cancelledRows = [];
    updateCount = 1;
    failReconcile = false;
    findManyCalls.length = 0;
    findMany.mockClear();
    updateMany.mockClear();
    enqueue.mockClear();
    reconcile.mockClear();
  });

  it("marks a recent orphan failed and re-queues exactly one throttled retry", async () => {
    orphans = [orphan("pr_recent", minutesAgo(30))];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 1, failed: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "pr_recent", status: "reviewing", updatedAt: minutesAgo(30), reviewRequestVersion: 1 },
      data: { status: "failed", errorMessage: REAP_FAILED_MESSAGE },
    });
    expect(enqueue).toHaveBeenCalledWith(
      "process-review",
      { pullRequestId: "pr_recent", reviewRequestVersion: 1 },
      { singletonKey: "reap:pr_recent", singletonSeconds: 3600 },
    );
  });

  it("fails an old backlog orphan without re-queuing (no comment spam)", async () => {
    orphans = [orphan("pr_old", daysAgo(40))];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("skips a row a live worker already finished (update matched nothing)", async () => {
    orphans = [orphan("pr_raced", minutesAgo(30))];
    updateCount = 0;
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("marks an expired orphaned GitHub check as timed_out", async () => {
    orphans = [githubOrphan("pr_gh", "reviewing")];
    await reapStuckReviews(NOW);
    expect(reconcile).toHaveBeenCalledWith({
      installationId: 123, fullName: "owner/repo", headSha: "a".repeat(40),
      pullRequestId: "pr_gh", reviewRequestVersion: 1, conclusion: "timed_out",
    });
  });

  it("does not requeue or reconcile an explicitly cancelled request", async () => {
    // The row was cancelled after selection, so the optimistic update matches nothing.
    orphans = [githubOrphan("pr_cancelled", "reviewing")];
    updateCount = 0;
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("retries a timed-out check PATCH that failed transiently on a later sweep", async () => {
    orphans = [githubOrphan("pr_retry", "reviewing")];
    failReconcile = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await reapStuckReviews(NOW);
    } finally {
      console.warn = warn;
    }
    expect(reconcile).toHaveBeenCalledTimes(1);

    failReconcile = false;
    orphans = [];
    timeoutRows = [githubOrphan("pr_retry", "failed")];
    await reapStuckReviews(new Date(NOW.getTime() + 5 * 60 * 1000));
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({ pullRequestId: "pr_retry", conclusion: "timed_out" }));
  });

  it("reconciles an explicitly cancelled check as cancelled, never timed_out", async () => {
    cancelledRows = [githubOrphan("pr_cancel", "cancelled")];
    await reapStuckReviews(NOW);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ pullRequestId: "pr_cancel", conclusion: "cancelled" }));
    expect(reconcile).not.toHaveBeenCalledWith(expect.objectContaining({ conclusion: "timed_out" }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never classifies an ordinary failed review as timed_out", async () => {
    timeoutRows = [];
    cancelledRows = [];
    await reapStuckReviews(NOW);
    expect(reconcile).not.toHaveBeenCalled();
    // The retry sweep must be scoped to the timeout-recovery marker, not every failure.
    const failedQuery = findManyCalls.find(where => where.status === "failed");
    expect(failedQuery?.errorMessage).toBe(REAP_FAILED_MESSAGE);
    expect(findManyCalls.some(where => typeof where.status === "object" && Array.isArray(where.status.in))).toBe(false);
  });
});
