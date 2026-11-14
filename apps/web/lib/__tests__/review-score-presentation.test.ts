import { describe, expect, it } from "bun:test";
import type { ReviewCoverage } from "@/lib/review-coverage";
import type { InlineFinding } from "@/lib/review-dedup";
import {
  extractOverallScore,
  formatCheckRunTitle,
  formatCheckTitle,
  formatGitHubReviewSummary,
  formatLargeReviewSummary,
  reviewVerdict,
} from "@/lib/review-github-summary";

const HEAD = "a".repeat(40);
const HISTORY = "https://octopus-review.ai/review-attempts/11111111-2222-4333-8444-555555555555";

const coverage = (overrides: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  version: 1,
  provider: "github",
  headSha: HEAD,
  baseSha: "b".repeat(40),
  inventoryComplete: true,
  expectedFiles: 1,
  complete: true,
  files: [{ path: "src/a.ts", change: "modified", state: "supplied", patchSha256: null, suppliedSha256: null, suppliedChars: 10, hunks: [] }],
  limitations: [],
  assessment: {
    state: "completed", reason: "Provider completed a valid review response", model: "m",
    policySha256: "p", templateSha256: "t", requests: [], responseSha256: "r", completion: null,
  },
  ...overrides,
});

const finding = (overrides: Partial<InlineFinding> = {}): InlineFinding => ({
  severity: "💡", title: "Nit", filePath: "src/a.ts", startLine: 1, endLine: 1,
  category: "Style", description: "Minor.", suggestion: "", confidence: 90, ...overrides,
});

const report = (overall: string, summary = "Improves parsing.") =>
  `## 🐙 Octopus Review\n\n### Summary\n${summary}\n\n### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| **Overall** | **${overall}** | Lowest category |`;

const heading = (out: string) => out.split("\n")[0];

describe("compact review score", () => {
  it.each([1, 2, 3, 4, 5])("displays the reconciled %i/5 score in the heading", (score) => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(), attemptId: "a", headSha: HEAD,
      presentationBody: report(`${score}/5`), findings: [], reviewHistoryUrl: HISTORY,
      checkConclusion: "success",
    });
    expect(heading(out)).toBe(`## 🐙 Octopus Review — ${score}/5 · Ready to merge`);
  });

  it("extracts the reconciled Overall row and ignores category rows", () => {
    const body = `### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| Security | 2/5 | weak |\n| **Overall** | **4/5** | lowest |`;
    expect(extractOverallScore(body)).toBe(4);
  });

  it("displays N/A when the score is missing, malformed or not assessed", () => {
    for (const body of [
      "## 🐙 Octopus Review\n\n### Summary\nNo score here.",
      report("Not assessed"),
      report("4/5").replace("| **Overall** | **4/5** |", "| **Overall** | **4/5** |\n| **Overall** | **5/5** |"),
      report("6/5"),
    ]) {
      const out = formatGitHubReviewSummary({
        coverage: coverage(), attemptId: "a", headSha: HEAD,
        presentationBody: body, findings: [], reviewHistoryUrl: HISTORY, checkConclusion: "success",
      });
      expect(heading(out)).toBe("## 🐙 Octopus Review — N/A · Ready to merge");
    }
  });

  it("uses the check conclusion for the verdict, not the score", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(), attemptId: "a", headSha: HEAD,
      presentationBody: report("5/5"), findings: [finding({ severity: "🔴" })], reviewHistoryUrl: HISTORY,
      checkConclusion: "failure",
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — 5/5 · Changes required");
  });

  it("shows Ready to merge for nonblocking findings", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(), attemptId: "a", headSha: HEAD,
      presentationBody: report("4/5"), findings: [finding({ severity: "💡" })], reviewHistoryUrl: HISTORY,
      checkConclusion: "success",
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — 4/5 · Ready to merge");
    expect(out).toContain("### Actionable findings (1)");
    expect(out).toContain("🤖 Fix with Agent");
  });

  it("shows Changes required for blocking findings", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(), attemptId: "a", headSha: HEAD,
      presentationBody: report("2/5"), findings: [finding({ severity: "🟠" })], reviewHistoryUrl: HISTORY,
      checkConclusion: "failure",
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — 2/5 · Changes required");
  });

  it("shows N/A and Not assessed for an invalid assessment", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage({
        assessment: {
          state: "incomplete", reason: "Findings JSON markers missing or duplicated", model: "m",
          policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null,
        },
      }),
      attemptId: "a", headSha: HEAD, presentationBody: report("4/5"),
      findings: [finding({ severity: "🔴" })], reviewHistoryUrl: HISTORY, checkConclusion: "failure",
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — N/A · Not assessed");
    expect(out).toContain("**Verdict:** Assessment unavailable");
    expect(out).not.toContain("Actionable findings");
  });

  it("keeps the score and verdict consistent for re-reviews", () => {
    const out = formatGitHubReviewSummary({
      coverage: coverage(), attemptId: "a", headSha: HEAD,
      presentationBody: report("4/5"), findings: [], reviewHistoryUrl: HISTORY,
      reReview: true, resolvedCount: 2, checkConclusion: "success",
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — 4/5 · Ready to merge");
    expect(out).toContain("(2 resolved)");
    expect(out).toContain("🤖 Fix with Agent");
  });

  it("shows N/A for large-PR reviews without a validated score", () => {
    const out = formatLargeReviewSummary({
      findings: [finding({ severity: "🟠" })], headSha: HEAD, prTitle: "Large", reviewHistoryUrl: HISTORY,
    });
    expect(heading(out)).toBe("## 🐙 Octopus Review — N/A · Not assessed");
    expect(out).toContain("### Actionable findings (1)");
    expect(out).toContain("🤖 Fix with Agent");
  });
});

describe("check run title", () => {
  it("formats the score and verdict", () => {
    expect(formatCheckTitle(4, "Ready to merge")).toBe("4/5 · Ready to merge");
    expect(formatCheckTitle(2, "Changes required")).toBe("2/5 · Changes required");
    expect(formatCheckTitle(null, "Not assessed")).toBe("N/A · Not assessed");
  });

  it("derives the verdict from the assessment and conclusion", () => {
    expect(formatCheckRunTitle({ coverage: coverage(), conclusion: "success", score: 5 })).toBe("5/5 · Ready to merge");
    expect(formatCheckRunTitle({ coverage: coverage(), conclusion: "failure", score: 1 })).toBe("1/5 · Changes required");
    expect(formatCheckRunTitle({
      coverage: coverage({
        assessment: { state: "incomplete", reason: "x", model: "m", policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null },
      }),
      conclusion: "failure", score: 4,
    })).toBe("N/A · Not assessed");
    expect(formatCheckRunTitle({
      coverage: coverage({ assessment: { state: "not-required", reason: "excluded", model: "m", policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null } }),
      conclusion: "success",
    })).toBe("N/A · No review required");
  });

  it("never derives readiness from the numeric score", () => {
    expect(reviewVerdict(coverage(), "failure")).toBe("Changes required");
    expect(reviewVerdict(coverage(), "success")).toBe("Ready to merge");
    expect(reviewVerdict(coverage({ complete: false }), "success")).toBe("Not assessed");
  });
});
