import "server-only";
import type { AiCreateParams, AiResponse } from "@/lib/providers";
import { AiProviderFailure, classifyFailure, safeErrorDetails } from "@/lib/provider-failure";
import type { ReviewCoverage } from "@/lib/review-coverage";
import { coverageSummary, sha256 } from "@/lib/review-coverage";
import { parseFindingsFromJson, deduplicateAgainstPrior, extractKeywords, type InlineFinding, type PriorFinding } from "@/lib/review-dedup";
import { MAX_FINDINGS_PER_REVIEW, sortAndCapFindings } from "@/lib/review-helpers";
import { prepareReviewComment } from "@/lib/review-comment-context";
import { stripLoneSurrogates } from "@/lib/providers/sanitize";
import { REVIEW_MAX_TOKENS } from "@/lib/constants";
import { COMPLETE_REVIEW_POLICY, withinReviewWindow, type ReviewExecutionWindow } from "@/lib/review-capacity";
import { executeCoveredReview } from "@/lib/review-assessment";
import { claimReviewPass, completeReviewPass, failReviewPass, type ReviewPassKey } from "@/lib/review-pass-outcome";
import { reviewPassIdentity, type ReviewBatch, type ReviewBatchPlan, type ReviewBatchSection } from "@/lib/review-batching";

const FINDINGS_START = "<!-- OCTOPUS_FINDINGS_START -->";
const FINDINGS_END = "<!-- OCTOPUS_FINDINGS_END -->";
const PASS_CLAIM_LIMIT = 2;
const SEVERITIES = ["🔴", "🟠", "🟡", "🔵", "💡"] as const;

const BATCH_MODE = `<BATCH_MODE>
You are reviewing ONE bounded batch of a large pull request. Other batches cover the remaining files and a final pass consolidates everything into one authoritative review.
Output ONLY the mandatory findings JSON block (${FINDINGS_START} / ${FINDINGS_END}) with a JSON array of findings from THIS batch. Use the exact original file paths and original diff line numbers. Do not emit a report, score table, summary, conclusions or commentary outside the markers. An empty array [] is expected when the batch has no issues. Never invent a finding that is not supported by the supplied diff.
</BATCH_MODE>`;

const SYNTHESIS_MODE = `<SYNTHESIS_MODE>
You are consolidating several batch reviews into ONE authoritative Octopus review. The authoritative findings are supplied verbatim below; copy that array into the mandatory findings JSON block unchanged and make the Findings Summary counts match it exactly. Produce every mandatory report section (Summary, Score, Risk Assessment, Findings Summary, Positive Highlights, Important Files Changed, Last reviewed commit and Checklist). Base the narrative and scores only on the supplied findings and the supplied change summary. Do not add findings that are not in the authoritative array.
</SYNTHESIS_MODE>`;

export type MultiPassStage = "planning" | "batch" | "synthesis" | "consolidation";

export type MultiPassFailure = {
  stage: MultiPassStage;
  stepKey: string | null;
  /** Sanitized, log-safe code. Never contains a raw provider response. */
  code: string;
  message: string;
};

export class MultiPassError extends Error {
  constructor(public readonly failure: MultiPassFailure) {
    super(failure.message);
    this.name = "MultiPassError";
  }
}

/** Record a sanitized multi-pass failure so published diagnostics name the stage that failed. */
export function recordMultiPassFailure(coverage: ReviewCoverage, failure: MultiPassFailure): void {
  if (coverage.assessment) return;
  coverage.assessment = {
    state: "incomplete",
    reason: `Multi-pass review failed at ${failure.stage}${failure.stepKey ? ` (${failure.stepKey})` : ""}: ${failure.code}`,
    model: null,
    policySha256: sha256("review-multipass-failed-v1"),
    templateSha256: sha256("review-multipass-failed-v1"),
    requests: [], responseSha256: null, completion: null,
  };
}

export type StoredPassResult = {
  findings: InlineFinding[];
  responseSha256: string;
};

export type StoredSynthesisResult = {
  response: AiResponse;
  assessment: NonNullable<ReviewCoverage["assessment"]>;
};

