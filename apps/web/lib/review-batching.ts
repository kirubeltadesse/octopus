import type { Ignore } from "ignore";
import { prepareReviewInput, sha256, type ReviewCoverage, type ReviewInput } from "@/lib/review-coverage";
import { MAX_FETCH_DIFF_CHARS } from "@/lib/diff-truncate";

export const REVIEW_BATCH_CHARS_DEFAULT = 35_000;
export const REVIEW_MULTI_PASS_THRESHOLD_DEFAULT = 60_000;
export const REVIEW_MAX_BATCHES_DEFAULT = 12;
export const REVIEW_BATCH_MIN_CHARS = 10_000;
export const REVIEW_BATCH_MAX_CHARS = 100_000;

function positiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export type ReviewBatchConfig = {
  batchChars: number;
  thresholdChars: number;
  maxBatches: number;
};

export function reviewBatchConfig(env: NodeJS.ProcessEnv = process.env): ReviewBatchConfig {
  const batchChars = positiveInt(env.OCTOPUS_REVIEW_BATCH_CHARS, REVIEW_BATCH_CHARS_DEFAULT, REVIEW_BATCH_MIN_CHARS, REVIEW_BATCH_MAX_CHARS);
  return {
    batchChars,
    thresholdChars: positiveInt(env.OCTOPUS_REVIEW_MULTI_PASS_THRESHOLD_CHARS, REVIEW_MULTI_PASS_THRESHOLD_DEFAULT, batchChars, MAX_FETCH_DIFF_CHARS),
    maxBatches: positiveInt(env.OCTOPUS_REVIEW_MAX_BATCHES, REVIEW_MAX_BATCHES_DEFAULT, 1, 64),
  };
}

export type ReviewBatchSection = {
  path: string;
  text: string;
  chars: number;
  sha256: string;
};

export type ReviewBatch = {
  index: number;
  stepKey: string;
  sections: ReviewBatchSection[];
  files: string[];
  diff: string;
  chars: number;
};

export type ReviewBatchPlan = {
  mode: "single" | "multi";
  batches: ReviewBatch[];
  coverage: ReviewCoverage;
  diff: string;
  totalChars: number;
  changedFiles: number;
  config: ReviewBatchConfig;
  limitations: string[];
  /** Set only when a complete, authoritative multi-pass review is impossible. */
  error: string | null;
};

function sectionPath(section: string): string | null {
  const first = section.split("\n", 1)[0] ?? "";
  return /^diff --git a\/.+ b\/(.+)$/.exec(first)?.[1] ?? null;
}

/**
 * Build one complete per-file section from the already policy-filtered diff.
 * Splitting never changes a path, hunk or line number: it only groups whole
 * files (or whole hunks for an oversized file) into bounded requests.
 */
function sectionsFromDiff(diff: string): { sections: ReviewBatchSection[]; errors: string[] } {
  const sections: ReviewBatchSection[] = [];
  const errors: string[] = [];
  for (const block of diff.split(/(?=^diff --git )/m)) {
    if (!block) continue;
    const path = sectionPath(block);
    if (!path) {
      errors.push("A changed-file section could not be mapped to its path");
      continue;
    }
    sections.push({ path, text: block, chars: block.length, sha256: sha256(block) });
  }
  return { sections, errors };
}

/** Split an oversized file only at hunk boundaries; a single oversized hunk is refused. */
function splitOversized(section: ReviewBatchSection, target: number): { parts: ReviewBatchSection[]; error: string | null } {
  const pieces = section.text.split(/(?=^@@ )/m);
  const header = pieces[0] ?? "";
  const hunks = pieces.slice(1);
  if (!hunks.length) return { parts: [], error: `Oversized file ${section.path} has no separable hunks` };
  const parts: ReviewBatchSection[] = [];
  let text = header;
  const flush = () => {
    if (text.length > header.length) parts.push({ path: section.path, text, chars: text.length, sha256: sha256(text) });
    text = header;
  };
  for (const hunk of hunks) {
    if (hunk.length > target) {
      return { parts: [], error: `Oversized hunk in ${section.path} exceeds the batch budget` };
    }
    if (text.length + hunk.length > target) flush();
    text += hunk;
  }
  flush();
  if (parts.some(part => part.chars > target)) return { parts: [], error: `Oversized file ${section.path} cannot be split within the batch budget` };
  return { parts, error: null };
}

