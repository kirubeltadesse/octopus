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

function select(
  runs: ReturnType<typeof run>[],
  externalId: string,
  options?: { legacy?: (r: ReturnType<typeof run>) => boolean; context?: string },
) {
  const logs: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args); };
  try {
    return { run: selectCheckRunForRequest(runs, APP, externalId, options), logs };
  } finally {
    console.warn = warn;
  }
}

describe("selectCheckRunForRequest", () => {
  it("preserves exact external_id matching", () => {
    const runs = [
      run({ id: 1, external_id: "pr:1" }),
      run({ id: 2, external_id: "pr:2" }),
    ];
    expect(select(runs, "pr:2").run?.id).toBe(2);
  });

  it("prefers an unfinished exact match over a completed duplicate", () => {
    const runs = [
      run({ id: 1, external_id: "pr:1", status: "completed" }),
      run({ id: 2, external_id: "pr:1", status: "in_progress" }),
    ];
    expect(select(runs, "pr:1").run?.id).toBe(2);
  });

  it("never selects a lone legacy check without reliable correlation", () => {
    const runs = [run({ id: 5, external_id: null, status: "in_progress" })];
    const result = select(runs, "pr:1", { context: "owner/repo@abc1234" });
    expect(result.run).toBeNull();
    expect(result.logs.length).toBe(1);
    expect(String(result.logs[0][0])).toContain("lack reliable request correlation");
  });

  it("selects a legacy check only when a reliable correlation matches exactly one run", () => {
    const runs = [run({ id: 5, external_id: null, started_at: "2026-01-01T09:00:00Z" })];
    expect(select(runs, "pr:1", { legacy: candidate => candidate.id === 5 }).run?.id).toBe(5);
  });

  it("does not guess when two legacy checks are ambiguous", () => {
    const runs = [
      run({ id: 1, external_id: null }),
      run({ id: 2, external_id: null }),
    ];
    const result = select(runs, "pr:1", { legacy: () => true });
    expect(result.run).toBeNull();
    expect(result.logs.length).toBe(1);
  });

  it("does not select a legacy check when the correlation finds nothing", () => {
    const runs = [run({ id: 1, external_id: null })];
    expect(select(runs, "pr:1", { legacy: () => false }).run).toBeNull();
  });

  it("regression: a single unrelated older check on the same commit is not selected", () => {
    // No external_id and no reliable owner evidence: being the only check on the
    // commit is not sufficient.
    const runs = [run({ id: 9, external_id: null, status: "in_progress", started_at: "2025-12-31T08:00:00Z" })];
    const result = select(runs, "pr:1");
    expect(result.run).toBeNull();
    expect(result.logs.length).toBe(1);
  });

  it("skips checks owned by another App", () => {
    const runs = [run({ id: 1, external_id: "pr:1", app: { id: 99 } })];
    expect(select(runs, "pr:1").run).toBeNull();
  });

  it("returns no check when the commit has none", () => {
    expect(select([], "pr:1").run).toBeNull();
  });
});
