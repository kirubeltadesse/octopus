import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));
const { selectCheckRunForRequest } = await import("@/lib/github");

const APP = 7;
const run = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: "in_progress",
  external_id: null as string | null,
  started_at: "2026-01-01T10:00:00Z" as string | null,
  app: { id: APP },
  ...overrides,
});
const REQUEST = new Date("2026-01-01T10:05:00Z");

describe("selectCheckRunForRequest", () => {
  it("prefers an exact external_id match", () => {
    const runs = [
      run({ id: 1, external_id: "pr:1" }),
      run({ id: 2, external_id: "pr:2", started_at: "2026-01-01T09:00:00Z" }),
    ];
    expect(selectCheckRunForRequest(runs, APP, "pr:2", REQUEST)?.id).toBe(2);
  });

  it("prefers an unfinished exact match over a completed duplicate", () => {
    const runs = [
      run({ id: 1, external_id: "pr:1", status: "completed" }),
      run({ id: 2, external_id: "pr:1", status: "in_progress" }),
    ];
    expect(selectCheckRunForRequest(runs, APP, "pr:1")?.id).toBe(2);
  });

  it("recovers a single unfinished legacy check started before the cutoff", () => {
    const runs = [run({ id: 5, external_id: null, status: "in_progress", started_at: "2026-01-01T10:04:00Z" })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)?.id).toBe(5);
  });

  it("never guesses when multiple legacy checks are ambiguous", () => {
    const runs = [
      run({ id: 1, external_id: null, started_at: "2026-01-01T10:00:00Z" }),
      run({ id: 2, external_id: null, started_at: "2026-01-01T10:01:00Z" }),
    ];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)).toBeNull();
  });

  it("never selects a completed legacy check", () => {
    const runs = [run({ id: 1, external_id: null, status: "completed" })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)).toBeNull();
  });

  it("never selects a legacy check from a newer attempt after the cutoff", () => {
    const runs = [run({ id: 1, external_id: null, started_at: "2026-01-01T10:10:00Z" })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)).toBeNull();
  });

  it("does not guess when the legacy start time is missing", () => {
    const runs = [run({ id: 1, external_id: null, started_at: null })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)).toBeNull();
  });

  it("skips checks owned by another App", () => {
    const runs = [run({ id: 1, external_id: "pr:1", app: { id: 99 } })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1", REQUEST)).toBeNull();
  });

  it("requires a cutoff before recovering legacy checks", () => {
    const runs = [run({ id: 1, external_id: null })];
    expect(selectCheckRunForRequest(runs, APP, "pr:1")).toBeNull();
  });
});
