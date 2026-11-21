import { describe, expect, it } from "bun:test";
import { FINDINGS_END_MARKER, FINDINGS_START_MARKER, parseFindings, type InlineFinding } from "@/lib/review-dedup";
import { executeFindingsRecovery, normalizeReviewResponse, reviewResponseValidationError, validReviewFindings } from "@/lib/review-assessment";
import { mergeRecoveredFindings, prepareReviewPresentation } from "@/lib/review-presentation";
import { countFindingsFromTable } from "@/lib/review-helpers";
import { sha256, type ReviewCoverage } from "@/lib/review-coverage";

const START = FINDINGS_START_MARKER;
const END = FINDINGS_END_MARKER;
const MALFORMED_START = "<!-- OCTOPUS_FINDINGS_START-->";
const MALFORMED_END = "<!-- OCTOPUS_FINDINGS_END-->";

const high = (title: string, filePath = `src/${title}.ts`): InlineFinding => ({
  severity: "🟠",
  title,
  filePath,
  startLine: 1,
  endLine: 1,
  category: "Bug",
  description: "A description.",
  suggestion: "A suggestion.",
  confidence: 90,
});

function report(findings: InlineFinding[], options: { high?: number; start?: string; end?: string; block?: boolean } = {}): string {
  const highCount = options.high ?? findings.filter(finding => finding.severity === "🟠").length;
  const block = options.block === false ? "" : `${options.start ?? START}\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n${options.end ?? END}\n\n`;
  return `## 🐙 Octopus Review

### Summary
The change is coherent.

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 5/5 | No finding |
| Code Quality | 5/5 | Clear |
| Performance | 5/5 | Bounded |
| Error Handling | 5/5 | Explicit |
| Consistency | 5/5 | Consistent |
| **Overall** | **5/5** | Lowest category |

### Findings Summary
| Severity | Count |
| --- | --- |
| 🔴 Critical | 0 |
| 🟠 High | ${highCount} |
| 🟡 Medium | 0 |
| 🔵 Low | 0 |
| 💡 Nit | 0 |

### Findings
${block}Last reviewed commit: ${"a".repeat(40)}
`;
}

const coverage = { complete: true } as ReviewCoverage;

describe("findings marker normalization", () => {
  it("canonicalizes an END marker missing the space before -->", () => {
    const text = report([high("A")], { end: MALFORMED_END });
    expect(normalizeReviewResponse(text)).toBe(report([high("A")]));
    expect(reviewResponseValidationError(text)).toBeNull();
  });

  it("canonicalizes a START marker missing the space before -->", () => {
    const text = report([high("A")], { start: MALFORMED_START });
    expect(normalizeReviewResponse(text)).toBe(report([high("A")]));
    expect(reviewResponseValidationError(text)).toBeNull();
  });

  it("is idempotent", () => {
    const once = normalizeReviewResponse(report([high("A")], { end: MALFORMED_END }));
    expect(normalizeReviewResponse(once)).toBe(once);
  });

  it("preserves findings JSON bytes", () => {
    const findings = [high("A")];
    expect(normalizeReviewResponse(report(findings, { end: MALFORMED_END })))
      .toContain(JSON.stringify(findings, null, 2));
  });

  it("does not rewrite a marker line inside a fenced code block", () => {
    const fenced = `\`\`\`md\n${MALFORMED_END}\n\`\`\``;
    const text = report([high("A")]).replace("### Findings\n", `### Findings\n${fenced}\n`);
    expect(normalizeReviewResponse(text)).toContain(fenced);
  });

  it("does not rewrite marker-like text inside prose", () => {
    const prose = `The marker ${MALFORMED_END} is documented inline.`;
    const text = report([high("A")]).replace("### Findings\n", `### Findings\n${prose}\n`);
    expect(normalizeReviewResponse(text)).toContain(prose);
  });

  it("validates findings after marker normalization", () => {
    expect(validReviewFindings(report([high("A")], { end: MALFORMED_END }))).toBe(true);
  });
});

describe("findings marker validation", () => {
  it("rejects duplicate complete blocks", () => {
    const block = `${START}\n\`\`\`json\n[]\n\`\`\`\n${END}`;
    expect(reviewResponseValidationError(`${report([high("A")])}\n${block}`)).toBe("Findings JSON markers missing or duplicated");
  });

  it("rejects nested blocks", () => {
    const text = report([high("A")], { start: `${START}\n${START}`, end: `${END}\n${END}` });
    expect(reviewResponseValidationError(text)).toBe("Findings JSON markers missing or duplicated");
  });

  it("rejects END before START", () => {
    expect(reviewResponseValidationError(report([high("A")], { start: END, end: START }))).toBe("Findings JSON markers missing or duplicated");
  });

  it("rejects START without END", () => {
    expect(reviewResponseValidationError(report([high("A")], { end: "" }))).toBe("Findings JSON markers missing or duplicated");
  });
});

