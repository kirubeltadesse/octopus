export const isReviewRequestVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type ReviewState = {
  id: string;
  number: number;
  status: string;
  headSha?: string | null;
  reviewRequestVersion?: number;
};

export type ReviewStatusEvent = {
  repoId: string;
  pullRequestId: string;
  number: number;
  status: string;
  headSha?: string | null;
  reviewRequestVersion?: number;
};

export function applyReviewRequested<T extends ReviewState>(state: Record<string, T[]>, event: { repoId: string; pullRequest: T }): Record<string, T[]> {
  const existing = state[event.repoId] ?? [];
  const previous = existing.find(pr => pr.number === event.pullRequest.number);
  if (!event.pullRequest.headSha || !isReviewRequestVersion(event.pullRequest.reviewRequestVersion)) return state;
  if (previous && isReviewRequestVersion(previous.reviewRequestVersion) && event.pullRequest.reviewRequestVersion <= previous.reviewRequestVersion) return state;
  return { ...state, [event.repoId]: [event.pullRequest, ...existing.filter(pr => pr.number !== event.pullRequest.number)] };
}

export function applyReviewStatus<T extends ReviewState>(state: Record<string, T[]>, event: ReviewStatusEvent): Record<string, T[]> {
  if (!event.headSha || !isReviewRequestVersion(event.reviewRequestVersion)) return state;
  const existing = state[event.repoId];
  if (!existing?.some(pr => pr.id === event.pullRequestId && pr.number === event.number && pr.headSha === event.headSha && pr.reviewRequestVersion === event.reviewRequestVersion)) return state;
  return { ...state, [event.repoId]: existing.map(pr =>
    pr.id === event.pullRequestId && pr.number === event.number && pr.headSha === event.headSha && pr.reviewRequestVersion === event.reviewRequestVersion ? { ...pr, status: event.status } : pr,
  ) };
}

/** A user-cancelled review request. Terminal until the next request resets the row to pending. */
export const REVIEW_CANCELLED_STATUS = "cancelled";
export const REVIEW_CANCELLED_MESSAGE = "Review cancelled by @octopus cancel";
export const isReviewCancelledStatus = (status: string | null | undefined): boolean => status === REVIEW_CANCELLED_STATUS;
