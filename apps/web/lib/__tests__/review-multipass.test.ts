import { describe, expect, it, mock } from "bun:test";
import type { AiCreateParams } from "@/lib/providers";

mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ prisma: {} }));

type StoredPass = { identity: string; status: string; claims: number; result: unknown | null; failureCode: string | null };
type PassKey = { pullRequestId: string; requestVersion: number; stepKey: string };
const store = new Map<string, StoredPass>();
const dispatchLog: string[] = [];
let allowClaims = true;

mock.module("@/lib/review-pass-outcome", () => ({
  claimReviewPass: async (key: PassKey, input: { kind: string; identity: string; limit: number }) => {
    const id = `${key.pullRequestId}:${key.requestVersion}:${key.stepKey}`;
    const row = store.get(id);
    if (!row) {
      store.set(id, { identity: input.identity, status: "pending", claims: 1, result: null, failureCode: null });
      return { allowed: true, completed: false, reason: null, result: null };
    }
    if (row.status === "completed" && row.identity === input.identity) {
      return { allowed: false, completed: true, reason: "already-completed", result: row.result };
    }
    if (!allowClaims || row.identity !== input.identity || row.claims >= input.limit) {
      return { allowed: false, completed: false, reason: row.identity !== input.identity ? "plan-changed" : "request-budget-exhausted", result: null };
    }
    row.claims++;
    return { allowed: true, completed: false, reason: null, result: null };
  },
  completeReviewPass: async (key: PassKey, identity: string, result: unknown) => {
    const id = `${key.pullRequestId}:${key.requestVersion}:${key.stepKey}`;
    const row = store.get(id);
    if (!row || row.identity !== identity) return false;
    row.status = "completed"; row.result = result; return true;
  },
  failReviewPass: async (key: PassKey, identity: string, code: string) => {
    const row = store.get(`${key.pullRequestId}:${key.requestVersion}:${key.stepKey}`);
    if (row?.identity === identity) row.failureCode = code;
  },
}));

const { planReviewBatches, reviewBatchConfig } = await import("@/lib/review-batching");
const { validateBatchFindings, mergeBatchFindings, enforceAuthoritativeFindings, executeMultiPassReview, recordMultiPassFailure, MultiPassError } = await import("@/lib/review-multipass");
type MultiPassContext = import("@/lib/review-multipass").MultiPassContext;
const { validReviewResponse } = await import("@/lib/review-assessment");
const { AiProviderFailure } = await import("@/lib/provider-failure");
const { parseFindingsFromJson } = await import("@/lib/review-dedup");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const finding = (index: number, severity = "🟠") => ({
  severity, title: `Finding ${index}`, filePath: `src/file-${index}.ts`, startLine: 1, endLine: 1,
  category: "Bug", description: `Issue ${index} is real`, suggestion: "", confidence: 90,
  whyTestsDoNotAlreadyCoverThis: "No test covers it", suggestedRegressionTest: "", minimumFixScope: "One line",
});
const findingsBlock = (items: unknown[]) => `<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify(items)}\n<!-- OCTOPUS_FINDINGS_END -->`;
const report = (items: unknown[]) => `## 🐙 Octopus Review

### Summary
All batch findings were consolidated and verified.

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 5/5 | No security finding |
| Code Quality | 3/5 | Issues remain |
| Performance | 4/5 | Bounded work |
| Error Handling | 5/5 | Explicit errors |
| Consistency | 5/5 | Consistent |
| **Overall** | **3/5** | Lowest category |

### Findings Summary
| Severity | Count |
| --- | --- |
| 🔴 Critical | 99 |
| 🟠 High | 0 |
| 🟡 Medium | 0 |
| 🔵 Low | 0 |
| 💡 Nit | 0 |

### Findings
${findingsBlock(items)}

Last reviewed commit: ${HEAD}
`;

function input(files: number, charsPerFile = 6_000) {
  const list = Array.from({ length: files }, (_, index) => {
    const line = `+const value${index} = "${"x".repeat(charsPerFile)}";\n`;
    return { path: `src/file-${index}.ts`, change: "modified", patch: `@@ -1 +1 @@\n-${line.slice(1)}${line}`, additions: 1, deletions: 1 };
  });
  return { provider: "github", headSha: HEAD, baseSha: BASE, inventoryComplete: true, expectedFiles: files, files: list, limitations: [] };
}

function planFor(files: number, charsPerFile = 6_000, config = {}) {
  return planReviewBatches(input(files, charsPerFile), { config, env: {} as NodeJS.ProcessEnv });
}

