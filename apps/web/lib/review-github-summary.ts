import type { InlineFinding } from "@/lib/review-dedup";
import { coverageSummary, reviewAssessmentComplete, type ReviewCoverage } from "@/lib/review-coverage";

/**
 * Deterministic GitHub review presentation.
 *
 * The public GitHub comment must stay short, must never expose raw model
 * reasoning, and must never exceed GitHub's per-comment size cap. Everything
 * here is derived from already-validated findings and the archived review
 * record; no additional model request is made.
 */

/** Mirrors `MAX_GITHUB_COMMENT_BODY` in `github.ts`. */
export const MAX_GITHUB_COMMENT_CHARS = 64_000;
/** Leave room for the publisher's reconciliation marker and footer. */
const SUMMARY_BUDGET = 63_000;

const SEVERITY_ORDER: Record<string, number> = { "🔴": 0, "🟠": 1, "🟡": 2, "🔵": 3, "💡": 4 };
const SEVERITY_LABEL: Record<string, string> = { "🔴": "Critical", "🟠": "High", "🟡": "Medium", "🔵": "Low", "💡": "Nit" };

const FIELD_LIMITS = {
  title: 200,
  category: 60,
  filePath: 300,
  description: 1_200,
  suggestion: 2_000,
  minimumFixScope: 600,
  suggestedRegressionTest: 1_200,
  presentation: 400,
} as const;

export type GitHubReviewSummaryInput = {
  coverage: ReviewCoverage;
  attemptId: string;
  headSha: string | null;
  prTitle?: string | null;
  presentationBody?: string;
  findings: InlineFinding[];
  reviewHistoryUrl?: string | null;
  reReview?: boolean;
  resolvedCount?: number;
  /** Existing check conclusion; the merge verdict comes from this, not the score. */
  checkConclusion?: CheckConclusion;
};

export type AgentPromptDetail = "full" | "compact" | "minimal";
export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "timed_out";
export type ReviewVerdict = "Ready to merge" | "Changes required" | "Not assessed" | "No review required";

/** Unescaped pipe splitting, matching the review score table parser. */
function tableCells(line: string): string[] {
  const cells: string[] = []; let start = 0; let slashes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && slashes % 2 === 0) { cells.push(line.slice(start, i)); start = i + 1; }
    slashes = line[i] === "\\" ? slashes + 1 : 0;
  }
  cells.push(line.slice(start)); return cells;
}

/**
 * The reconciled Overall quality rating from the archived ### Score table.
 * Returns null for a missing, malformed or "Not assessed" row.
 */
export function extractOverallScore(body: string | null | undefined): number | null {
  if (!body) return null;
  const section = /^### Score[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]|(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const rows = section.split(/\r?\n/).filter(line => line.trimStart().startsWith("|")
    && tableCells(line)[1]?.trim().replaceAll("**", "") === "Overall");
  // Exactly one Overall row is required; a duplicate or malformed row is not a
  // usable overall quality rating.
  if (rows.length !== 1) return null;
  const cells = tableCells(rows[0]);
  if (cells.length !== 5) return null;
  const token = cells[2]?.trim().replaceAll("**", "") ?? "";
  const match = /^([1-5])\s*\/\s*5$/.exec(token);
  return match ? Number(match[1]) : null;
}

/** Merge readiness comes from the assessment and check conclusion, never the score. */
export function reviewVerdict(coverage: ReviewCoverage, conclusion: CheckConclusion): ReviewVerdict {
  if (reviewAssessmentComplete(coverage) && coverage.assessment?.state === "not-required") return "No review required";
  // Only a completed, validated assessment can authorize a merge verdict.
  // Incomplete, invalid, cancelled, timed-out and neutral outcomes never imply
  // the PR is ready.
  if (!reviewAssessmentComplete(coverage) || coverage.assessment?.state !== "completed") return "Not assessed";
  if (conclusion === "success") return "Ready to merge";
  if (conclusion === "failure") return "Changes required";
  return "Not assessed";
}

export function formatReviewScore(score: number | null): string {
  return score === null ? "N/A" : `${score}/5`;
}

