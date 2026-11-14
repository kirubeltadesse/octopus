import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

type Row = { id: string; headSha: string | null; reviewRequestVersion: number; status: string };
let row: Row | null = null;

mock.module("@octopus/db", () => ({
  prisma: {
    pullRequest: {
      findUnique: async (args: { where: { id?: string; repositoryId_number?: { repositoryId: string; number: number } } }) => {
        if (!row) return null;
        if (args.where.id && args.where.id !== row.id) return null;
        if (args.where.repositoryId_number && args.where.repositoryId_number.number !== 1) return null;
        return { ...row };
      },
      updateMany: async (args: { where: Partial<Row>; data: Partial<Row> & { errorMessage?: string } }) => {
        if (!row) return { count: 0 };
        if (args.where.id !== undefined && args.where.id !== row.id) return { count: 0 };
        if (args.where.status !== undefined && args.where.status !== row.status) return { count: 0 };
        if (args.where.headSha !== undefined && args.where.headSha !== row.headSha) return { count: 0 };
        if (args.where.reviewRequestVersion !== undefined && args.where.reviewRequestVersion !== row.reviewRequestVersion) return { count: 0 };
        row = { ...row, status: args.data.status ?? row.status };
        return { count: 1 };
      },
    },
  },
}));

let permission: string | null = "write";
let checkStatus: string | null = "in_progress";
let checkLookupError = false;
const checkUpdates: { id: number; conclusion: string }[] = [];
mock.module("@/lib/github", () => ({
  getCollaboratorPermission: async () => permission,
  findCheckRunByExternalId: async () => {
    if (checkLookupError) throw new Error("503 from GitHub");
    return checkStatus ? { id: 77, status: checkStatus, external_id: "pr:1" } : null;
  },
  updateCheckRun: async (_installation: number, _owner: string, _repo: string, id: number, conclusion: string) => {
    checkUpdates.push({ id, conclusion });
    checkStatus = "completed";
  },
}));

let queuedCancellations = 0;
mock.module("@/lib/queue", () => ({
  cancelQueuedReviewJobs: async () => {
    queuedCancellations++;
    return 2;
  },
}));

const { cancelReviewRequest, handleReviewCancelCommand, isReviewRequestCancelled, createReviewCancellationWatcher } = await import("../../review-cancellation");
const { reconcileReviewCheck } = await import("../../review-check-reconciliation");

const head = "a".repeat(40);
const base = { id: "pr", headSha: head, reviewRequestVersion: 1, status: "pending" };

function reset(overrides: Partial<Row> = {}) {
  row = { ...base, ...overrides };
  permission = "write";
  checkStatus = "in_progress";
  checkLookupError = false;
  checkUpdates.length = 0;
  queuedCancellations = 0;
}

{
  reset();
  const result = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "alice", authorAssociation: "MEMBER",
  });
  assert.equal(result.authorized, true);
  assert.equal(result.outcome?.outcome, "cancelled");
  assert.ok(result.body.includes("queued review"), result.body);
  assert.ok(result.body.includes("aaaaaaa"), result.body);
  assert.equal(row?.status, "cancelled");
  assert.equal(queuedCancellations, 1);
  assert.deepEqual(checkUpdates, [{ id: 77, conclusion: "cancelled" }]);
  assert.equal(await isReviewRequestCancelled("pr", head, 1), true);

  const duplicate = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "alice", authorAssociation: "MEMBER",
  });
  assert.equal(duplicate.outcome?.outcome, "already_cancelled");
  assert.ok(duplicate.body.includes("already cancelled"), duplicate.body);
  assert.equal(checkUpdates.length, 1, "duplicate cancellation must not re-update the check");
}
console.log("PASS pending cancellation, acknowledgement and duplicate handling");

{
  reset({ status: "reviewing", reviewRequestVersion: 2 });
  const result = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "alice", authorAssociation: "MEMBER",
  });
  assert.equal(result.outcome?.outcome, "cancelled");
  assert.ok(result.body.includes("running review"), result.body);
  assert.equal(row?.status, "cancelled");
}
console.log("PASS running cancellation");

{
  reset();
  permission = "read";
  const denied = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "reader", authorAssociation: "CONTRIBUTOR",
  });
  assert.equal(denied.authorized, false);
  assert.ok(denied.body.includes("write, maintain, or admin"), denied.body);
  assert.equal(row?.status, "pending");
  assert.equal(checkUpdates.length, 0);

  permission = null;
  const associationDenied = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "contributor", authorAssociation: "CONTRIBUTOR",
  });
  assert.equal(associationDenied.authorized, false);

  const associationAllowed = await handleReviewCancelCommand({
    installationId: 1, owner: "owner", repoName: "repo", repoId: "repo-db", prNumber: 1,
    prHeadSha: head, commentAuthor: "collaborator", authorAssociation: "COLLABORATOR",
  });
  assert.equal(associationAllowed.authorized, true);
  assert.equal(row?.status, "cancelled");
}
console.log("PASS authorization by permission and signed association fallback");

{
  reset({ reviewRequestVersion: 7, status: "pending" });
  const outcome = await cancelReviewRequest({
    pullRequestId: "pr",
    snapshot: { headSha: head, reviewRequestVersion: 6, status: "pending" },
  });
  assert.equal(outcome.outcome, "request_changed");
  assert.equal(row?.status, "pending", "a newer request must survive a stale cancellation");
  assert.equal(row?.reviewRequestVersion, 7);
}
console.log("PASS stale cancellation never cancels a newer request");

{
  reset({ status: "reviewing", reviewRequestVersion: 3 });
  checkLookupError = true;
  const warn = console.warn;
  console.warn = () => {};
  const outcome = await cancelReviewRequest({
    pullRequestId: "pr",
    snapshot: { headSha: head, reviewRequestVersion: 3, status: "reviewing" },
    installationId: 1,
    fullName: "owner/repo",
  }).finally(() => { console.warn = warn; });
  assert.equal(outcome.outcome, "cancelled");
  assert.equal(row?.status, "cancelled");
  assert.equal(checkUpdates.length, 0, "a transient check failure must not un-cancel the request");

  checkLookupError = false;
  checkStatus = "in_progress";
  await reconcileReviewCheck({ installationId: 1, fullName: "owner/repo", headSha: head, pullRequestId: "pr", reviewRequestVersion: 3, conclusion: "cancelled" });
  assert.deepEqual(checkUpdates, [{ id: 77, conclusion: "cancelled" }]);
}
console.log("PASS transient check API failure is retried by reconciliation");

{
  reset({ status: "reviewing" });
  checkStatus = "completed";
  checkUpdates.length = 0;
  await reconcileReviewCheck({ installationId: 1, fullName: "owner/repo", headSha: head, pullRequestId: "pr", reviewRequestVersion: 1, conclusion: "timed_out" });
  assert.equal(checkUpdates.length, 0, "a completed check must never be overridden");
}
console.log("PASS reconciliation never overrides a completed check");

{
  reset({ status: "pending" });
  const watcher = createReviewCancellationWatcher({ pullRequestId: "pr", headSha: head, reviewRequestVersion: 1, intervalMs: 5 });
  row = { ...row!, status: "cancelled" };
  await new Promise(resolve => setTimeout(resolve, 20));
  watcher.stop();
  assert.equal(watcher.cancelled(), true, "the in-process watcher observes persisted cancellation");
  assert.equal(watcher.signal.aborted, true);
}
console.log("PASS in-process watcher aborts on persisted cancellation");

console.log("PASS review cancellation");