describe("mergeRecoveredFindings", () => {
  it("replaces one block with the merged findings and validates", () => {
    const existing = high("A");
    const recovered = high("B");
    const merged = mergeRecoveredFindings(report([existing], { high: 2 }), [recovered], [existing], coverage);
    expect(merged).not.toBeNull();
    expect(merged!.split(START).length).toBe(2);
    expect(merged!.split(END).length).toBe(2);
    expect(merged).toContain("src/A.ts");
    expect(merged).toContain("src/B.ts");
    expect(reviewResponseValidationError(merged!)).toBeNull();
  });

  it("returns null when two blocks already exist", () => {
    const body = `${report([high("A")])}\n${START}\n\`\`\`json\n[]\n\`\`\`\n${END}`;
    expect(mergeRecoveredFindings(body, [high("B")], [high("A")], coverage)).toBeNull();
  });

  it("returns null when a marker is malformed", () => {
    expect(mergeRecoveredFindings(report([high("A")], { end: "" }), [high("B")], [high("A")], coverage)).toBeNull();
  });

  it("appends one block when the report has none", () => {
    const merged = mergeRecoveredFindings(report([], { block: false, high: 1 }), [high("A")], [], coverage);
    expect(merged).not.toBeNull();
    expect(merged!.split(START).length).toBe(2);
    expect(merged!.split(END).length).toBe(2);
    expect(reviewResponseValidationError(merged!)).toBeNull();
  });

  it("returns null when merged counts do not match the summary", () => {
    expect(mergeRecoveredFindings(report([high("A")], { high: 1 }), [high("B")], [high("A")], coverage)).toBeNull();
  });

  it("deduplicates by file path and title", () => {
    const finding = high("A");
    const merged = mergeRecoveredFindings(report([finding], { high: 1 }), [finding], [finding], coverage);
    expect(merged).not.toBeNull();
    expect(merged!.split('"title": "A"').length - 1).toBe(1);
  });

  it("returns null when the follow-up has no findings", () => {
    expect(mergeRecoveredFindings(report([high("A")]), [], [high("A")], coverage)).toBeNull();
  });
});

function recoveryCoverage(): ReviewCoverage {
  return {
    assessment: {
      state: "incomplete", reason: "primary invalid", model: "gpt-test",
      policySha256: "policy", templateSha256: "template", requests: [], responseSha256: "primary",
      completion: null, recoveries: [],
    },
  } as unknown as ReviewCoverage;
}

const recoveryCall = (text: string) => async () => ({
  text, provider: "openai" as const, model: "gpt-test",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

describe("PR 461-shaped malformed marker response", () => {
  const completedCoverage = {
    complete: true, headSha: "a".repeat(40), files: [],
    assessment: {
      state: "completed", reason: "Provider completed the response", model: "gpt-test",
      policySha256: "policy", templateSha256: "template", requests: [], responseSha256: "raw",
      completion: null,
    },
  } as unknown as ReviewCoverage;

  it("yields one canonical block and no recovery after normalization", () => {
    const raw = report([high("A")], { end: MALFORMED_END });
    expect(reviewResponseValidationError(raw)).toBeNull();
    const normalized = normalizeReviewResponse(raw);
    const body = prepareReviewPresentation(normalized, completedCoverage);
    expect(body.split(START).length).toBe(2);
    expect(body.split(END).length).toBe(2);
    expect(parseFindings(body).length).toBe(1);
    expect(countFindingsFromTable(body)).toBe(1);
    expect(completedCoverage.assessment!.state).toBe("completed");
  });
});

describe("findings recovery marker normalization", () => {
  it("normalizes a malformed recovery envelope before parsing", async () => {
    const finding = high("Recovered");
    const raw = `${START}\n\`\`\`json\n${JSON.stringify([finding])}\n\`\`\`\n${MALFORMED_END}`;
    const cov = recoveryCoverage();
    const recovered = await executeFindingsRecovery(
      { model: "gpt-test", reviewBody: report([], { block: false, high: 1 }), parsedFindingsCount: 0, tableFindingsTotal: 1 },
      cov, recoveryCall(raw),
    );
    expect(recovered.findings).toEqual([finding]);
    expect(recovered.text).toContain(END);
    expect(recovered.text).not.toContain(MALFORMED_END);
    expect(cov.assessment!.recoveries![0].responseSha256).toBe(sha256(raw));
  });

  it("keeps the raw response hash when the recovery JSON is malformed", async () => {
    const raw = `${START}\n[null,]\n${MALFORMED_END}`;
    const cov = recoveryCoverage();
    const recovered = await executeFindingsRecovery(
      { model: "gpt-test", reviewBody: report([], { block: false, high: 1 }), parsedFindingsCount: 0, tableFindingsTotal: 1 },
      cov, recoveryCall(raw),
    );
    expect(recovered.findings).toBeNull();
    expect(cov.assessment!.state).toBe("incomplete");
    expect(cov.assessment!.reason).toContain("Findings recovery JSON set is malformed");
    expect(cov.assessment!.recoveries![0].responseSha256).toBe(sha256(raw));
  });
});