function context(options: {
  plan: ReturnType<typeof planFor>;
  call: (request: AiCreateParams) => Promise<import("@/lib/providers").AiResponse>;
  confirmCurrent?: (signal: AbortSignal) => Promise<string | null>;
  signal?: AbortSignal;
}): MultiPassContext {
  return {
    plan: options.plan, coverage: options.plan.coverage, organizationId: "org", repositoryId: "repo",
    pullRequestId: "pr", requestVersion: 1, model: "gpt-test", number: 1, title: "Large PR", author: "author",
    comment: "", repoConfig: "", systemPrompt: "Trusted review template", template: "template-v1",
    window: { jobId: "job", deadlineEpochMs: Date.now() + 900_000, signal: options.signal ?? new AbortController().signal,
      remainingMs: () => 900_000 },
    signal: options.signal ?? new AbortController().signal, call: options.call,
    confirmCurrent: options.confirmCurrent ?? (async () => null), credentialUnchanged: async () => true,
    onUsage: async () => {},
  };
}

function aiResponse(text: string, completion: "completed" | "incomplete" = "completed") {
  return { text, provider: "openai" as const, model: "gpt-test", usedOwnKey: true,
    completion: { state: completion, reason: completion === "completed" ? null : "length" },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
}

function successCall(items: unknown[] = [finding(0)], completion: "completed" | "incomplete" = "completed") {
  return async (request: AiCreateParams) => {
    const content = request.messages[0].content;
    const isBatch = content.includes("Review batch");
    dispatchLog.push(isBatch ? "batch" : "synthesis");
    request.onRequest?.({ provider: "openai", model: request.model, sha256: "c".repeat(64), inputPreserved: true });
    if (isBatch) {
      const paths = [...content.matchAll(/^- (src\/file-\d+\.ts)$/gm)].map(match => match[1]);
      return aiResponse(findingsBlock(paths.map((path, index) => ({ ...finding(index), filePath: path }))), completion);
    }
    return aiResponse(report(items));
  };
}

describe("batching planner", () => {
  it("keeps a small PR on the single-pass path", () => {
    const plan = planFor(2, 1_000);
    expect(plan.mode).toBe("single");
    expect(plan.batches).toHaveLength(0);
    expect(plan.coverage.complete).toBe(true);
  });

  it("splits a ~133K character, 20-file PR into bounded batches", () => {
    const plan = planFor(20, 6_700);
    expect(plan.totalChars).toBeGreaterThan(130_000);
    expect(plan.mode).toBe("multi");
    expect(plan.batches.length).toBeGreaterThan(2);
    for (const batch of plan.batches) expect(batch.chars).toBeLessThanOrEqual(plan.config.batchChars);
    expect(plan.batches.reduce((sum, batch) => sum + batch.chars, 0)).toBe(plan.diff.length);
    expect(new Set(plan.batches.flatMap(batch => batch.files)).size).toBe(20);
    expect(plan.error).toBeNull();
  });

  it("is deterministic and covers every changed file exactly once", () => {
    const first = planFor(8, 8_000);
    const second = planFor(8, 8_000);
    expect(first.batches.map(batch => batch.stepKey)).toEqual(second.batches.map(batch => batch.stepKey));
    expect(first.batches.map(batch => batch.sections.map(section => section.sha256)))
      .toEqual(second.batches.map(batch => batch.sections.map(section => section.sha256)));
    const files = first.batches.flatMap(batch => batch.files);
    expect(files).toHaveLength(8);
    expect(new Set(files).size).toBe(8);
  });

  it("splits one oversized file only at hunk boundaries and refuses an unsplittable hunk", () => {
    const hunks = Array.from({ length: 4 }, (_, index) => `@@ -${index + 1},0 +${index + 1},1 @@\n+${"x".repeat(20_000)}\n`).join("");
    const oversized: import("@/lib/review-coverage").ReviewInput = {
      provider: "github", headSha: HEAD, baseSha: BASE, inventoryComplete: true, expectedFiles: 1, limitations: [],
      files: [{ path: "src/huge.ts", change: "modified", patch: hunks, additions: 4, deletions: 0 }],
    };
    const whole = planReviewBatches(oversized, { config: { batchChars: 35_000, thresholdChars: 1 }, env: {} as NodeJS.ProcessEnv });
    expect(whole.mode).toBe("multi");
    expect(whole.batches.length).toBeGreaterThan(1);
    for (const batch of whole.batches) expect(batch.chars).toBeLessThanOrEqual(35_000);

    const oneHunk: import("@/lib/review-coverage").ReviewInput = {
      provider: "github", headSha: HEAD, baseSha: BASE, inventoryComplete: true, expectedFiles: 1, limitations: [],
      files: [{ path: "src/huge.ts", change: "modified", patch: `@@ -1,0 +1,${40_000} @@\n${"+x\n".repeat(40_000)}`, additions: 40_000, deletions: 0 }],
    };
    const refused = planReviewBatches(oneHunk, { config: { batchChars: 35_000, thresholdChars: 1 }, env: {} as NodeJS.ProcessEnv });
    expect(refused.mode).toBe("multi");
    expect(refused.error).toContain("Oversized hunk");
  });

  it("honors configured batch size and threshold", () => {
    expect(reviewBatchConfig({} as NodeJS.ProcessEnv).batchChars).toBe(35_000);
    expect(reviewBatchConfig({ OCTOPUS_REVIEW_BATCH_CHARS: "20000" } as NodeJS.ProcessEnv).batchChars).toBe(20_000);
    expect(reviewBatchConfig({ OCTOPUS_REVIEW_BATCH_CHARS: "1" } as NodeJS.ProcessEnv).batchChars).toBe(35_000);
    expect(planFor(20, 6_700, { batchChars: 20_000, maxBatches: 64 }).batches.length)
      .toBeGreaterThan(planFor(20, 6_700, { batchChars: 50_000, maxBatches: 64 }).batches.length);
  });
});

describe("batch findings validation", () => {
  it("rejects duplicate markers, malformed JSON and findings outside the batch", () => {
    expect(validateBatchFindings(findingsBlock([finding(0)]) + findingsBlock([]), new Set(["src/file-0.ts"])).error)
      .toContain("markers missing or duplicated");
    expect(validateBatchFindings(`<!-- OCTOPUS_FINDINGS_START -->\n[null]\n<!-- OCTOPUS_FINDINGS_END -->`, new Set(["src/file-0.ts"])).error)
      .toContain("malformed");
    expect(validateBatchFindings(findingsBlock([finding(0)]), new Set(["src/other.ts"])).error)
      .toContain("invalid");
  });

  it("deduplicates findings across batches without changing valid ones", () => {
    const merged = mergeBatchFindings([
      { findings: [finding(0), finding(1)], responseSha256: "a" },
      { findings: [finding(0), finding(2)], responseSha256: "b" },
    ]);
    expect(merged.map(item => item.filePath)).toEqual(["src/file-0.ts", "src/file-1.ts", "src/file-2.ts"]);
  });

  it("restores authoritative findings and matching table counts", () => {
    const restored = enforceAuthoritativeFindings(report([]), [finding(0), finding(1)]);
    expect(parseFindingsFromJson(restored)).toHaveLength(2);
    expect(restored).toContain("| 🟠 High | 2 |");
    expect(restored).toContain("| 🔴 Critical | 0 |");
    expect(restored).toContain("| **Overall** | **3/5** |");
  });
});

describe("multi-pass execution", () => {
  const reset = () => { store.clear(); dispatchLog.length = 0; allowClaims = true; };

  it("publishes a complete, validated merged review with accurate scores", async () => {
    reset();
    const items = [finding(0), finding(1)];
    const ctx = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: successCall(items) });
    const response = await executeMultiPassReview(ctx);
    expect(validReviewResponse(response.text)).toBe(true);
    expect(ctx.coverage.assessment?.state).toBe("completed");
    expect(ctx.coverage.assessment?.responseValidation?.state).toBe("valid");
    expect(parseFindingsFromJson(response.text)?.map(item => item.filePath))
      .toEqual(["src/file-0.ts", "src/file-1.ts", "src/file-2.ts", "src/file-3.ts"]);
    expect(response.text).toContain("| **Overall** | **3/5** |");
    expect(dispatchLog.filter(entry => entry === "batch")).toHaveLength(ctx.plan.batches.length);
    expect(dispatchLog.filter(entry => entry === "synthesis")).toHaveLength(1);
  });

  it("fails closed when a batch returns HTTP 524 and never runs synthesis", async () => {
    reset();
    const ctx = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: async request => {
      dispatchLog.push("batch");
      request.onRequest?.({ provider: "openai", model: request.model, sha256: "c".repeat(64), inputPreserved: true });
      throw new AiProviderFailure(Object.assign(new Error("gateway timeout"), { status: 524 }), "openai", "gpt-test", "organization");
    } });
    const error = await executeMultiPassReview(ctx).catch(error => error);
    expect(error).toBeInstanceOf(MultiPassError);
    expect(error.failure).toMatchObject({ stage: "batch", code: "http_524" });
    expect(ctx.coverage.assessment).toBeUndefined();
    expect(dispatchLog).not.toContain("synthesis");
    recordMultiPassFailure(ctx.coverage, error.failure);
    expect(ctx.coverage.assessment?.state).toBe("incomplete");
    expect(ctx.coverage.assessment?.reason).toContain("batch:0");
    expect(ctx.coverage.assessment?.reason).toContain("http_524");
  });

  it("fails closed when synthesis times out or is incomplete", async () => {
    reset();
    const ctx = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: async request => {
      dispatchLog.push(request.messages[0].content.includes("Review batch") ? "batch" : "synthesis");
      request.onRequest?.({ provider: "openai", model: request.model, sha256: "c".repeat(64), inputPreserved: true });
      const content = request.messages[0].content;
      if (!content.includes("Review batch")) {
        throw new AiProviderFailure(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), "openai", "gpt-test", "organization");
      }
      const paths = [...content.matchAll(/^- (src\/file-\d+\.ts)$/gm)].map(match => match[1]);
      return aiResponse(findingsBlock(paths.map((path, index) => ({ ...finding(index), filePath: path }))));
    } });
    const error = await executeMultiPassReview(ctx).catch(error => error);
    expect(error).toBeInstanceOf(MultiPassError);
    expect(error.failure.stage).toBe("synthesis");

    reset();
    const incomplete = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: successCall([finding(0)], "incomplete") });
    const failed = await executeMultiPassReview(incomplete).catch(error => error);
    expect(failed).toBeInstanceOf(MultiPassError);
    expect(failed.failure.stage).toBe("batch");
  });

  it("stops on cancellation or a stale PR revision before dispatch", async () => {
    reset();
    const stale = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: successCall(), confirmCurrent: async () => "stale-review" });
    const error = await executeMultiPassReview(stale).catch(error => error);
    expect(error.failure).toMatchObject({ stage: "batch", code: "stale-review" });
    expect(dispatchLog).toHaveLength(0);

    reset();
    const controller = new AbortController();
    controller.abort(new DOMException("Review cancelled", "AbortError"));
    const cancelled = context({ plan: planFor(4, 8_000, { thresholdChars: 1 }), call: successCall(), signal: controller.signal });
    const stopped = await executeMultiPassReview(cancelled).catch(error => error);
    expect(stopped).toBeInstanceOf(Error);
    expect(dispatchLog).toHaveLength(0);
  });

  it("reuses completed passes after a worker restart without a second dispatch", async () => {
    reset();
    const first = context({ plan: planFor(3, 8_000, { thresholdChars: 1 }), call: successCall() });
    await executeMultiPassReview(first);
    const firstDispatches = [...dispatchLog];
    dispatchLog.length = 0;
    const second = context({ plan: planFor(3, 8_000, { thresholdChars: 1 }), call: successCall() });
    await executeMultiPassReview(second);
    expect(dispatchLog).toHaveLength(0);
    expect(firstDispatches.filter(entry => entry === "batch")).toHaveLength(first.plan.batches.length);
    expect(second.coverage.assessment?.state).toBe("completed");
  });

  it("enforces the durable per-step request budget", async () => {
    reset();
    allowClaims = false;
    store.set("pr:1:batch:0", { identity: "other", status: "pending", claims: 1, result: null, failureCode: null });
    const ctx = context({ plan: planFor(3, 8_000, { thresholdChars: 1 }), call: successCall() });
    const error = await executeMultiPassReview(ctx).catch(error => error);
    expect(error.failure).toMatchObject({ stage: "batch", code: "plan-changed" });
    expect(dispatchLog).toHaveLength(0);
  });

  it("records per-step usage idempotently through the usage callback", async () => {
    reset();
    const usage: string[] = [];
    const ctx = context({ plan: planFor(3, 8_000, { thresholdChars: 1 }), call: successCall() });
    ctx.onUsage = async stepKey => { usage.push(stepKey); };
    await executeMultiPassReview(ctx);
    expect(usage.filter(step => step.startsWith("batch:"))).toHaveLength(ctx.plan.batches.length);
    expect(usage).toContain("synthesis");
    expect(new Set(usage).size).toBe(usage.length);
  });
});
