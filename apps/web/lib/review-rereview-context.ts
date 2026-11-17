import type { PRReviewComment } from "@/lib/github";
import type { PriorFinding } from "@/lib/review-dedup";

export type ReReviewDismissedFinding = {
  title: string;
  description: string | null;
  severity: string;
  filePath: string | null;
  lineNumber: number | null;
};

/**
 * Re-review context deliberately stresses that an empty findings list is the
 * expected outcome. That framing can nudge a model to explain resolved findings
 * as unheaded prose directly after the Findings Summary table, which the review
 * validator rejects. Keep the main output contract explicit at the end of this
 * context without duplicating the whole reporting template.
 */
export const RE_REVIEW_OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT - STILL IN FORCE ON RE-REVIEWS:",
  "- `### Findings Summary` must contain only the Severity/Count table. Do not append prose, bullets, conclusions, or explanations of resolved findings after that table.",
  "- Put explanations of resolved or reconsidered findings in `### Summary`, not after the table.",
  "- If there are no new findings, output an empty JSON array `[]` between the existing `<!-- OCTOPUS_FINDINGS_START -->` / `<!-- OCTOPUS_FINDINGS_END -->` markers.",
  "- Keep every mandatory section and the required Score table unchanged.",
].join("\n");

export function buildReReviewContext(input: {
  botLogin: string;
  botComments: PRReviewComment[];
  allPriorReviewComments: PRReviewComment[];
  priorSummaryTableFindings: PriorFinding[];
  dismissedFindings: ReReviewDismissedFinding[];
}): string {
  const { botLogin, botComments, allPriorReviewComments, priorSummaryTableFindings, dismissedFindings } = input;
  const parts: string[] = [
    "⚠️ RE-REVIEW MODE — STRICT DEDUPLICATION REQUIRED ⚠️",
    "",
    "This PR has already been reviewed. Your ONLY job is to verify whether previously raised findings have been addressed. Follow these rules with ZERO exceptions:",
    "",
    "RULE 1 — NO NEW FINDINGS: Do NOT raise any new findings UNLESS they are 🔴 CRITICAL severity AND were clearly introduced by code changes made AFTER the last review. If the code existed in the prior review, you already had your chance to flag it.",
    "",
    "RULE 2 — NO REPEATS: Do NOT rephrase, reframe, re-angle, or re-raise ANY previously raised finding. This applies even if you use completely different wording. Examples of PROHIBITED repeats:",
    '  - Prior: "Inefficient blob buffering" → New: "Memory inefficient blob buffering" (SAME finding, different adjective)',
    '  - Prior: "Console.error in production" → New: "Console.log in production" (SAME concept)',
    '  - Prior: "Missing auth check" → New: "No authentication verification" (SAME issue rephrased)',
    "  A finding is a repeat if it targets the same file, nearby lines (±10), and the same conceptual issue.",
    "",
    "RULE 3 — AUTHOR RESPONSES MEAN DISMISSED: When the author has replied to a finding with an explanation, that finding is DISMISSED. Do not re-raise it, even if you disagree with the author's reasoning. The author knows their codebase better than you.",
    "",
    "RULE 4 — EMPTY IS GOOD: If all previous findings are addressed and no critical new issues exist, the findings list MUST be empty. An empty findings list on re-review is the EXPECTED outcome.",
    "",
    "RULE 5 — SELF-CHECK: Before including ANY finding in your output, ask yourself: 'Does this finding overlap with ANY item in PRIOR INLINE COMMENTS or DISMISSED FINDINGS below?' If yes, EXCLUDE it.",
    "",
    "RULE 6 — SCORE MUST REFLECT CURRENT STATE: Score each category based on the PR as it stands NOW (all commits combined). Items marked ✅ RESOLVED below have been fixed by the author (the code at that location has changed since your last review). If a prior finding is resolved — especially if the author applied YOUR OWN suggestion — that category's score MUST improve. A fixed security issue means Security should be 4/5 or 5/5, NOT the old score. Do NOT penalize for resolved issues.",
  ];

  const repliesByBotComment = new Map<number, string[]>();
  for (const c of allPriorReviewComments) {
    if (c.inReplyToId && c.user !== botLogin) {
      const replies = repliesByBotComment.get(c.inReplyToId) ?? [];
      replies.push(c.body);
      repliesByBotComment.set(c.inReplyToId, replies);
    }
  }

  if (botComments.length > 0) {
    const summaries = botComments.map((c) => {
      const bodyLines = c.body.split("\n").filter((l) => l.trim());
      const summary = bodyLines.slice(0, 2).map((l) => l.replace(/\*\*/g, "").trim()).join(" — ");
      const resolvedTag = c.isOutdated ? " ✅ RESOLVED (code changed)" : "";
      let entry = `- ${c.path}:${c.line} — ${summary}${resolvedTag}`;
      const replies = repliesByBotComment.get(c.id);
      if (replies && replies.length > 0) {
        const replyTexts = replies.map((r) => r.trim().slice(0, 200)).join("; ");
        entry += `\n  Author response: ${replyTexts}`;
      }
      return entry;
    });
    parts.push(
      "",
      "═══ PRIOR INLINE COMMENTS (BLOCKED — every item below is BANNED from your output, even with different wording) ═══",
      ...summaries,
    );
  }

  if (priorSummaryTableFindings.length > 0) {
    const inlineKeys = new Set(botComments.map((c) => `${c.path}:${c.line}`));
    const uniqueTableFindings = priorSummaryTableFindings.filter(
      (f) => !inlineKeys.has(`${f.filePath}:${f.line}`),
    );
    if (uniqueTableFindings.length > 0) {
      parts.push(
        "",
        "═══ PRIOR SUMMARY TABLE FINDINGS (BLOCKED — these were raised in previous reviews, do NOT repeat) ═══",
        ...uniqueTableFindings.map((f) => `- ${f.filePath}:${f.line} — "${f.title}"`),
      );
    }
  }

  if (dismissedFindings.length > 0) {
    parts.push(
      "",
      "═══ DISMISSED FINDINGS (BANNED — the author explicitly rejected these, do NOT repeat or rephrase) ═══",
      ...dismissedFindings.map((f) => {
        const desc = f.description ? ` — ${f.description.slice(0, 150)}` : "";
        return `- [${f.severity}] ${f.filePath ?? "unknown"}: "${f.title}"${desc}`;
      }),
    );
  }

  parts.push("", RE_REVIEW_OUTPUT_CONTRACT);
  return parts.join("\n");
}
