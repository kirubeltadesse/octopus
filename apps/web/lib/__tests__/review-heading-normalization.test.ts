import { describe, expect, it } from "bun:test";
import { normalizeReviewResponse, reviewResponseValidationError } from "@/lib/review-assessment";

const FINDINGS_BLOCK = `<!-- OCTOPUS_FINDINGS_START -->
[]
<!-- OCTOPUS_FINDINGS_END -->`;

const valid = `## 🐙 Octopus Review

### Summary
The changed validator is consistent with its documented contract.

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
| Severity | Count |
| --- | --- |
| 🔴 Critical | 0 |
| 🟠 High | 0 |
| 🟡 Medium | 0 |
| 🔵 Low | 0 |
| 💡 Nit | 0 |

### Findings
${FINDINGS_BLOCK}

Last reviewed commit: ${"a".repeat(40)}
`;

const finding = {
  severity: "🔴",
  title: "Missing validation",
  filePath: "src/validator.ts",
  startLine: 1,
  endLine: 1,
  category: "Bug",
  description: "The value needs validation.",
  suggestion: "if (!value) throw new Error('missing');",
  confidence: 95,
};

const withFinding = valid
  .replace(
    "| Severity | Count |\n| --- | --- |\n| 🔴 Critical | 0 |",
    "| Severity | Count |\n| --- | --- |\n| 🔴 Critical | 1 |",
  )
  .replace("[]", JSON.stringify([finding]));

const error = (text: string) => reviewResponseValidationError(text);

/** A legacy body that older reviews and re-reviews may still store. */
const legacy = (body: string) =>
  body
    .replace("## 🐙 Octopus Review", "# Octopus Review")
    .replace("### Summary", "## Summary")
    .replace("### Score", "### Scores")
    .replace("### Findings Summary", "## Findings Summary");

describe("standard review format", () => {
  it("accepts the canonical format unchanged", () => {
    expect(error(valid)).toBeNull();
    expect(normalizeReviewResponse(valid)).toBe(valid);
  });

  it("accepts the canonical format with valid findings", () => {
    expect(error(withFinding)).toBeNull();
    expect(normalizeReviewResponse(withFinding)).toBe(withFinding);
  });
});

describe("legacy formatting variations", () => {
  const cases: [string, string][] = [
    ["h1 report heading", valid.replace("## 🐙 Octopus Review", "# Octopus Review")],
    ["h3 report heading", valid.replace("## 🐙 Octopus Review", "### 🐙 Octopus Review")],
    ["code review heading", valid.replace("## 🐙 Octopus Review", "## Octopus Code Review")],
    ["lowercase heading", valid.replace("## 🐙 Octopus Review", "## 🐙 octopus review")],
    ["ATX closing marks", valid.replace("## 🐙 Octopus Review", "## 🐙 Octopus Review ##")],
    ["heading suffix", valid.replace("## 🐙 Octopus Review", "## 🐙 Octopus Review — PR #42")],
    ["h2 summary", valid.replace("### Summary", "## Summary")],
    ["summary of changes", valid.replace("### Summary", "### Summary of Changes")],
    ["score plural", valid.replace("### Score", "### Scores")],
    ["score h2", valid.replace("### Score", "## Score")],
    ["findings summary h2", valid.replace("### Findings Summary", "## Findings Summary")],
    ["byte order mark", `\uFEFF${valid}`],
    ["legacy combination", legacy(valid)],
    ["legacy combination with findings", legacy(withFinding)],
  ];

  it.each(cases)("accepts and canonicalizes %s", (_name, text) => {
    expect(error(text)).toBeNull();
    const normalized = normalizeReviewResponse(text);
    expect(normalized).toContain("## 🐙 Octopus Review\n");
    expect(normalized).toContain("\n### Summary\n");
    expect(normalized).toContain("\n### Score\n");
    expect(normalized).toContain("\n### Findings Summary\n");
    // Normalization is idempotent.
    expect(normalizeReviewResponse(normalized)).toBe(normalized);
  });

  it("preserves CRLF line endings while canonicalizing headings", () => {
    const crlf = legacy(valid).replaceAll("\n", "\r\n");
    expect(error(crlf)).toBeNull();
    expect(normalizeReviewResponse(crlf)).toBe(valid.replaceAll("\n", "\r\n"));
  });
});

