import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInvoiceTools, fetchOverdueInvoices } from "./invoices.js";
import * as boondClient from "../services/boond-client.js";
import * as dictionaryService from "../services/dictionary.js";
import type { JsonApiResponse } from "../types.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

const INVOICE_STATE_DICT = {
  data: {
    setting: {
      state: {
        invoice: [
          { id: 1, value: "À facturer" },
          { id: 2, value: "Facturée" },
          { id: 3, value: "Partiellement payée" },
          { id: 4, value: "Payée" },
          { id: 5, value: "Annulée" },
          { id: 6, value: "Litigieuse" },
        ],
      },
    },
  },
} as unknown as JsonApiResponse;

function invoice(
  id: string,
  attrs: {
    dueDate?: string;
    expectedPaymentDate?: string;
    amountExcludingTax?: number;
    state?: number;
    reference?: string;
  },
  companyId?: string
) {
  return {
    id,
    type: "invoice",
    attributes: {
      reference: attrs.reference ?? `INV-${id}`,
      dueDate: attrs.dueDate,
      expectedPaymentDate: attrs.expectedPaymentDate,
      amountExcludingTax: attrs.amountExcludingTax ?? 0,
      state: attrs.state ?? 2,
    },
    relationships: companyId ? { company: { data: { id: companyId, type: "company" } } } : undefined,
  };
}

