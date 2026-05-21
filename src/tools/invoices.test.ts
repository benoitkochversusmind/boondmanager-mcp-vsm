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

/**
 * Generic invoice fixture — accepts an explicit direct company relationship
 * (used by legacy/defensive tests). For the canonical /invoices payload shape
 * where the company is reached via the order chain, use `invoiceWithOrder`.
 */
function invoice(
  id: string,
  attrs: {
    expectedPaymentDate?: string;
    dueDate?: string;
    turnoverInvoicedExcludingTax?: number;
    turnoverInvoicedIncludingTax?: number;
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
      turnoverInvoicedExcludingTax: attrs.turnoverInvoicedExcludingTax,
      turnoverInvoicedIncludingTax: attrs.turnoverInvoicedIncludingTax,
      turnoverExcludingTax: attrs.turnoverExcludingTax,
      turnoverIncludingTax: attrs.turnoverIncludingTax,
      state: attrs.state ?? 5,
    },
    relationships: companyId ? { company: { data: { id: companyId, type: "company" } } } : undefined,
  };
}

/**
 * Mirrors the canonical /invoices payload: the invoice carries an `order`
 * relationship, and the company is reachable via that order. Verified against
 * the live VSM instance on 2026-05-21.
 */
function invoiceWithOrder(
  id: string,
  attrs: {
    expectedPaymentDate?: string;
    turnoverInvoicedExcludingTax?: number;
    turnoverInvoicedIncludingTax?: number;
    reference?: string;
    state?: number;
  },
  orderId: string
) {
  return {
    id,
    type: "invoice",
    attributes: {
      reference: attrs.reference ?? `INV-${id}`,
      expectedPaymentDate: attrs.expectedPaymentDate,
      turnoverInvoicedExcludingTax: attrs.turnoverInvoicedExcludingTax,
      turnoverInvoicedIncludingTax: attrs.turnoverInvoicedIncludingTax,
      state: attrs.state ?? 5,
    },
    relationships: { order: { data: { id: orderId, type: "order" } } },
  };
}

function order(id: string, companyId: string) {
  return {
    id,
    type: "order",
    attributes: {},
    relationships: { company: { data: { id: companyId, type: "company" } } },
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

  it("boond_invoices_search uses nested include for order.company", async () => {
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
    expect(query["include"]).toBe("order.company,order,company,project");
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
          invoiceWithOrder(
            "100",
            { expectedPaymentDate: "2026-04-01", turnoverInvoicedExcludingTax: 5000, state: 5 },
            "10"
          ),
          // Has dueDate but no expectedPaymentDate — DROPPED (strict mode, no fallback)
          invoice("101", { dueDate: "2026-03-01", turnoverInvoicedExcludingTax: 8000, state: 5 }, "11"),
          // expectedPaymentDate in the future — dropped
          invoiceWithOrder(
            "102",
            { expectedPaymentDate: "2026-09-01", turnoverInvoicedExcludingTax: 3000, state: 5 },
            "12"
          ),
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
    // Nested include: ask BoondManager to embed order + its linked company
    expect(query["include"]).toBe("order.company,order,company,project");
    // unpaid state IDs derived from the real dictionary: exclude 0 (Création),
    // 3 (Payée), 8 (Avoiré), 10 (ProForma), 15 (Payée groupe). Everything
    // else is "still owing".
    const sent = query["states"] as number[];
    expect(sent.sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7]);
  });

  it("resolves company via invoice → order → company chain (the canonical /invoices shape)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoiceWithOrder("9478", { expectedPaymentDate: "2026-04-30", turnoverInvoicedExcludingTax: 5000 }, "2325"),
          invoiceWithOrder("9479", { expectedPaymentDate: "2026-03-15", turnoverInvoicedExcludingTax: 8000 }, "2326"),
        ],
        included: [
          order("2325", "501"),
          order("2326", "502"),
          company("501", "ACME Industries"),
          company("502", "Globex Corp"),
        ],
      };
    });

    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-21", pageSize: 500, maxPages: 5 });
    const byId = new Map(rows.map((r) => [r.invoiceId, r]));
    expect(byId.get("9478")?.companyId).toBe("501");
    expect(byId.get("9478")?.companyName).toBe("ACME Industries");
    expect(byId.get("9479")?.companyId).toBe("502");
    expect(byId.get("9479")?.companyName).toBe("Globex Corp");
  });

  it("still resolves via direct company relationship when present (other endpoints)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [invoice("200", { expectedPaymentDate: "2026-04-01", turnoverInvoicedExcludingTax: 1000 }, "20")],
        included: [company("20", "Direct Inc")],
      };
    });
    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    expect(rows[0].companyName).toBe("Direct Inc");
  });

  it("returns companyId without name when order is embedded but its company isn't", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoiceWithOrder("210", { expectedPaymentDate: "2026-04-01", turnoverInvoicedExcludingTax: 1000 }, "999"),
        ],
        // Order is embedded but the company resource itself is missing —
        // we still surface the company ID for display purposes.
        included: [order("999", "777")],
      };
    });
    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    expect(rows[0].companyId).toBe("777");
    expect(rows[0].companyName).toBeNull();
  });

  it("resolves amounts from turnoverInvoicedExcludingTax/IncludingTax (canonical /invoices fields)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoiceWithOrder(
            "300",
            {
              expectedPaymentDate: "2026-04-01",
              turnoverInvoicedExcludingTax: 12345.67,
              turnoverInvoicedIncludingTax: 14814.8,
            },
            "30"
          ),
        ],
        included: [order("30", "60"), company("60", "Foo")],
      };
    });
    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    expect(rows[0].amountExcludingTax).toBeCloseTo(12345.67);
    expect(rows[0].amountIncludingTax).toBeCloseTo(14814.8);
  });

  it("falls back to legacy turnoverExcludingTax when turnoverInvoiced* is absent", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          invoice(
            "310",
            {
              expectedPaymentDate: "2026-04-01",
              turnoverExcludingTax: 9999.99,
              turnoverIncludingTax: 11999.99,
            },
            "31"
          ),
        ],
      };
    });
    const { rows } = await fetchOverdueInvoices({ asOfDate: "2026-05-01", pageSize: 500, maxPages: 5 });
    expect(rows[0].amountExcludingTax).toBeCloseTo(9999.99);
    expect(rows[0].amountIncludingTax).toBeCloseTo(11999.99);
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

  it("applies amount range filters", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return INVOICE_STATE_DICT;
      return {
        data: [
          // Below the amount floor — dropped
          invoiceWithOrder("400", { expectedPaymentDate: "2026-04-01", turnoverInvoicedExcludingTax: 100 }, "40"),
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
    expect(result.firstInvoiceKeys).not.toBeNull();
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
            invoiceWithOrder("501", { expectedPaymentDate: "2026-01-01", turnoverInvoicedExcludingTax: 100 }, "50"),
            invoiceWithOrder("502", { expectedPaymentDate: "2026-01-02", turnoverInvoicedExcludingTax: 200 }, "50"),
          ],
        };
      }
      return {
        data: [invoiceWithOrder("503", { expectedPaymentDate: "2026-01-03", turnoverInvoicedExcludingTax: 300 }, "50")],
      };
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
