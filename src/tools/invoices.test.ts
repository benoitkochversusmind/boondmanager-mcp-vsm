import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInvoiceTools, fetchOverdueInvoices, isExcludedFromOverdue } from "./invoices.js";
import * as boondClient from "../services/boond-client.js";
import * as dictionaryService from "../services/dictionary.js";
import type { JsonApiResponse } from "../types.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

// Mirrors the real production dictionary observed via /application/dictionary
// (setting.state.invoice) — IDs are NOT arbitrary and must match what the
// shipped instance uses, otherwise the regression tests become fiction.
const INVOICE_STATE_DICT = {
  data: {
    setting: {
      state: {
        invoice: [
          { id: 0, value: "Création", isExcludedFromSentState: true },
          { id: 1, value: "Transmis au client", isExcludedFromSentState: false },
          { id: 2, value: "Impayée", isExcludedFromSentState: false },
          { id: 3, value: "Payée" },
          { id: 4, value: "Relance 1", isExcludedFromSentState: false },
          { id: 5, value: "Relance 2", isExcludedFromSentState: false },
          { id: 6, value: "Transmis au Groupe", isExcludedFromSentState: false },
          { id: 7, value: "Payée partiellement", isExcludedFromSentState: false },
          { id: 8, value: "Avoiré", isExcludedFromSentState: false },
          { id: 10, value: "ProForma", isExcludedFromSentState: true },
          { id: 15, value: "Payée groupe", isExcludedFromSentState: false },
        ],
      },
    },
  },
} as unknown as JsonApiResponse;

function invoice(
  id: string,
  attrs: {
    expectedPaymentDate?: string;
    dueDate?: string;
    turnoverExcludingTax?: number;
    turnoverIncludingTax?: number;
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
      expectedPaymentDate: attrs.expectedPaymentDate,
      dueDate: attrs.dueDate,
      turnoverExcludingTax: attrs.turnoverExcludingTax,
      turnoverIncludingTax: attrs.turnoverIncludingTax,
      state: attrs.state ?? 5,
    },
    relationships: companyId ? { company: { data: { id: companyId, type: "company" } } } : undefined,
  };
}

function company(id: string, name: string) {
  return { id, type: "company", attributes: { name } };
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

  it("boond_invoices_search asks BoondManager to include company/order/project", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return { data: [] };
    });
    registerInvoiceTools(server);
    const searchCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_invoices_search");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cb = searchCall![2] as any;
    await cb({ pageSize: 1, page: 1 });
    const invoicesCall = apiSpy.mock.calls.find((c) => c[0] === "/invoices");
    expect(invoicesCall).toBeDefined();
    const query = invoicesCall![3] as Record<string, unknown>;
    expect(query["include"]).toBe("company,order,project");
  });
});

describe("isExcludedFromOverdue", () => {
  // Uses the actual production state values to verify Bug 3 stays fixed.
  it("excludes states flagged isExcludedFromSentState (Création, ProForma)", () => {
    expect(isExcludedFromOverdue({ id: 0, value: "Création", isExcludedFromSentState: true })).toBe(true);
    expect(isExcludedFromOverdue({ id: 10, value: "ProForma", isExcludedFromSentState: true })).toBe(true);
  });

  it("excludes paid states (Payée, Payée groupe) regardless of flag", () => {
    expect(isExcludedFromOverdue({ id: 3, value: "Payée" })).toBe(true);
    expect(isExcludedFromOverdue({ id: 15, value: "Payée groupe", isExcludedFromSentState: false })).toBe(true);
  });

  it("KEEPS Payée partiellement (still has an outstanding balance)", () => {
    expect(isExcludedFromOverdue({ id: 7, value: "Payée partiellement", isExcludedFromSentState: false })).toBe(false);
  });

  it("excludes Avoiré (credit notes are not receivables)", () => {
    expect(isExcludedFromOverdue({ id: 8, value: "Avoiré", isExcludedFromSentState: false })).toBe(true);
  });

  it("excludes Annulée defensively even when not in the live dictionary", () => {
    expect(isExcludedFromOverdue({ id: 99, value: "Annulée" })).toBe(true);
  });

  it("KEEPS active relance / impayée / contentieux states", () => {
    expect(isExcludedFromOverdue({ id: 2, value: "Impayée", isExcludedFromSentState: false })).toBe(false);
    expect(isExcludedFromOverdue({ id: 4, value: "Relance 1", isExcludedFromSentState: false })).toBe(false);
    expect(isExcludedFromOverdue({ id: 5, value: "Relance 2", isExcludedFromSentState: false })).toBe(false);
    expect(isExcludedFromOverdue({ id: 13, value: "Contentieux", isExcludedFromSentState: false })).toBe(false);
  });
});