/** Compact check-run output title, e.g. "4/5 · Ready to merge". */
export function formatCheckTitle(score: number | null, verdict: ReviewVerdict): string {
  return `${formatReviewScore(score)} · ${verdict}`;
}

export function formatCheckRunTitle(input: {
  coverage: ReviewCoverage;
  conclusion: CheckConclusion;
  score?: number | null;
}): string {
  const assessed = reviewAssessmentComplete(input.coverage) && input.coverage.assessment?.state === "completed";
  // Only a completed success/failure review may present the Overall rating.
  const scoreable = assessed && (input.conclusion === "success" || input.conclusion === "failure");
  return formatCheckTitle(scoreable ? input.score ?? null : null, reviewVerdict(input.coverage, input.conclusion));
}


/** Remove reasoning tags/fences without touching code formatting. */
export function stripReasoningTags(text: string): string {
  return text
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/thinking>/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/```(?:thinking|reasoning)[^\n]*\r?\n[\s\S]*?```/gi, "");
}

/** Strip leaked model reasoning and normalize prose whitespace. */
export function stripReasoningArtifacts(text: string): string {
  if (!text) return "";
  return stripReasoningTags(text)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Slice without bisecting a UTF-16 surrogate pair (GitHub rejects malformed text). */
function cutSafe(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Single-line field: strip reasoning, collapse whitespace, cap length. */
function cleanLine(value: string | null | undefined, max: number): string {
  return cutSafe(stripReasoningArtifacts(value ?? "").replace(/\s+/g, " ").trim(), max);
}

/**
 * Multi-line field (code suggestion / regression test): strip reasoning but
 * preserve indentation and fences, then cap at a fence boundary.
 */
function cleanBlock(value: string | null | undefined, max: number): string {
  const stripped = stripReasoningTags(value ?? "").trim();
  if (!stripped) return "";
  if (stripped.length <= max) return stripped;
  let cut = cutSafe(stripped, max);
  // Close an open fence so truncated Markdown stays valid.
  if (((cut.match(/```/g) ?? []).length) % 2 === 1) cut += "\n```";
  return `${cut.trimEnd()}…`;
}

function isKnownSeverity(severity: string | undefined): severity is string {
  return typeof severity === "string" && Object.prototype.hasOwnProperty.call(SEVERITY_LABEL, severity);
}

/**
 * Drop findings that are structurally unusable and sanitize every
 * model-derived field. Guarantees the formatter never publishes malformed or
 * reasoning-leaking findings.
 */
export function sanitizeFindings(findings: InlineFinding[]): InlineFinding[] {
  const out: InlineFinding[] = [];
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const severity = typeof f.severity === "string" ? f.severity.trim() : "";
    if (!isKnownSeverity(severity)) continue;
    const title = cleanLine(f.title, FIELD_LIMITS.title);
    const filePath = cleanLine(f.filePath, FIELD_LIMITS.filePath);
    const startLine = Number.isFinite(f.startLine) ? Math.max(1, Math.trunc(f.startLine)) : 0;
    if (!title || !filePath || !startLine) continue;
    const endLine = Number.isFinite(f.endLine) ? Math.max(startLine, Math.trunc(f.endLine)) : startLine;
    out.push({
      ...f,
      severity,
      title,
      filePath,
      startLine,
      endLine,
      category: cleanLine(f.category, FIELD_LIMITS.category),
      description: cleanBlock(f.description, FIELD_LIMITS.description),
      suggestion: cleanBlock(f.suggestion, FIELD_LIMITS.suggestion),
      minimumFixScope: f.minimumFixScope ? cleanLine(f.minimumFixScope, FIELD_LIMITS.minimumFixScope) : undefined,
      suggestedRegressionTest: f.suggestedRegressionTest
        ? cleanBlock(f.suggestedRegressionTest, FIELD_LIMITS.suggestedRegressionTest)
        : undefined,
    });
  }
  return out;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

function escapeFence(text: string): string {
  return text.replace(/```/g, "``\u200b`");
}

function historyLink(url: string | null | undefined): string {
  return url ? `[Complete Review History](${url})` : "Complete Review History";
}

function verdictFor(findings: InlineFinding[]): string {
  if (findings.length === 0) return "No actionable findings";
  const hasBlocking = findings.some((f) => (SEVERITY_ORDER[f.severity] ?? 99) <= 2);
  return hasBlocking ? "Action required" : "Suggestions found";
}

function extractPrSummary(presentationBody: string | undefined, prTitle?: string | null): string {
  if (presentationBody) {
    const cleaned = stripReasoningArtifacts(presentationBody);
    const m = /^### Summary[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}\s|\n<!-- OCTOPUS_FINDINGS_START -->|$)/im.exec(cleaned);
    if (m) {
      const text = m[1].replace(/\s+/g, " ").trim();
      if (text) {
        const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
        if (sentences && sentences.length > 0) {
          return cutSafe(sentences.slice(0, 2).map((s) => s.trim()).join(" ").trim(), FIELD_LIMITS.presentation);
        }
        return cutSafe(text, FIELD_LIMITS.presentation);
      }
    }
  }
  const title = stripReasoningArtifacts(prTitle ?? "").replace(/\s+/g, " ").trim();
  return title ? `Reviews changes in "${cutSafe(title, 200)}".` : "Reviews the submitted changes.";
}

function sortFindings(findings: InlineFinding[]): InlineFinding[] {
  return [...findings].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99;
    const sb = SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return a.startLine - b.startLine;
  });
}

function lineRef(f: InlineFinding): string {
  return f.startLine === f.endLine ? `L${f.startLine}` : `L${f.startLine}-L${f.endLine}`;
}

/**
 * Build the copy-pasteable agent prompt. `full` carries every field; `compact`
 * drops prose; `minimal` keeps only title + location so an oversized review can
 * still list every selected finding within GitHub's limit.
 */
export function formatFixWithAgentPrompt(
  input: Pick<GitHubReviewSummaryInput, "headSha">,
  sorted: InlineFinding[],
  detail: AgentPromptDetail = "full",
): string {
  const findings = sanitizeFindings(sorted);
  const head = input.headSha && /^[0-9a-f]{40}$/i.test(input.headSha) ? input.headSha : "the current PR HEAD commit";
  const lines: string[] = [];
  lines.push("You are fixing issues found by Octopus Review on this pull request.");
  lines.push(`Before modifying code, verify you are on the current PR HEAD (${head}). If HEAD has changed, re-check each finding against the latest code and skip anything already fixed or no longer applicable.`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("No actionable findings to fix.");
  } else {
    lines.push(`Apply fixes for all ${findings.length} actionable finding(s) below, respecting each minimum fix scope. Add or update the suggested regression tests where applicable.`);
    lines.push("");
    findings.forEach((f, i) => {
      const sev = SEVERITY_LABEL[f.severity] ?? "Finding";
      lines.push(`Finding ${i + 1} [${sev}] ${f.title}`);
      lines.push(`Location: ${f.filePath}:${lineRef(f)}`);
      if (detail === "minimal") {
        lines.push("");
        return;
      }
      if (f.category) lines.push(`Category: ${f.category}`);
      if (detail === "full" && f.description) lines.push(`Description: ${f.description}`);
      if (detail === "full" && f.suggestion) lines.push(`Suggested fix:\n${f.suggestion}`);
      lines.push(`Minimum fix scope: ${f.minimumFixScope || "Apply the smallest safe change that resolves this finding."}`);
      if (f.suggestedRegressionTest) {
        lines.push(`Regression test:\n${f.suggestedRegressionTest}`);
      } else {
        lines.push("Regression test: Add or update a focused test that would fail before the fix and pass after it, if applicable.");
      }
      lines.push("");
    });
  }
  lines.push("After changes: run relevant tests/lint/typecheck for touched code and ensure no unrelated behavior changes.");
  return escapeFence(lines.join("\n").trimEnd());
}

type DocumentParts = {
  /** Finding disposition shown in the detail line. */
  findingVerdict: string;
  /** Merge disposition derived from the assessment and check conclusion. */
  mergeVerdict: ReviewVerdict;
  score: number | null;
  status: string;
  headSha: string | null;
  summary: string;
  findings: InlineFinding[];
  historyUrl?: string | null;
};

function renderHeader(p: DocumentParts): string[] {
  return [
    `## 🐙 Octopus Review — ${formatCheckTitle(p.score, p.mergeVerdict)}`,
    "",
    `**Verdict:** ${p.findingVerdict}`,
    `**Status:** ${p.status}`,
    p.headSha
      ? `**Reviewed commit:** \`${p.headSha}\` · ${historyLink(p.historyUrl)}`
      : `**Review record:** ${historyLink(p.historyUrl)}`,
    "",
    p.summary,
  ];
}

function renderDocument(p: DocumentParts, detail: AgentPromptDetail): string {
  const lines = renderHeader(p);
  lines.push("");
  if (p.findings.length === 0) {
    lines.push("No actionable findings were identified in the reviewed scope.");
  } else {
    lines.push(`### Actionable findings (${p.findings.length})`, "");
    lines.push("| Severity | Location | Finding |");
    lines.push("|----------|----------|---------|");
    const titleLimit = detail === "full" ? FIELD_LIMITS.title : 120;
    for (const f of p.findings) {
      const sev = `${f.severity} ${SEVERITY_LABEL[f.severity] ?? ""}`.trim();
      const loc = `\`${escapeCell(f.filePath)}:${lineRef(f)}\``;
      lines.push(`| ${sev} | ${loc} | ${escapeCell(cutSafe(f.title, titleLimit))} |`);
    }
  }
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>🤖 Fix with Agent</summary>");
  lines.push("");
  lines.push("```text");
  lines.push(formatFixWithAgentPrompt({ headSha: p.headSha }, p.findings, detail));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

/**
 * Last-resort bounded document: a concise summary plus as many one-line
 * findings as fit, with an explicit overflow note pointing at the archive.
 */
function renderOversized(p: DocumentParts): string {
  const header = renderHeader(p).join("\n");
  const budget = SUMMARY_BUDGET - header.length - 600;
  const rows: string[] = [];
  let used = 0;
  for (const f of p.findings) {
    const row = `- [${SEVERITY_LABEL[f.severity] ?? "Finding"}] ${escapeCell(cutSafe(f.title, 80))} — \`${escapeCell(cutSafe(f.filePath, 80))}:${lineRef(f)}\``;
    if (used + row.length + 1 > budget) break;
    rows.push(row);
    used += row.length + 1;
  }
  const omitted = p.findings.length - rows.length;
  const parts = [header, "", "### Actionable findings"];
  if (rows.length > 0) parts.push(rows.join("\n"));
  if (omitted > 0) {
    parts.push(`> **${omitted} additional finding${omitted === 1 ? "" : "s"} omitted from this comment for size.** The full record is in ${historyLink(p.historyUrl)}.`);
  }
  const doc = parts.join("\n");
  // The budget math above is conservative, but guarantee the hard cap anyway.
  return doc.length > MAX_GITHUB_COMMENT_CHARS
    ? `${cutSafe(doc, SUMMARY_BUDGET)}\n\n> **Comment truncated for GitHub size limits.** See ${historyLink(p.historyUrl)}.`
    : doc;
}

function fitDocument(p: DocumentParts): string {
  for (const detail of ["full", "compact", "minimal"] as const) {
    const doc = renderDocument(p, detail);
    if (doc.length <= SUMMARY_BUDGET) return doc;
  }
  return renderOversized(p);
}

/** Concise failure text shared by invalid assessments and hard failures. */
export function formatFailureSummary(input: {
  reason?: string | null;
  /** Deterministic coverage disposition shown before the failure reason. */
  coverageNote?: string | null;
  headSha?: string | null;
  reviewHistoryUrl?: string | null;
}): string {
  const detail = cutSafe(stripReasoningArtifacts(input.reason ?? "").replace(/\s+/g, " ").trim(), 300)
    || "Assessment invalid or incomplete.";
  const status = [stripReasoningArtifacts(input.coverageNote ?? "").trim(), detail].filter(Boolean).join(" — ");
  const history = input.reviewHistoryUrl
    ? ` [Complete Review History](${input.reviewHistoryUrl}).`
    : " Complete Review History is available from the review record.";
  const head = input.headSha ? ` Reviewed commit: \`${input.headSha}\`.` : "";
  return [
    "## 🐙 Octopus Review — N/A · Not assessed",
    "",
    "**Verdict:** Assessment unavailable",
    `**Status:** ${status}${head}`,
    "",
    "This attempt did not produce a validated, authoritative review. No unvalidated findings are shown." + history,
  ].join("\n");
}

export function formatInvalidAssessmentSummary(
  input: Omit<GitHubReviewSummaryInput, "findings" | "presentationBody"> & { reason?: string },
): string {
  return formatFailureSummary({
    coverageNote: coverageSummary(input.coverage),
    reason: input.reason || input.coverage.assessment?.reason,
    headSha: input.headSha,
    reviewHistoryUrl: input.reviewHistoryUrl,
  });
}

export function formatGitHubReviewSummary(input: GitHubReviewSummaryInput): string {
  const { coverage } = input;
  const complete = reviewAssessmentComplete(coverage) && coverage.assessment?.state === "completed";
  if (!complete) {
    // "not-required" is a valid, non-failing outcome; everything else is invalid.
    if (reviewAssessmentComplete(coverage) && coverage.assessment?.state === "not-required") {
      return renderDocument({
        findingVerdict: "No review required",
        mergeVerdict: "No review required",
        score: null,
        status: coverageSummary(coverage),
        headSha: input.headSha,
        summary: "No changed paths in this pull request require review under the repository policy.",
        findings: [],
        historyUrl: input.reviewHistoryUrl,
      }, "minimal");
    }
    return formatInvalidAssessmentSummary(input);
  }

  const findings = sortFindings(sanitizeFindings(input.findings));
  const conclusion: CheckConclusion = input.checkConclusion
    ?? (findings.some((f) => f.severity === "🔴") ? "failure" : "success");
  // Only a completed success/failure review may present the Overall rating;
  // neutral, cancelled, timed-out and invalid outcomes show N/A.
  const score = conclusion === "success" || conclusion === "failure"
    ? extractOverallScore(input.presentationBody)
    : null;
  return fitDocument({
    findingVerdict: verdictFor(findings),
    mergeVerdict: reviewVerdict(coverage, conclusion),
    score,
    status: `${coverageSummary(coverage)}${input.reReview && input.resolvedCount ? ` (${input.resolvedCount} resolved)` : ""}`,
    headSha: input.headSha,
    summary: extractPrSummary(input.presentationBody, input.prTitle),
    findings,
    historyUrl: input.reviewHistoryUrl,
  });
}

export type LargeReviewSummaryInput = {
  findings: InlineFinding[];
  headSha: string | null;
  prTitle?: string | null;
  reviewHistoryUrl?: string | null;
};

/**
 * Compact output for the large-PR pipeline. The large worker does not carry a
 * verified changed-file coverage record, so the status states that explicitly
 * instead of borrowing the normal review's coverage summary.
 */
export function formatLargeReviewSummary(input: LargeReviewSummaryInput): string {
  const findings = sortFindings(sanitizeFindings(input.findings));
  const title = stripReasoningArtifacts(input.prTitle ?? "").replace(/\s+/g, " ").trim();
  return fitDocument({
    findingVerdict: verdictFor(findings),
    // The large pipeline has no verified coverage assessment or validated
    // overall score, so it must not imply the PR is ready to merge.
    mergeVerdict: "Not assessed",
    score: null,
    status: "Large-PR review · no inline comments · changed-file coverage not verified",
    headSha: input.headSha,
    summary: title
      ? `Reviews changes in "${cutSafe(title, 200)}". Findings below come from the large-PR pipeline; re-check each against the current code before fixing.`
      : "Findings below come from the large-PR pipeline; re-check each against the current code before fixing.",
    findings,
    historyUrl: input.reviewHistoryUrl,
  });
}
