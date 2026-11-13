import { describe, expect, it } from "bun:test";
import type { ReviewCoverage } from "@/lib/review-coverage";
import type { InlineFinding } from "@/lib/review-dedup";
import { formatGitHubReviewSummary, formatInvalidAssessmentSummary, stripReasoningArtifacts } from "@/lib/review-github-summary";

const baseCoverage = (overrides: Partial<ReviewCoverage> = {}): ReviewCoverage => ({
  version: 1,
  provider: "github",
  headSha: "a".repeat(40),
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

describe("stripReasoningArtifacts", () => {
  it("removes closed and unclosed thinking/think blocks", () => {
    expect(stripReasoningArtifacts("hello <thinking>secret</thinking> world")).toBe("hello world");
    expect(stripReasoningArtifacts("hi <think>plan")).toBe("hi");
    expect(stripReasoningArtifacts("<THINKING>abc</THINKING>ok")).toBe("ok");
    expect(stripReasoningArtifacts("pre<think>never closed")).toBe("pre");
  });
});

describe("formatGitHubReviewSummary", () => {
  it("formats valid review with zero findings", () => {
    const out = formatGitHubReviewSummary({
      coverage: baseCoverage(),
      attemptId: "att1",
      headSha: "a".repeat(40),
      prTitle: "T",
      presentationBody: "## 🐙 Octopus Review\n\n### Summary\nImproves input validation. Adds safer parsing.\n\n### Score\n...",
      findings: [],
      reviewHistoryUrl: "https://app/review-attempts/att1",
    });
    expect(out).toContain("**Verdict:** No actionable findings");
    expect(out).toContain("Improves input validation. Adds safer parsing.");
    expect(out).toContain("No actionable findings were identified");
    expect(out).toContain("🤖 Fix with Agent");
    expect(out).toContain("Complete Review History");
    expect(out).not.toContain("<thinking>");
  });

  it("formats one and multiple findings sorted by severity with locations", () => {
    const findings = [
      finding({ severity: "🔵", title: "Nit", filePath: "z.ts", startLine: 1, endLine: 1 }),
      finding({ severity: "🔴", title: "Critical", filePath: "a.ts", startLine: 5, endLine: 5 }),
      finding({ severity: "🟠", title: "High", filePath: "b.ts", startLine: 2, endLine: 3 }),
    ];
    const out = formatGitHubReviewSummary({
      coverage: baseCoverage(),
      attemptId: "att1",
      headSha: "a".repeat(40),
      presentationBody: "### Summary\nFixes auth flow.",
      findings,
      reviewHistoryUrl: "https://h/1",
    });
    const crit = out.indexOf("Critical");
    const high = out.indexOf("High");
    const nit = out.indexOf("Nit");
    expect(crit).toBeGreaterThan(-1);
    expect(high).toBeGreaterThan(crit);
    expect(nit).toBeGreaterThan(high);
    expect(out).toContain("`a.ts:L5`");
    expect(out).toContain("`b.ts:L2-L3`");
    expect(out).toContain("`z.ts:L1`");
    expect(out).toContain("Actionable findings (3)");
  });

  it("consolidated agent prompt includes every finding, scope, regression tests, and HEAD check", () => {
    const findings = [
      finding({ severity: "🔴", title: "A", minimumFixScope: "scope A", suggestedRegressionTest: "test A" }),
      finding({ severity: "🟡", title: "B", minimumFixScope: "scope B", suggestedRegressionTest: "test B", filePath: "b.ts" }),
    ];
    const out = formatGitHubReviewSummary({ coverage: baseCoverage(), attemptId: "a", headSha: "c".repeat(40), findings, presentationBody: "### Summary\nS.", reviewHistoryUrl: "h" });
    expect(out).toContain("verify you are on the current PR HEAD");
    expect(out).toContain("c".repeat(40));
    expect(out).toContain("Finding 1");
    expect(out).toContain("Finding 2");
    expect(out).toContain("scope A");
    expect(out).toContain("scope B");
    expect(out).toContain("test A");
    expect(out).toContain("test B");
    expect(out).toContain("actionable finding");
  });

  it("renders different severities labels", () => {
    const out = formatGitHubReviewSummary({
      coverage: baseCoverage(),
      attemptId: "a",
      headSha: "a".repeat(40),
      findings: [finding({ severity: "🔴" }), finding({ severity: "🟠" }), finding({ severity: "🟡" }), finding({ severity: "🔵" }), finding({ severity: "💡" })],
      presentationBody: "### Summary\nS.",
      reviewHistoryUrl: "h",
    });
    expect(out).toContain("🔴 Critical");
    expect(out).toContain("🟠 High");
    expect(out).toContain("🟡 Medium");
    expect(out).toContain("🔵 Low");
    expect(out).toContain("💡 Nit");
  });

  it("escapes markdown table pipes and fences in prompt", () => {
    const out = formatGitHubReviewSummary({
      coverage: baseCoverage(),
      attemptId: "a",
      headSha: "a".repeat(40),
      findings: [finding({ title: "A | B", description: "has ``` fence", suggestion: "```\ncode\n```" })],
      presentationBody: "### Summary\nS.",
      reviewHistoryUrl: "h",
    });
    expect(out).toContain("A \\| B");
    expect(out).not.toContain("has ``` fence\n```");
  });

  it("invalid/incomplete assessment produces concise failure explanation with history link and no findings", () => {
    const out = formatGitHubReviewSummary({
      coverage: baseCoverage({ assessment: { state: "incomplete", reason: "Findings JSON markers missing or duplicated", model: "m", policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null } }),
      attemptId: "a",
      headSha: "a".repeat(40),
      findings: [finding()],
      presentationBody: "### Summary\nS.",
      reviewHistoryUrl: "https://h/history",
    });
    expect(out).toContain("Assessment unavailable");
    expect(out).toContain("did not produce a validated, authoritative review");
    expect(out).toContain("No unvalidated findings are shown");
    expect(out).toContain("https://h/history");
    expect(out).not.toContain("Actionable findings");
    expect(out).not.toContain("Example issue");
  });

  it("formatInvalidAssessmentSummary strips reasoning and includes history", () => {
    const out = formatInvalidAssessmentSummary({
      coverage: baseCoverage({ assessment: { state: "incomplete", reason: "<thinking>oops</thinking> bad", model: "m", policySha256: "p", templateSha256: "t", requests: [], responseSha256: null, completion: null } }),
      attemptId: "a",
      headSha: "a".repeat(40),
      reviewHistoryUrl: "https://h",
      reason: "<think>x</think> failed",
    });
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("oops");
    expect(out).toContain("Assessment unavailable");
    expect(out).toContain("https://h");
  });
});
