import type { InlineFinding } from "@/lib/review-dedup";
import { coverageSummary, reviewAssessmentComplete, type ReviewCoverage } from "@/lib/review-coverage";

const SEVERITY_ORDER: Record<string, number> = { "🔴": 0, "🟠": 1, "🟡": 2, "🔵": 3, "💡": 4 };
const SEVERITY_LABEL: Record<string, string> = { "🔴": "Critical", "🟠": "High", "🟡": "Medium", "🔵": "Low", "💡": "Nit" };

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
};

export function stripReasoningArtifacts(text: string): string {
  if (!text) return "";
  let out = text;
  out = out.replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "");
  out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<thinking\b[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<think\b[^>]*>[\s\S]*$/gi, "");
  out = out.replace(/<\/thinking>/gi, "");
  out = out.replace(/<\/think>/gi, "");
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
}

function escapeFence(text: string): string {
  return text.replace(/```/g, "``\u200b`");
}

function verdict(coverage: ReviewCoverage, findings: InlineFinding[]): string {
  if (!reviewAssessmentComplete(coverage) || coverage.assessment?.state !== "completed") {
    return "Assessment unavailable";
  }
  const hasBlocking = findings.some((f) => f.severity === "🔴" || f.severity === "🟠" || f.severity === "🟡");
  if (findings.length === 0) return "No actionable findings";
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
        if (sentences && sentences.length > 0) return sentences.slice(0, 2).map((s) => s.trim()).join(" ").trim().slice(0, 400);
        return text.slice(0, 400);
      }
    }
  }
  const title = (prTitle ?? "").replace(/\s+/g, " ").trim();
  return title ? `Reviews changes in "${title.slice(0, 200)}".` : "Reviews the submitted changes.";
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

export function formatFixWithAgentPrompt(input: GitHubReviewSummaryInput, sorted: InlineFinding[]): string {
  const head = input.headSha && /^[0-9a-f]{40}$/i.test(input.headSha) ? input.headSha : "the current PR HEAD commit";
  const lines: string[] = [];
  lines.push("You are fixing issues found by Octopus Review on this pull request.");
  lines.push(`Before modifying code, verify you are on the current PR HEAD (${head}). If HEAD has changed, re-check each finding against the latest code and skip anything already fixed or no longer applicable.`);
  lines.push("");
  if (sorted.length === 0) {
    lines.push("No actionable findings to fix.");
  } else {
    lines.push(`Apply fixes for all ${sorted.length} actionable finding(s) below, respecting each minimum fix scope. Add or update the suggested regression tests where applicable.`);
    lines.push("");
    sorted.forEach((f, i) => {
      const sev = SEVERITY_LABEL[f.severity] ?? "Finding";
      lines.push(`Finding ${i + 1} [${sev}] ${f.title}`);
      lines.push(`Location: ${f.filePath}:${lineRef(f)}`);
      if (f.category) lines.push(`Category: ${f.category}`);
      lines.push(`Description: ${f.description}`);
      if (f.suggestion) lines.push(`Suggested fix:\n${f.suggestion}`);
      lines.push(`Minimum fix scope: ${f.minimumFixScope?.trim() || "Apply the smallest safe change that resolves this finding."}`);
      if (f.suggestedRegressionTest?.trim()) {
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

export function formatInvalidAssessmentSummary(input: Omit<GitHubReviewSummaryInput, "findings" | "presentationBody"> & { reason?: string }): string {
  const reason = stripReasoningArtifacts(input.reason || input.coverage.assessment?.reason || coverageSummary(input.coverage) || "Assessment invalid or incomplete.")
    .replace(/\s+/g, " ").trim().slice(0, 300);
  const history = input.reviewHistoryUrl ? ` [Complete Review History](${input.reviewHistoryUrl}).` : " Complete Review History is available from the review record.";
  const head = input.headSha ? ` Reviewed commit: \`${input.headSha}\`.` : "";
  return [
    "## 🐙 Octopus Review",
    "",
    "**Verdict:** Assessment unavailable",
    `**Status:** ${reason}${head}`,
    "",
    "This attempt did not produce a validated, authoritative review. No unvalidated findings are shown." + history,
  ].join("\n");
}

function conciseFailureSummary(input: GitHubReviewSummaryInput): string {
  return formatInvalidAssessmentSummary(input);
}

export function formatGitHubReviewSummary(input: GitHubReviewSummaryInput): string {
  const { coverage } = input;
  const complete = reviewAssessmentComplete(coverage) && coverage.assessment?.state === "completed";
  if (!complete) return conciseFailureSummary(input);

  const sorted = sortFindings(input.findings);
  const v = verdict(coverage, sorted);
  const prSummary = extractPrSummary(input.presentationBody, input.prTitle);
  const cov = coverageSummary(coverage);
  const historyLink = input.reviewHistoryUrl ? `[Complete Review History](${input.reviewHistoryUrl})` : "Complete Review History";
  const head = input.headSha ? `\`${input.headSha}\`` : "`unknown`";

  const parts: string[] = [];
  parts.push("## 🐙 Octopus Review");
  parts.push("");
  parts.push(`**Verdict:** ${v}`);
  parts.push(`**Status:** ${cov}${input.reReview && input.resolvedCount ? ` (${input.resolvedCount} resolved)` : ""}`);
  parts.push(`**Reviewed commit:** ${head} · ${historyLink}`);
  parts.push("");
  parts.push(prSummary);
  parts.push("");

  if (sorted.length === 0) {
    parts.push("No actionable findings were identified in the reviewed scope.");
  } else {
    parts.push(`### Actionable findings (${sorted.length})`);
    parts.push("");
    parts.push("| Severity | Location | Finding |");
    parts.push("|----------|----------|---------|");
    for (const f of sorted) {
      const sev = `${f.severity} ${SEVERITY_LABEL[f.severity] ?? ""}`.trim();
      const loc = `\`${escapeCell(f.filePath)}:${lineRef(f)}\``;
      const title = escapeCell(f.title);
      parts.push(`| ${sev} | ${loc} | ${title} |`);
    }
  }

  parts.push("");
  parts.push("<details>");
  parts.push("<summary>🤖 Fix with Agent</summary>");
  parts.push("");
  parts.push("```text");
  parts.push(formatFixWithAgentPrompt(input, sorted));
  parts.push("```");
  parts.push("");
  parts.push("</details>");

  const body = parts.join("\n");
  if (body.length > 60000) {
    return body + "\n\n> **Note:** This comment is large; see Complete Review History for the full archived record.";
  }
  return body;
}
