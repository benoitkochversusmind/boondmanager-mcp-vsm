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
    await handler({ id: "77", name: "Besoin X", mainManager: "42", agency: "5", pole: "3" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    expect(put![0]).toBe("/opportunities/77/information"); // base PATCH = 405 → routed via /information
    const body = put![2] as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } };
    expect(body.data.relationships).toEqual({
      mainManager: { data: { id: "42", type: "resource" } },
      agency: { data: { id: "5", type: "agency" } },
      pole: { data: { id: "3", type: "pole" } },
    });
    expect(body.data.attributes).not.toHaveProperty("pole");
  });
});
