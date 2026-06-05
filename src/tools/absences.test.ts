import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAbsenceTools,
  searchAbsencesEnriched,
  periodOverlapsWindow,
  toMonth,
  defaultMonthlyWindow,
} from "./absences.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerAbsenceTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register 5 absence tools", () => {
    registerAbsenceTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("should register all expected tool names", () => {
    registerAbsenceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_absences_search");
    expect(names).toContain("boond_absences_get");
    expect(names).toContain("boond_absences_create");
    expect(names).toContain("boond_absences_update");
    expect(names).toContain("boond_absences_delete");
  });

  it("should register search and get as readOnly", () => {
    registerAbsenceTools(server);
    const readOnlyCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) => typeof c[0] === "string" && ["boond_absences_search", "boond_absences_get"].includes(c[0] as string)
      );
    for (const call of readOnlyCalls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("should register delete as destructive", () => {
    registerAbsenceTools(server);
    const deleteCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_absences_delete");
    expect(deleteCall?.[1].annotations?.destructiveHint).toBe(true);
  });
});

// ---- Period overlap helper (v1.11.2) --------------------------------------

describe("periodOverlapsWindow", () => {
  it("returns true when both window bounds are absent", () => {
    expect(periodOverlapsWindow("2026-04-25", "2026-04-26")).toBe(true);
  });

  it("rejects a period entirely before the window", () => {
    expect(periodOverlapsWindow("2026-04-01", "2026-04-15", "2026-04-21", "2026-05-20")).toBe(false);
  });

  it("rejects a period entirely after the window", () => {
    expect(periodOverlapsWindow("2026-05-25", "2026-05-30", "2026-04-21", "2026-05-20")).toBe(false);
  });

  it("accepts a period that touches the lower bound (inclusive overlap)", () => {
    expect(periodOverlapsWindow("2026-04-01", "2026-04-21", "2026-04-21", "2026-05-20")).toBe(true);
  });

  it("accepts a period that touches the upper bound (inclusive overlap)", () => {
    expect(periodOverlapsWindow("2026-05-20", "2026-06-01", "2026-04-21", "2026-05-20")).toBe(true);
  });

  it("accepts a period nested inside the window", () => {
    expect(periodOverlapsWindow("2026-05-01", "2026-05-02", "2026-04-21", "2026-05-20")).toBe(true);
  });

  it("accepts a period that fully contains the window", () => {
    expect(periodOverlapsWindow("2026-01-01", "2026-12-31", "2026-04-21", "2026-05-20")).toBe(true);
  });

  it("respects a one-sided window (only startDate)", () => {
    expect(periodOverlapsWindow("2025-01-01", "2025-01-15", "2026-01-01")).toBe(false);
    expect(periodOverlapsWindow("2026-02-01", "2026-02-15", "2026-01-01")).toBe(true);
  });
});

// ---- searchAbsencesEnriched (v1.11.2) -------------------------------------