describe("fetchOverdueInvoices", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  it("filters strictly on expectedPaymentDate (no dueDate fallback) and sends correct unpaid state IDs", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          // Overdue via expectedPaymentDate — kept
          invoice("100", { expectedPaymentDate: "2026-04-01", turnoverExcludingTax: 5000, state: 5 }, "10"),
          // Has dueDate but no expectedPaymentDate — DROPPED (strict mode, no fallback)
          invoice("101", { dueDate: "2026-03-01", turnoverExcludingTax: 8000, state: 5 }, "11"),
          // expectedPaymentDate in the future — dropped
          invoice("102", { expectedPaymentDate: "2026-09-01", turnoverExcludingTax: 3000, state: 5 }, "10"),
        ],
      };
    });

    const { rows } = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      pageSize: 500,
      maxPages: 5,
    });

    expect(rows.map((r) => r.invoiceId)).toEqual(["100"]);

    const invoicesCall = apiSpy.mock.calls.find((c) => c[0] === "/invoices");
    expect(invoicesCall).toBeDefined();
    const query = invoicesCall![3] as Record<string, unknown>;
    // include= drives BoondManager to embed the company in `included[]`
    expect(query["include"]).toBe("company,order,project");
    // unpaid state IDs derived from the real dictionary: exclude 0 (Création),
    // 3 (Payée), 8 (Avoiré), 10 (ProForma), 15 (Payée groupe). Everything
    // else is "still owing".
    const sent = query["states"] as number[];
    expect(sent.sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("resolves company names via JSON:API included[]", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoice("200", { expectedPaymentDate: "2026-04-01", turnoverExcludingTax: 1000 }, "20"),
          invoice("201", { expectedPaymentDate: "2026-03-01", turnoverExcludingTax: 2000 }, "21"),
        ],
        included: [company("20", "ACME Industries"), company("21", "Globex Corp")],
      };
    });

    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    const byId = new Map(rows.map((r) => [r.invoiceId, r]));
    expect(byId.get("200")?.companyName).toBe("ACME Industries");
    expect(byId.get("201")?.companyName).toBe("Globex Corp");
  });

  it("resolves amounts from turnoverExcludingTax/turnoverIncludingTax fields", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoice(
            "300",
            {
              expectedPaymentDate: "2026-04-01",
              turnoverExcludingTax: 12345.67,
              turnoverIncludingTax: 14814.8,
            },
            "30"
          ),
        ],
      };
    });
    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    expect(rows[0].amountExcludingTax).toBeCloseTo(12345.67);
    expect(rows[0].amountIncludingTax).toBeCloseTo(14814.8);
  });

  it("excludes Avoiré (id 8) and ProForma (id 10) from the states query", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return { data: [] };
    });
    await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 1 });
    const query = apiSpy.mock.calls.find((c) => c[0] === "/invoices")![3] as Record<string, unknown>;
    const sent = query["states"] as number[];
    expect(sent).not.toContain(8);
    expect(sent).not.toContain(10);
    expect(sent).not.toContain(3);
    expect(sent).not.toContain(15);
  });

  it("applies amount range filters and reports diagnostic keys when no rows are returned", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          // Below the amount floor — dropped
          invoice("400", { expectedPaymentDate: "2026-04-01", turnoverExcludingTax: 100 }, "40"),
        ],
      };
    });
    const result = await fetchOverdueInvoices({
      asOfDate: "2026-05-01",
      amountMinExcludingTax: 1000,
      pageSize: 500,
      maxPages: 5,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.firstInvoiceKeys).toEqual({
      attributes: [
        "reference",
        "expectedPaymentDate",
        "dueDate",
        "turnoverExcludingTax",
        "turnoverIncludingTax",
        "state",
      ],
      relationships: ["company"],
    });
  });

  it("paginates until a partial page is returned", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path, _method, _body, query) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      calls.push((query ?? {}) as Record<string, unknown>);
      const page = Number((query as Record<string, unknown>)["page"] ?? 1);
      if (page === 1) {
        return {
          data: [
            invoice("501", { expectedPaymentDate: "2026-01-01", turnoverExcludingTax: 100 }, "50"),
            invoice("502", { expectedPaymentDate: "2026-01-02", turnoverExcludingTax: 200 }, "50"),
          ],
        };
      }
      return { data: [invoice("503", { expectedPaymentDate: "2026-01-03", turnoverExcludingTax: 300 }, "50")] };
    });
    const { rows, scanned } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 2, maxPages: 5 });
    expect(scanned).toBe(3);
    expect(rows).toHaveLength(3);
    expect(calls.map((c) => c["page"])).toEqual([1, 2]);
  });

  it("rejects an asOfDate that does not parse", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue(INVOICE_STATE_DICT);
    await expect(fetchOverdueInvoices({ asOfDate: "not-a-date", pageSize: 500, maxPages: 5 })).rejects.toThrow(
      /asOfDate invalide/
    );
  });
});
