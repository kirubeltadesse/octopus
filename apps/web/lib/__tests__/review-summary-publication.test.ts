import { describe, expect, it } from "bun:test";
import type { ReviewCoverage } from "@/lib/review-coverage";
import { reviewCheckResult, reviewAssessmentComplete } from "@/lib/review-coverage";
import type { InlineFinding } from "@/lib/review-dedup";
import {
  MAX_GITHUB_COMMENT_CHARS,
  formatFixWithAgentPrompt,
  formatGitHubReviewSummary,
  formatInvalidAssessmentSummary,
  formatLargeReviewSummary,
  sanitizeFindings,
} from "@/lib/review-github-summary";
import { shouldFailReviewCheck } from "@/lib/review-helpers";

const HEAD = "a".repeat(40);

const coverage = (overrides: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  version: 1,
  provider: "github",
  headSha: HEAD,
  baseSha: "b".repeat(40),
  inventoryComplete: true,
  expectedFiles: 2,
  complete: true,
  files: [
    { path: "src/a.ts", change: "modified", state: "supplied", patchSha256: null, suppliedSha256: null, suppliedChars: 10, hunks: [] },
    { path: "src/b.ts", change: "modified", state: "supplied", patchSha256: null, suppliedSha256: null, suppliedChars: 10, hunks: [] },
  ],
  limitations: [],
  assessment: {
    state: "completed",
    reason: "Provider completed the assessment response",
    model: "test-model",
    policySha256: "p",
    templateSha256: "t",
    requests: [],
    responseSha256: "r",
    completion: null,
  },
  ...overrides,
});

const finding = (o: Partial<InlineFinding> = {}): InlineFinding => ({
  severity: "🟡",
  title: "Example issue",
  filePath: "src/a.ts",
  startLine: 10,
  endLine: 12,
  category: "Bug",
  description: "Something is wrong.",
  suggestion: "const x = 1;",
  confidence: 90,
  minimumFixScope: "Change only the affected branch.",
  suggestedRegressionTest: "it('handles case', () => { expect(fn()).toBe(1); })",
  ...o,
});

const HISTORY = "https://octopus-review.ai/review-attempts/11111111-2222-4333-8444-555555555555";
const PRESENTATION = "## 🐙 Octopus Review\n\n### Summary\nImproves input validation. Adds safer parsing.\n\n### Score\n| Category | Score | Notes |\n| --- | --- | --- |";

describe("normal review publication", () => {
  it("publishes a compact summary with a consolidated Fix with Agent prompt", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      prTitle: "Harden parser",
      presentationBody: PRESENTATION,
      findings: [finding({ severity: "🔴", title: "Unchecked input" })],
      reviewHistoryUrl: HISTORY,
    });

    expect(out).toContain("## 🐙 Octopus Review");
    expect(out).toContain("**Verdict:** Action required");
    expect(out).toContain("🤖 Fix with Agent");
    expect(out).toContain("### Actionable findings (1)");
    expect(out).toContain(HISTORY);
    expect(out).toContain("`src/a.ts:L10-L12`");
    // The public comment never carries the full model report.
    expect(out).not.toContain("### Score");
  });

  it("includes every selected finding in the agent prompt", () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      finding({ title: `Finding ${i + 1}`, filePath: `src/f${i}.ts`, startLine: i + 1, endLine: i + 1 }),
    );
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings,
      reviewHistoryUrl: HISTORY,
    });

    expect(out).toContain("### Actionable findings (12)");
    for (const f of findings) {
      expect(out).toContain(`Location: ${f.filePath}:L${f.startLine}`);
      expect(out).toContain(f.title);
    }
    const prompt = formatFixWithAgentPrompt({ headSha: HEAD }, findings);
    for (const f of findings) {
      expect(prompt).toContain(`Finding ${findings.indexOf(f) + 1}`);
      expect(prompt).toContain(`${f.filePath}:L${f.startLine}`);
    }
  });

  it("is deterministic, so a re-review updates the same comment body", () => {
    const input = {
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [finding()],
      reviewHistoryUrl: HISTORY,
    };
    expect(formatGitHubReviewSummary(input)).toBe(formatGitHubReviewSummary(input));
  });

  it("represents re-review resolution metadata without changing the format", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-2",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [finding()],
      reviewHistoryUrl: HISTORY,
      reReview: true,
      resolvedCount: 3,
    });
    expect(out).toContain("(3 resolved)");
    expect(out).toContain("🤖 Fix with Agent");
  });
});

