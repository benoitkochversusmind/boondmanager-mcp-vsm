import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExpenseTools, formatExpensesReportDetail, formatExpensesReportsList } from "./expenses.js";
import type { JsonApiResponse } from "../types.js";

// Real /expenses-reports/{id} payload shape (captured live, id 7645).
const REPORT_7645: JsonApiResponse = {
  data: {
    id: "7645",
    type: "expensesreport",
    attributes: {
      term: "2023-03",
      informationComments: "",
      closed: true,
      state: "validated",
      paid: true,
      advance: 0,
      actualExpenses: [
        {
          id: "13471",
          startDate: "2023-03-23",
          number: 0,
          title: "",
          amountIncludingTax: 31.25,
          tax: 0,
          reinvoiced: false,
          isKilometricExpense: false,
          activityType: "production",
          expenseType: { reference: 4, taxRate: 0, name: "Train" },
          project: { id: "1313", reference: "Inter Projet" },
        },
        {
          id: "13472",
          startDate: "2023-03-24",
          number: 100,
          amountIncludingTax: 0,
          tax: 0,
          reinvoiced: true,
          isKilometricExpense: true,
          activityType: "production",
          expenseType: { name: "Indemnités kilométriques" },
          project: { id: "1313", reference: "Inter Projet" },
        },
      ],
      fixedExpenses: [],
      projectsExpenses: [],
      ratePerKilometerType: { reference: 5, amount: 0.401, name: "7CV et plus" },
    },
    relationships: {
      resource: { data: { id: "9364", type: "resource" } },
      agency: { data: { id: "1", type: "agency" } },
    },
  },
} as unknown as JsonApiResponse;

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerExpenseTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register 5 expense tools", () => {
    registerExpenseTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("should register all expected tool names", () => {
    registerExpenseTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_expenses_search");
    expect(names).toContain("boond_expenses_get");
    expect(names).toContain("boond_expenses_create");
    expect(names).toContain("boond_expenses_update");
    expect(names).toContain("boond_expenses_delete");
  });

  it("should register search and get as readOnly", () => {
    registerExpenseTools(server);
    const readOnlyCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) => typeof c[0] === "string" && ["boond_expenses_search", "boond_expenses_get"].includes(c[0] as string)
      );
    for (const call of readOnlyCalls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("should register delete as destructive", () => {
    registerExpenseTools(server);
    const deleteCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_expenses_delete");
    expect(deleteCall?.[1].annotations?.destructiveHint).toBe(true);
  });
});

describe("formatExpensesReportDetail", () => {
  it("computes the total TTC/TVA/HT by summing the line arrays (kilometric lines included)", () => {
    const text = formatExpensesReportDetail(REPORT_7645);
    // 31.25 (Train) + 100 km × 0.401 = 40.10 → 71.35 TTC, 0 TVA
    expect(text).toContain("TOTAL: 71.35 € TTC (dont 0.00 € TVA · 71.35 € HT) — 2 ligne(s)");
  });

  it("renders header, term, state label, resource, and paid flag", () => {
    const text = formatExpensesReportDetail(REPORT_7645);
    expect(text).toContain("Note de frais #7645 — Période 2023-03");
    expect(text).toContain("Ressource: #9364");
    expect(text).toContain("Agence: #1");
    expect(text).toContain("État: Validée");
    expect(text).toContain("Payée: oui");
    expect(text).toContain("Barème kilométrique: 7CV et plus (0.401 €/km)");
  });

  it("renders each expense line with date, type, amount and project", () => {
    const text = formatExpensesReportDetail(REPORT_7645);
    expect(text).toContain("2023-03-23 · Train · 31.25 € TTC");
    expect(text).toContain("Projet Inter Projet (#1313)");
    // Kilometric line shows the computation.
    expect(text).toContain("100 km × 0.401 = 40.10 € TTC");
    expect(text).toContain("refacturable");
  });

  it("shows a 0.00 total for a report whose line arrays are present but empty", () => {
    const empty: JsonApiResponse = {
      data: {
        id: "1",
        type: "expensesreport",
        attributes: { term: "2026-01", state: "saved", actualExpenses: [], fixedExpenses: [], projectsExpenses: [] },
      },
    } as unknown as JsonApiResponse;
    const text = formatExpensesReportDetail(empty);
    expect(text).toContain("TOTAL: 0.00 € TTC (dont 0.00 € TVA · 0.00 € HT) — 0 ligne(s)");
  });

  it("does not invent a total when the payload carries no line arrays at all", () => {
    const light: JsonApiResponse = {
      data: { id: "2", type: "expensesreport", attributes: { term: "2026-02", state: "saved" } },
    } as unknown as JsonApiResponse;
    const text = formatExpensesReportDetail(light);
    expect(text).toContain("aucune ligne de frais");
    expect(text).not.toContain("€ TTC (dont");
  });
});

describe("formatExpensesReportsList", () => {
  it("labels the header as notes de frais (not ressources) and surfaces state/term/paid", () => {
    const list: JsonApiResponse = {
      data: [REPORT_7645.data],
      meta: { totals: { rows: 64 } },
    } as unknown as JsonApiResponse;
    const text = formatExpensesReportsList(list);
    expect(text.startsWith("Total: 64 note(s) de frais")).toBe(true);
    expect(text).toContain("[note de frais #7645]");
    expect(text).toContain("État: Validée");
    expect(text).toContain("Période 2023-03");
    expect(text).toContain("Payée: oui");
    // Line arrays are present in this fixture → total is computed.
    expect(text).toContain("Total 71.35 € TTC (2 ligne(s))");
    expect(text).toContain("Ressource #9364");
  });

  it("omits the total when the list items carry no expense lines", () => {
    const light: JsonApiResponse = {
      data: [{ id: "12280", type: "expensesreport", attributes: { state: "savedAndNoValidation" } }],
      meta: { totals: { rows: 1 } },
    } as unknown as JsonApiResponse;
    const text = formatExpensesReportsList(light);
    expect(text).toContain("[note de frais #12280] · État: Enregistrée (sans validation)");
    expect(text).not.toContain("€ TTC");
  });

  it("returns a friendly message on an empty list", () => {
    const empty = { data: [] } as unknown as JsonApiResponse;
    expect(formatExpensesReportsList(empty)).toBe("Aucune note de frais trouvée.");
  });
});