describe("registerInvoiceTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  it("should register 6 invoice tools", () => {
    registerInvoiceTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("should register all expected tool names", () => {
    registerInvoiceTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_invoices_search");
    expect(names).toContain("boond_invoices_get");
    expect(names).toContain("boond_invoices_create");
    expect(names).toContain("boond_invoices_update");
    expect(names).toContain("boond_invoices_delete");
    expect(names).toContain("boond_invoices_overdue");
  });

  it("should register search, get and overdue as readOnly", () => {
    registerInvoiceTools(server);
    const readOnlyNames = ["boond_invoices_search", "boond_invoices_get", "boond_invoices_overdue"];
    const readOnlyCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter((c) => typeof c[0] === "string" && readOnlyNames.includes(c[0] as string));
    expect(readOnlyCalls).toHaveLength(3);
    for (const call of readOnlyCalls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("should register delete as destructive", () => {
    registerInvoiceTools(server);
    const deleteCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_invoices_delete");
    expect(deleteCall?.[1].annotations?.destructiveHint).toBe(true);
  });
});

describe("fetchOverdueInvoices", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  it("excludes paid/cancelled states and keeps only invoices with dueDate < asOfDate", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      // /invoices
      return {
        data: [
          invoice("100", { dueDate: "2026-04-01", amountExcludingTax: 5000, state: 2 }, "10"), // overdue
          invoice("101", { dueDate: "2026-07-01", amountExcludingTax: 8000, state: 2 }, "10"), // future, ignored
          invoice("102", { dueDate: "2026-03-15", amountExcludingTax: 3000, state: 3 }, "11"), // partially paid, kept
        ],
      };
    });

    const { rows, scanned, asOfDate } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      pageSize: 500,
      maxPages: 5,
    });

    expect(asOfDate).toBe("2026-05-01");
    expect(scanned).toBe(3);
    // Sorted by daysOverdue DESC (oldest first)
    expect(rows.map((r) => r.invoiceId)).toEqual(["102", "100"]);
    expect(rows[0].daysOverdue).toBe(47); // 2026-05-01 - 2026-03-15
    expect(rows[1].daysOverdue).toBe(30); // 2026-05-01 - 2026-04-01

    // First call → dictionary, second → /invoices with states=[1,2,3,6] (no 4 paid, no 5 cancelled)
    const invoicesCall = apiSpy.mock.calls.find((c) => c[0] === "/invoices");
    expect(invoicesCall).toBeDefined();
    const queryParams = invoicesCall![3] as Record<string, unknown>;
    expect(queryParams["states"]).toEqual([1, 2, 3, 6]);
    // No explicit sort: we rely on BoondManager's default ordering so invoices using
    // expectedPaymentDate aren't pushed past the maxPages window.
    expect(queryParams["sort"]).toBeUndefined();
    expect(queryParams["order"]).toBeUndefined();
  });

  it("uses expectedPaymentDate when populated, falling back to dueDate otherwise", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          // Only expectedPaymentDate → must be picked up (regression for v1.9.0 bug)
          invoice("500", { expectedPaymentDate: "2026-03-10", amountExcludingTax: 1000 }, "50"),
          // Only dueDate → still works
          invoice("501", { dueDate: "2026-02-01", amountExcludingTax: 2000 }, "51"),
          // Both fields set → expectedPaymentDate wins
          invoice("502", { expectedPaymentDate: "2026-04-01", dueDate: "2026-01-01", amountExcludingTax: 3000 }, "52"),
          // Neither field → dropped
          invoice("503", { amountExcludingTax: 4000 }, "53"),
          // expectedPaymentDate is future → dropped (not overdue)
          invoice("504", { expectedPaymentDate: "2026-09-01", amountExcludingTax: 5000 }, "54"),
        ],
      };
    });

    const { rows } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      pageSize: 500,
      maxPages: 5,
    });

    const byId = new Map(rows.map((r) => [r.invoiceId, r]));
    expect([...byId.keys()].sort()).toEqual(["500", "501", "502"]);

    // expectedPaymentDate was used for 500 (only that field) and 502 (both set)
    expect(byId.get("500")!.dateField).toBe("expectedPaymentDate");
    expect(byId.get("500")!.effectiveDate).toBe("2026-03-10");
    expect(byId.get("502")!.dateField).toBe("expectedPaymentDate");
    expect(byId.get("502")!.effectiveDate).toBe("2026-04-01"); // not 2026-01-01 (dueDate)

    // dueDate is the fallback for 501
    expect(byId.get("501")!.dateField).toBe("dueDate");
    expect(byId.get("501")!.effectiveDate).toBe("2026-02-01");
  });

  it("applies amount range filtering and perimeter filters", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoice("200", { dueDate: "2026-01-01", amountExcludingTax: 500 }, "20"), // too small
          invoice("201", { dueDate: "2026-01-01", amountExcludingTax: 50000 }, "20"), // too big
          invoice("202", { dueDate: "2026-01-01", amountExcludingTax: 10000 }, "20"), // kept
        ],
      };
    });

    const { rows } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      amountMinExcludingTax: 1000,
      amountMaxExcludingTax: 20000,
      perimeterPoles: [3, 7],
      perimeterManagers: [42],
      pageSize: 500,
      maxPages: 5,
    });

    expect(rows.map((r) => r.invoiceId)).toEqual(["202"]);
    const queryParams = apiSpy.mock.calls.find((c) => c[0] === "/invoices")![3] as Record<string, unknown>;
    expect(queryParams["perimeterPoles"]).toEqual([3, 7]);
    expect(queryParams["perimeterManagers"]).toEqual([42]);
  });

  it("paginates until fewer than pageSize rows are returned", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path, _method, _body, query) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      calls.push((query ?? {}) as Record<string, unknown>);
      const page = Number((query as Record<string, unknown>)["page"] ?? 1);
      // Page 1: 2 rows (= full page), page 2: 1 row (partial → stop after)
      if (page === 1) {
        return {
          data: [
            invoice("301", { dueDate: "2026-01-01", amountExcludingTax: 100 }, "30"),
            invoice("302", { dueDate: "2026-01-02", amountExcludingTax: 200 }, "30"),
          ],
        };
      }
      return { data: [invoice("303", { dueDate: "2026-01-03", amountExcludingTax: 300 }, "30")] };
    });

    const { rows, scanned } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      pageSize: 2,
      maxPages: 5,
    });

    expect(scanned).toBe(3);
    expect(rows).toHaveLength(3);
    expect(calls.map((c) => c["page"])).toEqual([1, 2]);
  });

  it("hydrates company names from JSON:API `included`", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [invoice("400", { dueDate: "2026-01-01", amountExcludingTax: 1000 }, "40")],
        included: [
          {
            id: "40",
            type: "company",
            attributes: { name: "ACME Industries" },
          },
        ],
      };
    });

    const { rows } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      pageSize: 500,
      maxPages: 5,
    });
    expect(rows[0].companyName).toBe("ACME Industries");
  });

  it("rejects an asOfDate that does not parse", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue(INVOICE_STATE_DICT);
    await expect(
      fetchOverdueInvoices({
        asOfDate: "not-a-date",
        pageSize: 500,
        maxPages: 5,
      })
    ).rejects.toThrow(/asOfDate invalide/);
  });
});
