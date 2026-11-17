import { describe, expect, it } from "bun:test";
import { normalizeReviewResponse, reviewResponseValidationError, validReviewResponse } from "@/lib/review-assessment";
import { buildReReviewContext, RE_REVIEW_OUTPUT_CONTRACT, type ReReviewDismissedFinding } from "@/lib/review-rereview-context";
import type { PRReviewComment } from "@/lib/github";
import type { PriorFinding } from "@/lib/review-dedup";

const ZERO_SUMMARY = `| Severity | Count |
| --- | --- |
| 🔴 Critical | 0 |
| 🟠 High | 0 |
| 🟡 Medium | 0 |
| 🔵 Low | 0 |
| 💡 Nit | 0 |`;

const FINDINGS_BLOCK = `<!-- OCTOPUS_FINDINGS_START -->
[]
<!-- OCTOPUS_FINDINGS_END -->`;

const report = (options: {
  summary?: string;
  findingsTable?: string;
  afterTable?: string;
  findings?: string;
} = {}) => `## 🐙 Octopus Review

### Summary
${options.summary ?? "The change is consistent with its documented contract."}

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 5/5 | No security finding |
| Code Quality | 5/5 | Clear implementation |
| Performance | 4/5 | Bounded work |
| Error Handling | 5/5 | Explicit errors |
| Consistency | 5/5 | Consistent |
| **Overall** | **4/5** | Lowest category |

### Findings Summary
${options.findingsTable ?? ZERO_SUMMARY}
${options.afterTable ? `\n${options.afterTable}\n` : ""}
### Findings
${options.findings ?? FINDINGS_BLOCK}

Last reviewed commit: ${"a".repeat(40)}
`;

const error = (text: string) => reviewResponseValidationError(text);
const conflictRisk = "> ⚠️ **Conflict Risk**: This PR modifies shared files. Merge or rebase frequently\n> against `main` and coordinate with related authors.";

describe("re-review instruction contract", () => {
  const botLogin = "octopus[bot]";
  const comment = (overrides: Partial<PRReviewComment> = {}): PRReviewComment => ({
    id: 1, path: "src/validator.ts", line: 12, body: "Missing null check\n\nThis can throw.",
    user: botLogin, inReplyToId: null, isOutdated: true, ...overrides,
  });

  it("states the unchanged output contract without provider-specific rules", () => {
    for (const phrase of [
      "Findings Summary` must contain only the Severity/Count table",
      "Do not append prose, bullets, conclusions, or explanations of resolved findings",
      "Put explanations of resolved or reconsidered findings in `### Summary`",
      "empty JSON array `[]`",
      "OCTOPUS_FINDINGS_START",
      "Keep every mandatory section and the required Score table unchanged",
    ]) expect(RE_REVIEW_OUTPUT_CONTRACT).toContain(phrase);
    expect(RE_REVIEW_OUTPUT_CONTRACT).not.toMatch(/anthropic|claude|deepseek|openai|gpt/i);
  });

  it("appends the contract after prior inline comments on a re-review", () => {
    const context = buildReReviewContext({
      botLogin,
      botComments: [comment()],
      allPriorReviewComments: [
        comment(),
        comment({ id: 2, user: "author", inReplyToId: 1, body: "Fixed in the next commit." }),
      ],
      priorSummaryTableFindings: [],
      dismissedFindings: [],
    });
    expect(context).toContain("RE-REVIEW MODE");
    expect(context).toContain("src/validator.ts:12");
    expect(context).toContain("Author response: Fixed in the next commit.");
    expect(context).toContain("✅ RESOLVED");
    expect(context.trimEnd().endsWith("Keep every mandatory section and the required Score table unchanged.")).toBe(true);
    expect(context.indexOf(RE_REVIEW_OUTPUT_CONTRACT)).toBeGreaterThan(context.indexOf("PRIOR INLINE COMMENTS"));
  });

  it("keeps the contract on a re-review with zero prior findings", () => {
    const context = buildReReviewContext({ botLogin, botComments: [], allPriorReviewComments: [], priorSummaryTableFindings: [], dismissedFindings: [] });
    expect(context).toContain(RE_REVIEW_OUTPUT_CONTRACT);
    expect(context).toContain("EMPTY IS GOOD");
    expect(context).not.toContain("BLOCKED — every item below");
  });

  it("includes dismissed findings and prior table findings before the contract", () => {
    const prior: PriorFinding[] = [{ filePath: "src/other.ts", line: 4, title: "Old issue", keywords: new Set() }];
    const dismissed: ReReviewDismissedFinding[] = [{ title: "Rejected note", description: "Not a bug", severity: "🟡", filePath: "src/a.ts", lineNumber: 9 }];
    const context = buildReReviewContext({ botLogin, botComments: [], allPriorReviewComments: [], priorSummaryTableFindings: prior, dismissedFindings: dismissed });
    expect(context).toContain("src/other.ts:4");
    expect(context).toContain("Rejected note");
    expect(context.indexOf(RE_REVIEW_OUTPUT_CONTRACT)).toBeGreaterThan(context.indexOf("DISMISSED FINDINGS"));
  });
});

