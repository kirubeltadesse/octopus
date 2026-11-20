CREATE TABLE "review_passes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "requestVersion" INTEGER NOT NULL,
    "stepKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "claims" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "responseSha256" TEXT,
    "failureCode" TEXT,
    "firstClaimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "review_passes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_passes_request_step_key" ON "review_passes"("pullRequestId", "requestVersion", "stepKey");

CREATE INDEX "review_passes_org_completed_idx" ON "review_passes"("organizationId", "completedAt");

ALTER TABLE "review_passes" ADD CONSTRAINT "review_passes_kind_check" CHECK ("kind" IN ('batch', 'synthesis'));

ALTER TABLE "review_passes" ADD CONSTRAINT "review_passes_status_check" CHECK ("status" IN ('pending', 'completed'));

ALTER TABLE "review_passes" ADD CONSTRAINT "review_passes_claims_check" CHECK ("claims" >= 0);
