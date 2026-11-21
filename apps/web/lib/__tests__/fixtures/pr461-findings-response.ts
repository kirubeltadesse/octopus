const finding = {
  severity: "🟠",
  title: "Interpolated SQL input",
  filePath: "src/query.ts",
  startLine: 12,
  endLine: 12,
  category: "Security",
  description: "The query concatenates untrusted input into SQL.",
  suggestion: "Use a parameterized query.",
  confidence: 92,
};

const block = `<!-- OCTOPUS_FINDINGS_START -->
\`\`\`json
${JSON.stringify([finding], null, 2)}
\`\`\`
`;

export const PR461_FINDINGS_RESPONSE = `## 🐙 Octopus Review

### Summary
The change introduces a query path that needs review.

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 3/5 | Query interpolation |
| Code Quality | 4/5 | Clear layout |
| Performance | 5/5 | Bounded work |
| Error Handling | 4/5 | Guarded failures |
| Consistency | 5/5 | Consistent |
| **Overall** | **3/5** | Lowest category |

### Findings Summary
| Severity | Count |
| --- | --- |
| 🔴 Critical | 0 |
| 🟠 High | 1 |
| 🟡 Medium | 0 |
| 🔵 Low | 0 |
| 💡 Nit | 0 |

### Findings
${block}<!-- OCTOPUS_FINDINGS_END-->
Last reviewed commit: ad452241f25b3023ac467a7109cfe99a98a9fd95

${block}<!-- OCTOPUS_FINDINGS_END -->
`;