describe("review output validation contracts", () => {
  it("accepts a valid first-time review", () => {
    expect(error(report())).toBeNull();
    expect(validReviewResponse(report())).toBe(true);
  });

  it("accepts a valid re-review whose resolved-findings notes are in Summary", () => {
    const text = report({ summary: "Both previously reported issues are resolved. No new critical issues were introduced." });
    expect(error(text)).toBeNull();
  });

  it("accepts a re-review with zero findings", () => {
    const text = report({ summary: "All previous findings are resolved; nothing new to report." });
    expect(error(text)).toBeNull();
    expect(text).toContain(FINDINGS_BLOCK);
  });

  it("rejects extra prose following the Findings Summary table", () => {
    const text = report({ afterTable: "Previously reported issues are resolved. No new findings." });
    expect(error(text)).toBe("Unexpected content after Findings Summary table");
    expect(validReviewResponse(text)).toBe(false);
    // No presentation normalization may silently drop that prose.
    expect(normalizeReviewResponse(text)).toContain("Previously reported issues are resolved");
  });

  it("accepts a correctly formatted Conflict Risk advisory after the table", () => {
    expect(error(report({ afterTable: conflictRisk }))).toBeNull();
  });

  it("rejects a Conflict Risk advisory placed as arbitrary prose", () => {
    expect(error(report({ afterTable: "> Shared files changed; coordinate with other authors." }))).toBe("Unexpected content after Findings Summary table");
  });

  it("rejects Findings Summary counts that disagree with the JSON findings", () => {
    const one = report({
      findingsTable: ZERO_SUMMARY.replace("| 🔴 Critical | 0 |", "| 🔴 Critical | 1 |"),
      findings: `<!-- OCTOPUS_FINDINGS_START -->\n[]\n<!-- OCTOPUS_FINDINGS_END -->`,
    });
    expect(error(one)).toBe("Findings Summary counts do not match findings JSON");
  });

  it("rejects malformed findings JSON", () => {
    expect(error(report({ findings: `<!-- OCTOPUS_FINDINGS_START -->\n[null]\n<!-- OCTOPUS_FINDINGS_END -->` }))).toBe("Findings JSON entries are malformed");
    expect(error(report({ findings: `<!-- OCTOPUS_FINDINGS_START -->\n{ not json\n<!-- OCTOPUS_FINDINGS_END -->` }))).toBe("Findings JSON is malformed");
  });

  it("rejects incomplete or truncated responses", () => {
    const complete = report();
    expect(error(complete)).toBeNull();
    const truncated = complete.slice(0, complete.indexOf("<!-- OCTOPUS_FINDINGS_END -->"));
    expect(error(truncated)).not.toBeNull();
    expect(validReviewResponse(truncated)).toBe(false);
    expect(error("Everything looks good. Overall 5/5")).toBe("Review heading missing");
  });

  it("keeps the same provider-agnostic contract for Claude/Anthropic-style output", () => {
    const anthropicStyle = report({ summary: "Reviewed by Claude. The change matches the documented contract." });
    expect(error(anthropicStyle)).toBeNull();
    expect(normalizeReviewResponse(anthropicStyle)).toContain("Reviewed by Claude");
  });
});
