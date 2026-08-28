import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCompanyTools } from "./companies.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerCompanyTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register CRUD tools + 9 tab tools = 14 total", () => {
    registerCompanyTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(14);
  });

  it("should register all CRUD tools", () => {
    registerCompanyTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_companies_search");
    expect(names).toContain("boond_companies_get");
    expect(names).toContain("boond_companies_create");
    expect(names).toContain("boond_companies_update");
    expect(names).toContain("boond_companies_delete");
  });

  it("should register all 9 tab tools", () => {
    registerCompanyTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_companies_information");
    expect(names).toContain("boond_companies_contacts");
    expect(names).toContain("boond_companies_actions");
    expect(names).toContain("boond_companies_opportunities");
    expect(names).toContain("boond_companies_projects");
    expect(names).toContain("boond_companies_orders");
    expect(names).toContain("boond_companies_invoices");
    expect(names).toContain("boond_companies_purchases");
    expect(names).toContain("boond_companies_provider_invoices");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerCompanyTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_companies_information",
            "boond_companies_contacts",
            "boond_companies_actions",
            "boond_companies_opportunities",
            "boond_companies_projects",
            "boond_companies_orders",
            "boond_companies_invoices",
            "boond_companies_purchases",
            "boond_companies_provider_invoices",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(9);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });

  it("update sends mainManager/agency/pole as JSON:API relationships (not attributes)", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "10" } } as never);
    registerCompanyTools(server);
    const handler = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_companies_update")![2] as (
      p: Record<string, unknown>
    ) => Promise<{ isError?: boolean }>;
    await handler({ id: "10", name: "ACME", mainManager: "42", agency: "5", pole: "3" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    expect(put![0]).toBe("/companies/10/information"); // routed via /information sub-resource (base PATCH = 405)
    const body = put![2] as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } };
    expect(body.data.relationships).toEqual({
      mainManager: { data: { id: "42", type: "resource" } },
      agency: { data: { id: "5", type: "agency" } },
      pole: { data: { id: "3", type: "pole" } },
    });
    // org fields must NOT leak into attributes
    expect(body.data.attributes).not.toHaveProperty("mainManager");
    expect(body.data.attributes).toMatchObject({ name: "ACME" });
  });
});
