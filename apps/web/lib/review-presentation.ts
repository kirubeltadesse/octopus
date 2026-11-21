import { FINDINGS_END_MARKER, FINDINGS_START_MARKER, type InlineFinding } from "@/lib/review-dedup";
import type { ReviewCoverage } from "@/lib/review-coverage";
import { applyReviewCoverage, reviewAssessmentComplete } from "@/lib/review-coverage";
import { validReviewFindings, markReviewAssessmentIncomplete, normalizeReviewResponse, reviewResponseValidationError } from "@/lib/review-assessment";
import { normalizeLastReviewedCommit, normalizeScoreDenominators, reconcileScoreTable } from "@/lib/review-helpers";
import { sanitizeMermaidInMarkdown } from "@/lib/mermaid-utils";
import { containExcludedInputClaims, recoveryFindingsBody, parseRecoveryFindingsSet, excludedInputGapReport } from "@/lib/review-evidence";
import { stripReasoningArtifacts } from "@/lib/review-github-summary";

function findingsBlocks(body: string): string[] {
  return body.match(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g) ?? [];
}

export function stripReviewReasoningArtifacts(body: string): string {
  return mapReviewPresentation(body, (presentation) => stripReasoningArtifacts(presentation));
}

export function mapReviewPresentation(body: string, transform: (presentation: string) => string): string {
  const blocks = findingsBlocks(body);
  const presentation = body.replace(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g, "");
  const transformed = transform(presentation);
  if (blocks.length === 0) return transformed;
  const footer = /\n*Last reviewed commit: [0-9a-f]{40}\s*$/i.exec(transformed)?.[0] ?? "";
  return [footer ? transformed.slice(0, -footer.length).trimEnd() : transformed.trimEnd(), ...blocks, footer.trim()].filter(Boolean).join("\n\n");
}

export function enforceReviewFindingsIntegrity(original: string, current: string, coverage: ReviewCoverage, checkSummary = false): void {
  if (coverage.assessment?.state !== "completed") return;
  const before = findingsBlocks(original);
  const after = findingsBlocks(current);
  if (before.length === 1 && after.length === 1 && before[0] === after[0]
    && (!checkSummary || validReviewFindings(current))) return;
  markReviewAssessmentIncomplete(coverage, "Validated findings were lost, changed or inconsistent during report preparation");
}

function markExcludedInputAssessment(coverage: ReviewCoverage): void {
  const reason = "Excluded-input claims require verification; no valid overall assessment";
  const previous = coverage.assessment;
  if (previous?.state === "incomplete" && previous.reason.includes(reason)) return;
  markReviewAssessmentIncomplete(coverage, previous?.state === "incomplete"
    ? `${previous.reason}; ${reason}` : reason);
}

export function prepareReviewPresentation(body: string, coverage: ReviewCoverage): string {
  const contained = containExcludedInputClaims(body, coverage);
  if (contained.paths.length > 0) markExcludedInputAssessment(coverage);
  const cleaned = mapReviewPresentation(contained.body, presentation => {
    let result = stripReasoningArtifacts(presentation);
    result = result.replace(/([^\n])```(\n|$)/g, "$1\n```$2")
      .replace(/```([^`\n\sa-z])/g, "```\n\n$1");
    result = normalizeScoreDenominators(result);
    result = result.replace(/### Diagram\s*\n[\s\S]*?(?=\n### |\n## |$)/, section => {
      const content = /```mermaid\s*\n([\s\S]*?)```/.exec(section)?.[1]?.trim() ?? "";
      return content.length > 10 ? section : "";
    });
    return normalizeLastReviewedCommit(sanitizeMermaidInMarkdown(result), coverage.headSha);
  });
  enforceReviewFindingsIntegrity(body, cleaned, coverage, true);
  return cleaned;
}