export type MultiPassContext = {
  plan: ReviewBatchPlan;
  coverage: ReviewCoverage;
  organizationId: string;
  repositoryId: string;
  pullRequestId: string;
  requestVersion: number;
  model: string;
  number: number;
  title: string;
  author: string;
  comment: string;
  repoConfig: string;
  /** Fully substituted shared prompt. Kept byte-identical across batches so prompt caching applies. */
  systemPrompt: string;
  /** Raw prompt template used for the assessment receipt. */
  template: string;
  window?: ReviewExecutionWindow;
  signal: AbortSignal;
  call: (request: AiCreateParams) => Promise<AiResponse>;
  /** Rechecks head, request version, org access and billing before a dispatch. */
  confirmCurrent: (signal: AbortSignal) => Promise<string | null>;
  credentialUnchanged: (failure: AiProviderFailure) => Promise<boolean>;
  onUsage: (stepKey: string, response: AiResponse) => Promise<void>;
  batchLimitMs?: number;
};

function passKey(ctx: MultiPassContext, stepKey: string): ReviewPassKey {
  return { organizationId: ctx.organizationId, repositoryId: ctx.repositoryId,
    pullRequestId: ctx.pullRequestId, requestVersion: ctx.requestVersion, stepKey };
}

function safeCode(error: unknown): string {
  if (error instanceof AiProviderFailure) {
    return classifyFailure(safeErrorDetails(error.details), error.keyOwner, "generation").code;
  }
  if (!(error instanceof Error)) return "unclassified";
  const status = "status" in error ? Number(error.status) : 0;
  if (status >= 400 && status <= 599) return `http_${status}`;
  const code = "code" in error ? String(error.code ?? "") : "";
  return /^[A-Za-z0-9_]{1,48}$/.test(code) ? code : "unclassified";
}

function fail(stage: MultiPassStage, stepKey: string | null, code: string, message: string): MultiPassError {
  return new MultiPassError({ stage, stepKey, code, message });
}

/** Strict batch-level findings validation; malformed entries can never become authoritative. */
export function validateBatchFindings(text: string, allowedPaths: Set<string>): { findings: InlineFinding[]; error: string | null } {
  if (text.split(FINDINGS_START).length !== 2 || text.split(FINDINGS_END).length !== 2) {
    return { findings: [], error: "Batch findings markers missing or duplicated" };
  }
  const block = text.slice(text.indexOf(FINDINGS_START) + FINDINGS_START.length, text.indexOf(FINDINGS_END)).trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(block);
  let raw: unknown;
  try {
    raw = JSON.parse(fenced ? fenced[1] : block);
  } catch {
    return { findings: [], error: "Batch findings JSON is malformed" };
  }
  if (!Array.isArray(raw)) return { findings: [], error: "Batch findings JSON is not an array" };
  const parsed = parseFindingsFromJson(text) ?? [];
  if (parsed.length !== raw.length) return { findings: [], error: "Batch findings entries are malformed" };
  for (const finding of parsed) {
    if (!SEVERITIES.includes(finding.severity as typeof SEVERITIES[number])
      || !finding.title.trim() || !allowedPaths.has(finding.filePath)
      || !Number.isInteger(finding.startLine) || finding.startLine < 1
      || !Number.isInteger(finding.endLine) || finding.endLine < finding.startLine
      || !finding.description.trim()) return { findings: [], error: "Batch finding fields are invalid" };
  }
  return { findings: parsed, error: null };
}

/** Bounded, ordered merge of batch findings with the existing dedup logic. */
export function mergeBatchFindings(results: StoredPassResult[]): InlineFinding[] {
  let kept: InlineFinding[] = [];
  for (const result of results) {
    const prior: PriorFinding[] = kept.map(finding => ({
      filePath: finding.filePath, line: finding.startLine, title: finding.title,
      keywords: extractKeywords(`${finding.title} ${finding.description}`),
    }));
    kept = [...kept, ...deduplicateAgainstPrior(result.findings, prior).kept];
  }
  return sortAndCapFindings(kept, MAX_FINDINGS_PER_REVIEW).kept;
}

