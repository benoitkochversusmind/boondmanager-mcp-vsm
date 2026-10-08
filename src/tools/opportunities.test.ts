import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerOpportunityTools } from "./opportunities.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerOpportunityTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register CRUD tools + 5 tab tools = 10 total", () => {
    registerOpportunityTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(10);
  });

  it("should register all CRUD tools", () => {
    registerOpportunityTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_opportunities_search");
    expect(names).toContain("boond_opportunities_get");
    expect(names).toContain("boond_opportunities_create");
    expect(names).toContain("boond_opportunities_update");
    expect(names).toContain("boond_opportunities_delete");
  });

  it("should register all 5 tab tools", () => {
    registerOpportunityTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_opportunities_information");
    expect(names).toContain("boond_opportunities_actions");
    expect(names).toContain("boond_opportunities_positionings");
    expect(names).toContain("boond_opportunities_projects");
    expect(names).toContain("boond_opportunities_simulation");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerOpportunityTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_opportunities_information",
            "boond_opportunities_actions",
            "boond_opportunities_positionings",
            "boond_opportunities_projects",
            "boond_opportunities_simulation",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(5);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });

  it("update sends mainManager/agency/pole as relationships via PUT /opportunities/{id}/information", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "77" } } as never);
    registerOpportunityTools(server);
    const handler = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_opportunities_update")![2] as (
      p: Record<string, unknown>
    ) => Promise<unknown>;
    await handler({ id: "77", title: "Besoin X", mainManager: "42", agency: "5", pole: "3" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    expect(put![0]).toBe("/opportunities/77/information"); // base PATCH = 405 → routed via /information
    const body = put![2] as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } };
    expect(body.data.relationships).toEqual({
      mainManager: { data: { id: "42", type: "resource" } },
      agency: { data: { id: "5", type: "agency" } },
      pole: { data: { id: "3", type: "pole" } },
    });
    // Title flows through as the API attribute `title` (not `name`).
    expect(body.data.attributes).toMatchObject({ title: "Besoin X" });
    expect(body.data.attributes).not.toHaveProperty("name");
    expect(body.data.attributes).not.toHaveProperty("pole");
  });

  function createHandler() {
    registerOpportunityTools(server);
    return vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_opportunities_create")![2] as (
      p: Record<string, unknown>
    ) => Promise<unknown>;
  }

  it("create sends title + description as the API attributes `title`/`description` (not name/note)", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "88" } } as never);
    const handler = createHandler();
    await handler({ title: "Nouveau besoin", description: "Contexte du besoin", companyId: "12", contactId: "34" });
    const post = api.mock.calls.find((c) => c[1] === "POST");
    expect(post![0]).toBe("/opportunities");
    const body = post![2] as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } };
    expect(body.data.attributes).toMatchObject({ title: "Nouveau besoin", description: "Contexte du besoin" });
    expect(body.data.attributes).not.toHaveProperty("name");
    expect(body.data.attributes).not.toHaveProperty("note");
    // company + contact provided together → both relationships sent.
    expect(body.data.relationships).toEqual({
      company: { data: { id: "12", type: "company" } },
      contact: { data: { id: "34", type: "contact" } },
    });
  });

  it("create rejects a half-filled company/contact link before calling the API (error 1029 guard)", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "88" } } as never);
    const handler = createHandler();
    api.mockClear(); // isolate from other tests sharing the module-level spy
    await expect(handler({ title: "X", companyId: "12" })).rejects.toThrow(/ensemble/);
    await expect(handler({ title: "X", contactId: "34" })).rejects.toThrow(/ensemble/);
    expect(api).not.toHaveBeenCalled();
  });
});