export function finalizeReviewPresentation(
  original: string, report: string, comment: string, coverage: ReviewCoverage, attemptId: string,
  findings: { hasCritical: boolean; hasHigh: boolean; hasMedium: boolean },
): { report: string; comment: string } {
  enforceReviewFindingsIntegrity(original, report, coverage);
  const finalize = (body: string) => mapReviewPresentation(body, presentation => {
    const stripped = stripReasoningArtifacts(presentation);
    const assessed = reviewAssessmentComplete(coverage) && coverage.assessment?.state === "completed" ? reconcileScoreTable(stripped, findings)
      : applyReviewCoverage(stripped.replace(/### Review coverage[\s\S]*?\nAssessment: [^\n]*\n\n/, ""), coverage, attemptId);
    return normalizeLastReviewedCommit(assessed, coverage.headSha);
  });
  return { report: finalize(report), comment: finalize(comment) };
}

function findingIdentity(finding: InlineFinding): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]));
    }
    return value;
  };
  return JSON.stringify(canonical(finding));
}

/**
 * Merge follow-up findings into a report that has at most one canonical findings block.
 * Identical records sharing a file path and title collapse into one; conflicting records
 * sharing that key are rejected rather than discarded. Returns null when the report has
 * ambiguous markers or the merged candidate fails primary validation. A null result means
 * the caller must keep the primary report untouched.
 */
export function mergeRecoveredFindings(body: string, recovered: InlineFinding[], existing: InlineFinding[], coverage: ReviewCoverage): string | null {
  if (recovered.length === 0) return null;
  const normalizedBody = normalizeReviewResponse(body);
  const blocks = findingsBlocks(normalizedBody);
  if (blocks.length > 1) return null;
  if (blocks.length === 0 && /OCTOPUS_FINDINGS_(?:START|END)/.test(normalizedBody)) return null;
  const byKey = new Map<string, InlineFinding>();
  const add = (finding: InlineFinding): boolean => {
    const key = `${finding.filePath}:${finding.title}`;
    const prior = byKey.get(key);
    if (prior) return findingIdentity(prior) === findingIdentity(finding);
    byKey.set(key, finding);
    return true;
  };
  for (const finding of existing) if (!add(finding)) return null;
  for (const finding of recovered) if (!add(finding)) return null;
  const merged = [...byKey.values()];
  if (merged.length === 0) return null;
  const canonical = `${FINDINGS_START_MARKER}\n\`\`\`json\n${JSON.stringify(merged, null, 2)}\n\`\`\`\n${FINDINGS_END_MARKER}`;
  const candidate = blocks.length === 1
    ? normalizedBody.replace(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/, canonical)
    : `${normalizedBody.trimEnd()}\n\n${canonical}`;
  return validReviewFindings(candidate) && reviewResponseValidationError(candidate, coverage.complete) === null ? candidate : null;
}

export function prepareRecoveredReviewPresentation(body: string, rawRecovery: string, findings: InlineFinding[], coverage: ReviewCoverage): string | null {
  const recoveryBody = recoveryFindingsBody(rawRecovery);
  if (parseRecoveryFindingsSet(rawRecovery) === null) {
    const rejected = containExcludedInputClaims(recoveryBody, coverage);
    if (rejected.paths.length === 0) return null;
    markExcludedInputAssessment(coverage);
    return prepareReviewPresentation(excludedInputGapReport(rejected.paths, body), coverage);
  }
  const blocks = findingsBlocks(body);
  if (blocks.length > 1 || (blocks.length === 0 && /OCTOPUS_FINDINGS_(?:START|END)/.test(body))) return null;
  const presentation = blocks.length === 1 ? body.replace(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g, "") : body;
  const combined = `${presentation}\n${FINDINGS_START_MARKER}\n${JSON.stringify(findings)}\n${FINDINGS_END_MARKER}`;
  const contained = containExcludedInputClaims(combined, coverage);
  if (contained.paths.length === 0) return null;
  markExcludedInputAssessment(coverage);
  return prepareReviewPresentation(contained.body, coverage);
}