describe("interrupted review publication", () => {
  it("formats an archived completed attempt from the archive exactly like the live path", () => {
    const archivedBody = `${PRESENTATION}\n\n<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify([finding()])}\n<!-- OCTOPUS_FINDINGS_END -->`;
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "archived-attempt",
      headSha: HEAD,
      presentationBody: archivedBody,
      findings: [finding()],
      reviewHistoryUrl: HISTORY,
    });
    expect(out).toContain("🤖 Fix with Agent");
    expect(out).toContain(HISTORY);
    expect(out).toContain("### Actionable findings (1)");
  });

  it("formats an interrupted/invalid attempt without exposing findings", () => {
    const out = formatInvalidAssessmentSummary({
      coverage: coverage({
        assessment: {
          state: "incomplete",
          reason: "Review processing cancelled or expired before completion",
          model: "test-model",
          policySha256: "p",
          templateSha256: "t",
          requests: [],
          responseSha256: null,
          completion: null,
        },
      }),
      attemptId: "archived-attempt",
      headSha: HEAD,
      reviewHistoryUrl: HISTORY,
    });
    expect(out).toContain("**Verdict:** Assessment unavailable");
    expect(out).toContain("No unvalidated findings are shown");
    expect(out).toContain(HISTORY);
    expect(out).not.toContain("🤖 Fix with Agent");
  });
});

describe("large reviews", () => {
  it("uses the compact layout with a consolidated agent prompt", () => {
    const out = formatLargeReviewSummary({
      findings: [finding({ severity: "🔴", title: "Race condition" })],
      headSha: HEAD,
      prTitle: "Big refactor",
      reviewHistoryUrl: HISTORY,
    });
    expect(out).toContain("## 🐙 Octopus Review");
    expect(out).toContain("Large-PR review");
    expect(out).toContain("Action required");
    expect(out).toContain("### Actionable findings (1)");
    expect(out).toContain("🤖 Fix with Agent");
    expect(out).toContain(HISTORY);
  });
});

describe("invalid assessment safety", () => {
  it("never exposes raw model output or unvalidated findings", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage({
        assessment: {
          state: "incomplete",
          reason: "<thinking>internal chain of thought</thinking> Findings JSON markers missing",
          model: "test-model",
          policySha256: "p",
          templateSha256: "t",
          requests: [],
          responseSha256: null,
          completion: null,
        },
      }),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: "### Summary\n<thinking>secret plan</thinking> leaked",
      findings: [finding({ title: "Should not appear", description: "<thinking>secret</thinking> raw" })],
      reviewHistoryUrl: HISTORY,
    });

    expect(out).toContain("**Verdict:** Assessment unavailable");
    expect(out).toContain("No unvalidated findings are shown");
    expect(out).not.toContain("Should not appear");
    expect(out).not.toContain("leaked");
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("secret");
  });
});