describe("searchAbsencesEnriched", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function reportStub(id: string, resourceId: string, periods: object[], state = "validated") {
    return {
      id,
      type: "absencesreport",
      attributes: { state, absencesPeriods: periods },
      relationships: { resource: { data: { id: resourceId, type: "resource" } } },
    };
  }

  function resourceInc(id: string, firstName: string, lastName: string) {
    return { id, type: "resource", attributes: { firstName, lastName } };
  }

  it("calls /absences-reports with include=resource (Bug 3 alignment with get)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await searchAbsencesEnriched({ page: 1, pageSize: 30 });
    const callPath = spy.mock.calls[0][0] as string;
    const callQuery = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(callPath).toBe("/absences-reports");
    expect(callQuery["include"]).toBe("resource");
  });

  it("filters out periods that do not overlap the window (Bug 1 core fix)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [
        reportStub("100", "20", [
          {
            startDate: "2026-04-25",
            endDate: "2026-04-26",
            duration: 2,
            title: "",
            workUnitType: { name: "RTT", reference: 3, activityType: "absence" },
          },
        ]),
        reportStub("101", "20", [
          {
            startDate: "2026-01-01",
            endDate: "2026-01-02",
            duration: 2,
            title: "",
            workUnitType: { name: "Congé payé", reference: 1, activityType: "absence" },
          },
        ]),
        reportStub("102", "20", [
          {
            startDate: "2026-06-01",
            endDate: "2026-06-02",
            duration: 2,
            title: "",
            workUnitType: { name: "Maladie", reference: 5, activityType: "absence" },
          },
        ]),
      ],
      included: [resourceInc("20", "Damien", "BLAISE")],
      meta: { totals: { rows: 3 } },
    } as never);
    const result = await searchAbsencesEnriched({
      page: 1,
      pageSize: 30,
      startDate: "2026-04-21",
      endDate: "2026-05-20",
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].reportId).toBe("100");
    expect(result.rows[0].lastName).toBe("BLAISE");
    expect(result.rows[0].firstName).toBe("Damien");
    expect(result.rows[0].typeName).toBe("RTT");
  });

  it("enriches each row with resource lastName + firstName via included[] (Bug 2 fix)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [
        reportStub("200", "25", [
          { startDate: "2026-04-25", endDate: "2026-04-25", duration: 1, workUnitType: { name: "RTT" } },
        ]),
        reportStub("201", "30", [
          {
            startDate: "2026-04-26",
            endDate: "2026-04-26",
            duration: 0.5,
            title: "matin",
            workUnitType: { name: "Congé payé" },
          },
        ]),
      ],
      included: [resourceInc("25", "Alice", "MARTIN"), resourceInc("30", "Bob", "DUPONT")],
      meta: { totals: { rows: 2 } },
    } as never);
    const result = await searchAbsencesEnriched({ page: 1, pageSize: 30 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].lastName).toBe("DUPONT");
    expect(result.rows[0].firstName).toBe("Bob");
    expect(result.rows[0].title).toBe("matin");
    expect(result.rows[0].duration).toBe(0.5);
    expect(result.rows[1].lastName).toBe("MARTIN");
    expect(result.rows[1].typeName).toBe("RTT");
  });

  it("flattens a single report with multiple periods into multiple rows", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [
        reportStub("300", "20", [
          { startDate: "2026-04-22", endDate: "2026-04-22", duration: 1, workUnitType: { name: "RTT" } },
          {
            startDate: "2026-04-23",
            endDate: "2026-04-23",
            duration: 0.5,
            title: "après-midi",
            workUnitType: { name: "Congé payé" },
          },
        ]),
      ],
      included: [resourceInc("20", "Damien", "BLAISE")],
      meta: { totals: { rows: 1 } },
    } as never);
    const result = await searchAbsencesEnriched({ page: 1, pageSize: 30 });
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.reportId).toBe("300");
      expect(row.lastName).toBe("BLAISE");
    }
  });

  it("returns an empty result when no period overlaps the window (no false positives)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [
        reportStub("6593", "20", [], "savedAndNoValidation"),
        reportStub("400", "20", [
          { startDate: "2026-01-23", endDate: "2026-01-23", duration: 1, workUnitType: { name: "RTT" } },
        ]),
      ],
      included: [resourceInc("20", "Damien", "BLAISE")],
      meta: { totals: { rows: 2 } },
    } as never);
    const result = await searchAbsencesEnriched({
      page: 1,
      pageSize: 30,
      startDate: "2026-04-21",
      endDate: "2026-05-20",
    });
    expect(result.rows).toHaveLength(0);
    expect(result.filtered).toBe(true);
    expect(result.totalReportsFetched).toBe(2);
  });

  it("auto-paginates when a date window is set (server filter may not narrow)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (_path, _method, _body, query) => {
      const q = query as Record<string, unknown>;
      const page = q?.["page"] as number;
      if (page === 1) {
        return {
          data: Array.from({ length: 500 }, (_, i) =>
            reportStub(`p1-${i}`, "20", [
              { startDate: "2026-04-25", endDate: "2026-04-25", duration: 1, workUnitType: { name: "RTT" } },
            ])
          ),
          meta: { totals: { rows: 700 } },
        } as never;
      }
      return {
        data: Array.from({ length: 200 }, (_, i) =>
          reportStub(`p2-${i}`, "20", [
            { startDate: "2026-04-26", endDate: "2026-04-26", duration: 1, workUnitType: { name: "RTT" } },
          ])
        ),
        meta: { totals: { rows: 700 } },
      } as never;
    });
    const result = await searchAbsencesEnriched({
      page: 1,
      pageSize: 30,
      startDate: "2026-04-21",
      endDate: "2026-05-20",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.totalReportsFetched).toBe(700);
    expect(result.rows).toHaveLength(700);
  });

  it("respects maxScannedReports cap to prevent runaway pagination", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockImplementation(
      async () =>
        ({
          data: Array.from({ length: 500 }, (_, i) =>
            reportStub(`r-${i}`, "20", [
              { startDate: "2026-04-25", endDate: "2026-04-25", duration: 1, workUnitType: { name: "RTT" } },
            ])
          ),
          meta: { totals: { rows: 5000 } },
        }) as never
    );
    await searchAbsencesEnriched({
      page: 1,
      pageSize: 30,
      startDate: "2026-04-21",
      endDate: "2026-05-20",
      maxScannedReports: 600,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not auto-paginate when no date window is provided", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: Array.from({ length: 30 }, (_, i) =>
        reportStub(`r-${i}`, "20", [
          { startDate: "2026-04-25", endDate: "2026-04-25", duration: 1, workUnitType: { name: "RTT" } },
        ])
      ),
      meta: { totals: { rows: 17110 } },
    } as never);
    await searchAbsencesEnriched({ page: 1, pageSize: 30 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("transforms resourceId into a COMP<id> keyword prefix (alignment with /actions pattern)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await searchAbsencesEnriched({ page: 1, pageSize: 30, resourceId: "20" });
    const q = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(q["keywords"]).toBe("COMP20");
  });

  it("prepends COMP<id> to a caller-provided keywords string", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await searchAbsencesEnriched({ page: 1, pageSize: 30, resourceId: "20", keywords: "RTT" });
    const q = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(q["keywords"]).toBe("COMP20 RTT");
  });

  it("derives startMonth/endMonth (YYYY-MM) from startDate/endDate for the API (required params per /absences-reports 422)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await searchAbsencesEnriched({
      page: 1,
      pageSize: 30,
      startDate: "2026-04-21",
      endDate: "2026-05-20",
    });
    const q = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(q["startMonth"]).toBe("2026-04");
    expect(q["endMonth"]).toBe("2026-05");
    // The daily params are NOT forwarded — only their month projection.
    expect(q["startDate"]).toBeUndefined();
    expect(q["endDate"]).toBeUndefined();
  });

  it("falls back to a default monthly window (today ±1y) when neither bound is given (the API rejects calls without them)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await searchAbsencesEnriched({ page: 1, pageSize: 30 });
    const q = spy.mock.calls[0][3] as Record<string, unknown>;
    expect(typeof q["startMonth"]).toBe("string");
    expect(typeof q["endMonth"]).toBe("string");
    expect(q["startMonth"] as string).toMatch(/^\d{4}-\d{2}$/);
    expect(q["endMonth"] as string).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ---- Date helpers (v1.11.2) -----------------------------------------------

describe("toMonth", () => {
  it("extracts YYYY-MM from a YYYY-MM-DD string", () => {
    expect(toMonth("2026-04-21")).toBe("2026-04");
  });
  it("returns null for undefined input", () => {
    expect(toMonth(undefined)).toBeNull();
  });
  it("returns null for malformed input", () => {
    expect(toMonth("2026/04/21")).toBeNull();
    expect(toMonth("abc")).toBeNull();
  });
});

describe("defaultMonthlyWindow", () => {
  it("returns a 24-month window centred on the given date", () => {
    const w = defaultMonthlyWindow(new Date("2026-06-15T12:00:00Z"));
    expect(w.startMonth).toBe("2025-06");
    expect(w.endMonth).toBe("2027-06");
  });
  it("pads month digits with a leading zero", () => {
    const w = defaultMonthlyWindow(new Date("2026-01-05T00:00:00Z"));
    expect(w.startMonth).toBe("2025-01");
    expect(w.endMonth).toBe("2027-01");
  });
});