/**
 * Deterministically restore the authoritative findings block and matching table
 * counts in a synthesis response. Presentation only: no finding is added or
 * removed, and no score is changed. If the structure is missing, the existing
 * full validator will reject the response instead.
 */
export function enforceAuthoritativeFindings(text: string, findings: InlineFinding[]): string {
  const start = text.indexOf(FINDINGS_START);
  const end = text.indexOf(FINDINGS_END);
  if (start < 0 || end <= start || text.indexOf(FINDINGS_START, start + 1) >= 0 || text.indexOf(FINDINGS_END, end + 1) >= 0) return text;
  const existing = text.slice(start + FINDINGS_START.length, end);
  const fenced = /```json/.test(existing);
  const json = JSON.stringify(findings, null, 2);
  const block = fenced
    ? `${FINDINGS_START}\n\`\`\`json\n${json}\n\`\`\`\n${FINDINGS_END}`
    : `${FINDINGS_START}\n${json}\n${FINDINGS_END}`;
  const counts = new Map<string, number>(SEVERITIES.map(severity => [severity, 0]));
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const table = `| Severity | Count |\n| --- | --- |\n${SEVERITIES.map((severity, index) => `| ${severity} ${["Critical", "High", "Medium", "Low", "Nit"][index]} | ${counts.get(severity) ?? 0} |`).join("\n")}`;
  const patched = text.slice(0, start) + block + text.slice(end + FINDINGS_END.length);
  return patched.replace(/(### Findings Summary)[ \t]*\r?\n[\s\S]*?(?=^#{1,6}[ \t]|\r?\n?<!-- OCTOPUS_FINDINGS_START -->|(?![\s\S]))/m,
    `$1\n\n${table}\n\n`);
}

function buildBatchRequest(ctx: MultiPassContext, batch: ReviewBatch): AiCreateParams {
  const comment = prepareReviewComment(ctx.comment).block;
  const content = `Review batch ${batch.index + 1} of ${ctx.plan.batches.length} for PR #${ctx.number}: ${JSON.stringify(ctx.title)}\n` +
    `Author: ${JSON.stringify(ctx.author)}\n\nFiles in this batch:\n${batch.files.map(file => `- ${file}`).join("\n")}\n\n` +
    `${comment}${comment && ctx.repoConfig ? "\n\n" : ""}${ctx.repoConfig}${ctx.repoConfig ? "\n\n" : ""}` +
    `${coverageSummary(ctx.coverage)}\n\n<diff>\n${batch.diff}\n</diff>`;
  return {
    model: ctx.model, maxTokens: REVIEW_MAX_TOKENS, system: stripLoneSurrogates(`${ctx.systemPrompt}\n\n${BATCH_MODE}`),
    cacheSystem: true, maxRetries: 0, messages: [{ role: "user", content: stripLoneSurrogates(content) }],
  };
}

function buildSynthesisRequest(ctx: MultiPassContext, findings: InlineFinding[]): AiCreateParams {
  const comment = prepareReviewComment(ctx.comment).block;
  const content = `Consolidate the batch reviews for PR #${ctx.number}: ${JSON.stringify(ctx.title)}\n` +
    `Author: ${JSON.stringify(ctx.author)}\n\n${comment}${comment && ctx.repoConfig ? "\n\n" : ""}${ctx.repoConfig}${ctx.repoConfig ? "\n\n" : ""}` +
    `${coverageSummary(ctx.coverage)}\n\n<authoritative-findings>\n${JSON.stringify(findings, null, 2)}\n</authoritative-findings>`;
  return {
    model: ctx.model, maxTokens: REVIEW_MAX_TOKENS, system: stripLoneSurrogates(`${ctx.systemPrompt}\n\n${SYNTHESIS_MODE}`),
    cacheSystem: true, maxRetries: 0, messages: [{ role: "user", content: stripLoneSurrogates(content) }],
  };
}

function batchIdentity(ctx: MultiPassContext, batch: ReviewBatch, promptSha256: string): string {
  return reviewPassIdentity({ headSha: ctx.coverage.headSha, requestVersion: ctx.requestVersion, model: ctx.model,
    stepKey: batch.stepKey, sections: batch.sections, promptSha256 });
}

function synthesisIdentity(ctx: MultiPassContext, findings: InlineFinding[], promptSha256: string): string {
  const sections: ReviewBatchSection[] = [{ path: "authoritative-findings", text: "", chars: 0, sha256: sha256(JSON.stringify(findings)) }];
  return reviewPassIdentity({ headSha: ctx.coverage.headSha, requestVersion: ctx.requestVersion, model: ctx.model,
    stepKey: "synthesis", sections, promptSha256 });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("Review cancelled"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Review cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function boundedCall(ctx: MultiPassContext, request: AiCreateParams): Promise<AiResponse> {
  ctx.signal.throwIfAborted();
  if (!ctx.window) return ctx.call({ ...request, signal: ctx.signal });
  return withinReviewWindow(ctx.window, Math.max(1, ctx.window.remainingMs() - COMPLETE_REVIEW_POLICY.publicationReserveMs),
    signal => ctx.call({ ...request, signal: AbortSignal.any([signal, ctx.signal]) }));
}

async function runBatch(ctx: MultiPassContext, batch: ReviewBatch, promptSha256: string): Promise<StoredPassResult> {
  const stepKey = batch.stepKey;
  const identity = batchIdentity(ctx, batch, promptSha256);
  const key = passKey(ctx, stepKey);
  const started = Date.now();
  const claim = await claimReviewPass(key, { kind: "batch", identity, limit: PASS_CLAIM_LIMIT });
  if (claim.completed) {
    const stored = claim.result as StoredPassResult | null;
    if (!stored || !Array.isArray(stored.findings) || typeof stored.responseSha256 !== "string") {
      throw fail("batch", stepKey, "stored-result-invalid", "A completed batch has no reusable result");
    }
    console.log(`[review-multipass] batch ${batch.index + 1}/${ctx.plan.batches.length} reused files=${batch.files.length}`);
    return stored;
  }
  if (!claim.allowed) throw fail("batch", stepKey, claim.reason ?? "claim-refused", "Batch review could not be claimed");

  let lastCode = "unclassified";
  for (let attempt = 0; attempt < PASS_CLAIM_LIMIT; attempt++) {
    if (attempt > 0) {
      const retry = await claimReviewPass(key, { kind: "batch", identity, limit: PASS_CLAIM_LIMIT });
      if (!retry.allowed) throw fail("batch", stepKey, retry.reason ?? "claim-refused", "Batch retry could not be claimed");
      await delay(1_000, ctx.signal);
    }
    const stale = await ctx.confirmCurrent(ctx.signal);
    if (stale) throw fail("batch", stepKey, stale, "Review became stale before a batch request");
    try {
      const response = await boundedCall(ctx, buildBatchRequest(ctx, batch));
      const validation = validateBatchFindings(response.text, new Set(batch.files));
      if (validation.error || response.completion?.state !== "completed") {
        const code = validation.error ? "invalid-batch-output" : "incomplete-provider";
        await failReviewPass(key, identity, code);
        throw fail("batch", stepKey, code, "Batch review did not produce valid findings");
      }
      await ctx.onUsage(stepKey, response);
      const result: StoredPassResult = { findings: validation.findings, responseSha256: sha256(response.text) };
      await completeReviewPass(key, identity, result, result.responseSha256);
      console.log(`[review-multipass] batch ${batch.index + 1}/${ctx.plan.batches.length} chars=${batch.chars} findings=${validation.findings.length} durationMs=${Date.now() - started}`);
      return result;
    } catch (error) {
      if (error instanceof MultiPassError) throw error;
      lastCode = safeCode(error);
      await failReviewPass(key, identity, lastCode);
      if (error instanceof AiProviderFailure) {
        const details = safeErrorDetails(error.details);
        const classification = classifyFailure(details, error.keyOwner, "generation");
        console.log(`[review-multipass] batch ${batch.index + 1} failure=${lastCode} retryability=${classification.retryability}`);
        if (classification.retryability === "transient" && attempt + 1 < PASS_CLAIM_LIMIT
          && await ctx.credentialUnchanged(error)) continue;
      }
      throw fail("batch", stepKey, lastCode, "Batch review failed");
    }
  }
  throw fail("batch", stepKey, lastCode, "Batch review failed after bounded attempts");
}

async function runSynthesis(ctx: MultiPassContext, findings: InlineFinding[], promptSha256: string): Promise<AiResponse> {
  const stepKey = "synthesis";
  const identity = synthesisIdentity(ctx, findings, promptSha256);
  const key = passKey(ctx, stepKey);
  const started = Date.now();
  const claim = await claimReviewPass(key, { kind: "synthesis", identity, limit: PASS_CLAIM_LIMIT });
  if (claim.completed) {
    const stored = claim.result as StoredSynthesisResult | null;
    if (!stored?.response?.text || !stored.assessment) throw fail("synthesis", stepKey, "stored-result-invalid", "Completed synthesis has no reusable result");
    ctx.coverage.assessment = structuredClone(stored.assessment);
    console.log(`[review-multipass] synthesis reused durationMs=${Date.now() - started}`);
    return stored.response;
  }
  if (!claim.allowed) throw fail("synthesis", stepKey, claim.reason ?? "claim-refused", "Final synthesis could not be claimed");
  const stale = await ctx.confirmCurrent(ctx.signal);
  if (stale) throw fail("synthesis", stepKey, stale, "Review became stale before final synthesis");
  try {
    const response = await executeCoveredReview(buildSynthesisRequest(ctx, findings), ctx.coverage, ctx.template,
      async request => {
        const raw = await ctx.call(request);
        return { ...raw, text: enforceAuthoritativeFindings(raw.text, findings) };
      },
      { window: ctx.window, confirm: async (failure, signal) => {
        if (signal.aborted || !await ctx.credentialUnchanged(failure)) return false;
        const retry = await claimReviewPass(key, { kind: "synthesis", identity, limit: PASS_CLAIM_LIMIT });
        if (!retry.allowed) return false;
        return await ctx.confirmCurrent(signal) === null;
      } });
    await ctx.onUsage(stepKey, response);
    const stored: StoredSynthesisResult = { response, assessment: structuredClone(ctx.coverage.assessment!) };
    await completeReviewPass(key, identity, stored, sha256(response.text));
    console.log(`[review-multipass] synthesis chars=${response.text.length} state=${ctx.coverage.assessment?.state} validation=${ctx.coverage.assessment?.responseValidation?.state ?? "none"} durationMs=${Date.now() - started}`);
    return response;
  } catch (error) {
    const code = safeCode(error);
    await failReviewPass(key, identity, code);
    throw fail("synthesis", stepKey, code, "Final synthesis failed");
  }
}

/**
 * Execute a bounded multi-pass review. Every stage is durably claimed, and a
 * successful consolidated assessment is required before a response is returned.
 */
export async function executeMultiPassReview(ctx: MultiPassContext): Promise<AiResponse> {
  if (ctx.plan.mode !== "multi" || !ctx.plan.batches.length) {
    throw fail("planning", null, "no-batch-plan", "Multi-pass review has no batch plan");
  }
  if (ctx.plan.error) throw fail("planning", null, "unsafe-batch-plan", "Large review cannot be covered safely by batches");
  console.log(`[review-multipass] selected=multi totalChars=${ctx.plan.totalChars} files=${ctx.plan.changedFiles} batches=${ctx.plan.batches.length} target=${ctx.plan.config.batchChars}`);
  const promptSha256 = sha256(`${ctx.systemPrompt}\n${BATCH_MODE}\n${SYNTHESIS_MODE}`);
  const results: StoredPassResult[] = [];
  for (const batch of ctx.plan.batches) results.push(await runBatch(ctx, batch, promptSha256));
  const findings = mergeBatchFindings(results);
  const response = await runSynthesis(ctx, findings, promptSha256);
  if (ctx.coverage.assessment?.state !== "completed") {
    throw fail("consolidation", "synthesis", "assessment-incomplete", ctx.coverage.assessment?.reason ?? "Consolidated assessment is incomplete");
  }
  return response;
}