/**
 * Deterministic, file-aware planner for large review inputs.
 *
 * The policy decisions (generated files, .octopusignore, binary/empty evidence,
 * patch validation) come from `prepareReviewInput`, so batching cannot re-enable
 * an excluded file or hide an unavailable one. Whole files are packed first;
 * only a file larger than the batch budget is split, at complete hunk boundaries.
 */
export function planReviewBatches(
  reviewInput: ReviewInput,
  options: {
    generated?: Ignore;
    ignored?: Ignore;
    config?: Partial<ReviewBatchConfig>;
    env?: NodeJS.ProcessEnv;
  } = {},
): ReviewBatchPlan {
  const config = { ...reviewBatchConfig(options.env), ...options.config };
  // Plan against the full fetched input so no eligible file is dropped just to
  // fit a single request. The caller's original prepared input is untouched.
  const prepared = prepareReviewInput(reviewInput, { maxChars: MAX_FETCH_DIFF_CHARS, generated: options.generated, ignored: options.ignored });
  const { sections, errors } = sectionsFromDiff(prepared.diff);
  const limitations = [...prepared.coverage.limitations, ...errors];
  const totalChars = prepared.diff.length;
  const changedFiles = prepared.coverage.files.filter(file => file.state === "supplied" || file.state === "partial").length;
  const base: ReviewBatchPlan = { mode: "single", batches: [], coverage: prepared.coverage, diff: prepared.diff, totalChars,
    changedFiles, config, limitations, error: null };
  if (!prepared.coverage.complete || totalChars <= config.thresholdChars) return base;

  const expanded: ReviewBatchSection[] = [];
  for (const section of sections) {
    if (section.chars <= config.batchChars) {
      expanded.push(section);
      continue;
    }
    const split = splitOversized(section, config.batchChars);
    if (split.error) return { ...base, mode: "multi", error: split.error };
    expanded.push(...split.parts);
  }

  const batches: ReviewBatch[] = [];
  let current: ReviewBatchSection[] = [];
  let currentChars = 0;
  const flush = () => {
    if (!current.length) return;
    const index = batches.length;
    batches.push({
      index,
      stepKey: `batch:${index}`,
      sections: current,
      files: [...new Set(current.map(section => section.path))].sort(),
      diff: current.map(section => section.text).join(""),
      chars: currentChars,
    });
    current = [];
    currentChars = 0;
  };
  for (const section of expanded) {
    if (current.length && currentChars + section.chars > config.batchChars) flush();
    current.push(section);
    currentChars += section.chars;
  }
  flush();

  if (batches.length > config.maxBatches) {
    return { ...base, mode: "multi", error: `Large review needs ${batches.length} batches, above the ${config.maxBatches} request limit` };
  }
  // Split parts repeat a short file header so each batch is self-contained;
  // compare hunk bodies instead of raw characters to prove no source was lost.
  const hunkBody = (text: string) => {
    const start = text.search(/^@@ /m);
    return start < 0 ? "" : text.slice(start);
  };
  const originalHunks = sha256(sections.map(section => hunkBody(section.text)).join(""));
  const plannedHunks = sha256(expanded.map(section => hunkBody(section.text)).join(""));
  if (originalHunks !== plannedHunks) {
    return { ...base, mode: "multi", error: "Batch plan did not preserve the full changed input" };
  }
  return { ...base, mode: "multi", batches, limitations };
}

/** Stable identity for one pass; changing inputs or model invalidates stored work. */
export function reviewPassIdentity(input: {
  headSha: string | null;
  requestVersion: number;
  model: string;
  stepKey: string;
  sections: ReviewBatchSection[];
  promptSha256: string;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    headSha: input.headSha,
    requestVersion: input.requestVersion,
    model: input.model,
    stepKey: input.stepKey,
    promptSha256: input.promptSha256,
    sections: input.sections.map(section => [section.path, section.sha256]),
  }));
}