describe("GitHub size safety", () => {
  it("caps oversized findings below the GitHub limit and keeps the history link", () => {
    const huge = "x".repeat(8_000);
    const findings = Array.from({ length: 30 }, (_, i) =>
      finding({ title: `Huge ${i}`, description: huge, suggestion: huge, suggestedRegressionTest: huge }),
    );
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings,
      reviewHistoryUrl: HISTORY,
    });

    expect(out.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_CHARS);
    expect(out).toContain("## 🐙 Octopus Review");
    expect(out).toContain("**Verdict:**");
    expect(out).toContain(HISTORY);
    // A size-driven fallback must say so rather than silently dropping findings.
    if (!out.includes("### Actionable findings (30)")) {
      expect(out).toMatch(/additional finding|truncated for GitHub size limits/);
    }
  });

  it("preserves a concise summary when findings are oversized", () => {
    const huge = "y".repeat(20_000);
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [finding({ description: huge, suggestion: huge })],
      reviewHistoryUrl: HISTORY,
    });
    expect(out.length).toBeLessThanOrEqual(MAX_GITHUB_COMMENT_CHARS);
    expect(out).toContain("Improves input validation. Adds safer parsing.");
  });
});

describe("reasoning + malformed finding defense", () => {
  it("strips reasoning artifacts from every model-derived field", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [
        finding({
          title: "<think>hidden</think>Visible title",
          category: "<thinking>x</thinking>Bug",
          description: "<thinking>plan</thinking>Real description",
          suggestion: "<think>draft</think>const x = 1;",
          minimumFixScope: "<think>scope</think>Small scope",
          suggestedRegressionTest: "<thinking>test</thinking>it('x', () => {});",
        }),
      ],
      reviewHistoryUrl: HISTORY,
    });
    expect(out).toContain("Visible title");
    expect(out).toContain("Real description");
    expect(out).toContain("Small scope");
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("plan");
    expect(out).not.toContain("draft");
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("<think>");
  });

  it("drops structurally malformed findings instead of publishing them", () => {
    const malformed = { severity: "unknown", title: "", filePath: "", startLine: 0, endLine: 0, category: "", description: "", suggestion: "", confidence: 0 } as InlineFinding;
    expect(sanitizeFindings([malformed])).toEqual([]);

    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [malformed],
      reviewHistoryUrl: HISTORY,
    });
    expect(out).toContain("No actionable findings were identified");
  });

  it("preserves code fences inside the agent prompt", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(),
      attemptId: "attempt-1",
      headSha: HEAD,
      presentationBody: PRESENTATION,
      findings: [finding({ suggestion: "```ts\nconst x = 1;\n```" })],
      reviewHistoryUrl: HISTORY,
    });
    // Escaped so the outer ```text fence cannot be broken by the inner fence.
    expect(out).toContain("``\u200b`ts");
    expect((out.match(/<details>/g) ?? []).length).toBe(1);
    expect((out.match(/<\/details>/g) ?? []).length).toBe(1);
  });
});

describe("merge gating is unaffected by presentation", () => {
  const gating = (findings: InlineFinding[], threshold: string) => {
    const has = {
      hasCritical: findings.some((f) => f.severity === "🔴"),
      hasHigh: findings.some((f) => f.severity === "🟠"),
      hasMedium: findings.some((f) => f.severity === "🟡"),
    };
    const fail = shouldFailReviewCheck(has, threshold);
    return reviewCheckResult(coverage(), fail, findings.length);
  };

  it("sanitization does not change check conclusions", () => {
    const cases: InlineFinding[][] = [
      [],
      [finding({ severity: "🟠" })],
      [finding({ severity: "🔴" }), finding({ severity: "💡" })],
      [finding({ severity: "💡" })],
    ];
    for (const findings of cases) {
      for (const threshold of ["critical", "high", "medium", "none"]) {
        const before = gating(findings, threshold);
        const after = gating(sanitizeFindings(findings), threshold);
        expect(after.conclusion).toBe(before.conclusion);
      }
    }
  });

  it("completed assessment remains the gate for authoritative output", () => {
    expect(reviewAssessmentComplete(coverage())).toBe(true);
    expect(reviewAssessmentComplete(coverage({ assessment: { state: "incomplete", reason: "x", model: "m", policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null } }))).toBe(false);
  });
});
