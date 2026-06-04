import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResourceTools, fetchResourceMissionsHistory } from "./resources.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerResourceTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register CRUD tools + 10 tab tools + 1 composite = 16 total", () => {
    registerResourceTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(16);
  });

  it("should register the missions_history composite tool", () => {
    registerResourceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_resources_missions_history");
  });

  it("should register all CRUD tools", () => {
    registerResourceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_resources_search");
    expect(names).toContain("boond_resources_get");
    expect(names).toContain("boond_resources_create");
    expect(names).toContain("boond_resources_update");
    expect(names).toContain("boond_resources_delete");
  });

  it("should register all 10 tab tools", () => {
    registerResourceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_resources_information");
    expect(names).toContain("boond_resources_technical_data");
    expect(names).toContain("boond_resources_administrative");
    expect(names).toContain("boond_resources_advantages");
    expect(names).toContain("boond_resources_actions");
    expect(names).toContain("boond_resources_positionings");
    expect(names).toContain("boond_resources_projects");
    expect(names).toContain("boond_resources_times_reports");
    expect(names).toContain("boond_resources_expenses_reports");
    expect(names).toContain("boond_resources_absences_reports");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerResourceTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_resources_information",
            "boond_resources_technical_data",
            "boond_resources_administrative",
            "boond_resources_advantages",
            "boond_resources_actions",
            "boond_resources_positionings",
            "boond_resources_projects",
            "boond_resources_times_reports",
            "boond_resources_expenses_reports",
            "boond_resources_absences_reports",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(10);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });
});

// ---- Composite tool : missions history (v1.11.0) --------------------------

describe("fetchResourceMissionsHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function projectStub(id: string, ref: string, companyId: string, typeOf = 2) {
    return {
      id,
      type: "project",
      attributes: { reference: ref, typeOf },
      relationships: { company: { data: { id: companyId, type: "company" } } },
    };
  }

  function projectDetailStub(id: string, startDate: string) {
    return { data: { id, type: "project", attributes: { startDate }, relationships: {} } };
  }

  function companyStub(id: string, name: string) {
    return { data: { id, type: "company", attributes: { name } } };
  }

  it("aggregates projects + resolves company names + project startDates in one call", async () => {
    // Mock fetchTabResponse (the v1.10.3 paginated tab fetcher) to return 3 projects.
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: [
        projectStub("1649", "CSE - Formation", "282"),
        projectStub("1517", "Migration cloud", "501"),
        projectStub("976", "Audit SI", "282"),
      ],
      meta: { totals: { rows: 3 } },
    } as never);
    // Mock apiRequest for /companies/{id} and /projects/{id}.
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/companies/282") return companyStub("282", "VERSUSMIND France") as never;
      if (path === "/companies/501") return companyStub("501", "ACME Industries") as never;
      if (path === "/projects/1649") return projectDetailStub("1649", "2024-09-30") as never;
      if (path === "/projects/1517") return projectDetailStub("1517", "2025-03-15") as never;
      if (path === "/projects/976") return projectDetailStub("976", "2022-01-10") as never;
      return { data: null } as never;
    });

    const { rows, resourceId } = await fetchResourceMissionsHistory({ resourceId: "20" });
    expect(resourceId).toBe("20");
    expect(rows).toHaveLength(3);
    // Sorted by startDate desc.
    expect(rows.map((r) => r.projectId)).toEqual(["1517", "1649", "976"]);
    // Company names resolved.
    expect(rows[0].companyName).toBe("ACME Industries");
    expect(rows[1].companyName).toBe("VERSUSMIND France");
    expect(rows[2].companyName).toBe("VERSUSMIND France");
    // Project typeOf decorated (2 = Régie).
    expect(rows[0].typeLabel).toBe("Régie");
  });

  it("deduplicates company GETs (only one call per unique company)", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path.startsWith("/companies/")) return companyStub("282", "VERSUSMIND France") as never;
      return { data: null } as never;
    });
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: [projectStub("1", "P1", "282"), projectStub("2", "P2", "282"), projectStub("3", "P3", "282")],
    } as never);
    await fetchResourceMissionsHistory({ resourceId: "20", withProjectDates: false });
    const companyCalls = apiSpy.mock.calls.filter((c) => (c[0] as string).startsWith("/companies/"));
    expect(companyCalls).toHaveLength(1); // 1 unique company → 1 GET
  });

  it("skips project date enrichment when withProjectDates=false (saves N calls)", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: [projectStub("1", "P1", "282"), projectStub("2", "P2", "501")],
    } as never);
    await fetchResourceMissionsHistory({ resourceId: "20", withProjectDates: false });
    const projectCalls = apiSpy.mock.calls.filter((c) => (c[0] as string).startsWith("/projects/"));
    expect(projectCalls).toHaveLength(0);
  });

  it("returns an empty result for a consultant with no projects", async () => {
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({ data: [], meta: { totals: { rows: 0 } } } as never);
    const { rows } = await fetchResourceMissionsHistory({ resourceId: "99" });
    expect(rows).toEqual([]);
  });

  it("caps the parallel enrichments at `maxEnrichments`", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    // 50 projects spread across 50 distinct companies.
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: Array.from({ length: 50 }, (_, i) => projectStub(String(i), `P${i}`, String(1000 + i))),
    } as never);
    await fetchResourceMissionsHistory({ resourceId: "20", maxEnrichments: 10, withProjectDates: false });
    const companyCalls = apiSpy.mock.calls.filter((c) => (c[0] as string).startsWith("/companies/"));
    expect(companyCalls).toHaveLength(10); // cap honoured
  });
});