describe("duplicate headings", () => {
  it("rejects a duplicate report heading", () => {
    expect(error(valid.replace("## 🐙 Octopus Review", "## 🐙 Octopus Review\n\n## 🐙 Octopus Review"))).toBe("Review heading duplicated");
  });

  it("rejects a duplicate summary heading", () => {
    expect(error(valid.replace("### Summary", "### Summary\n\n### Summary"))).toBe("Summary heading duplicated");
  });

  it("rejects a duplicate score heading", () => {
    expect(error(valid.replace("### Score", "### Score\n\n### Score"))).toBe("Score heading duplicated");
  });

  it("rejects a duplicate findings summary heading", () => {
    expect(error(valid.replace("### Findings Summary", "### Findings Summary\n\n### Findings Summary"))).toBe("Findings Summary heading duplicated");
  });
});

describe("missing sections", () => {
  it("reports a missing report heading", () => {
    expect(error(valid.replace("## 🐙 Octopus Review\n\n", ""))).toBe("Review heading missing");
  });

  it("reports a missing summary heading", () => {
    expect(error(valid.replace(/### Summary\n[\s\S]*?(?=### Score)/, ""))).toBe("Summary heading missing");
  });

  it("reports a missing score heading", () => {
    expect(error(valid.replace(/### Score\n[\s\S]*?(?=### Findings Summary)/, ""))).toBe("Score heading missing");
  });

  it("reports a missing findings summary heading", () => {
    expect(error(valid.replace(/### Findings Summary\n[\s\S]*?(?=### Findings)/, ""))).toBe("Findings Summary heading missing");
  });

  it("reports malformed heading structure when sections are reordered", () => {
    const reordered = valid.replace(/### Summary\n([\s\S]*?)### Score/, "### Score\n$1### Summary");
    expect(error(reordered)).toBe("Review heading structure malformed");
  });

  it("reports an empty summary section", () => {
    expect(error(valid.replace("The changed validator is consistent with its documented contract.\n\n", ""))).toBe("Summary section is empty");
  });
});

describe("re-reviews of older PRs", () => {
  it("accepts a legacy formatted review with findings", () => {
    const text = legacy(withFinding);
    expect(error(text)).toBeNull();
    const normalized = normalizeReviewResponse(text);
    expect(normalized).toContain("<!-- OCTOPUS_FINDINGS_START -->");
    expect(normalized).toContain("<!-- OCTOPUS_FINDINGS_END -->");
    expect(normalized).toContain(JSON.stringify([finding]));
  });

  it("keeps the findings JSON byte-for-byte after normalization", () => {
    const text = legacy(withFinding);
    const block = /<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/.exec(text)?.[0];
    expect(block).toBeDefined();
    expect(normalizeReviewResponse(text)).toContain(block!);
  });
});

describe("invalid findings stay rejected", () => {
  it("rejects null entries", () => {
    expect(error(withFinding.replace(JSON.stringify([finding]), "[null]"))).toBe("Findings JSON entries are malformed");
  });

  it("rejects malformed JSON", () => {
    expect(error(withFinding.replace(JSON.stringify([finding]), "{ not json"))).toBe("Findings JSON is malformed");
  });

  it("rejects a summary count that does not match the findings array", () => {
    expect(error(withFinding.replace(JSON.stringify([finding]), "[]"))).toBe("Findings Summary counts do not match findings JSON");
  });

  it("rejects an invalid severity or location", () => {
    expect(error(withFinding.replace(JSON.stringify([finding]), JSON.stringify([{ ...finding, severity: "🔺", startLine: 0 }])))).toBe("Findings JSON severity or location is invalid");
  });
});

describe("fenced code is not part of the report structure", () => {
  it("ignores and preserves heading-like lines inside a code fence", () => {
    const fenced = valid.replace(
      "### Findings\n",
      "### Findings\n\n```md\n## 🐙 Octopus Review\n\n### Summary\n\n### Score\n\n### Findings Summary\n```\n",
    );
    expect(error(fenced)).toBeNull();
    expect(normalizeReviewResponse(fenced)).toContain("```md\n## 🐙 Octopus Review\n\n### Summary\n\n### Score\n\n### Findings Summary\n```");
  });
});
