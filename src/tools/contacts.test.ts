import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContactTools } from "./contacts.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerContactTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register CRUD tools + 6 tab tools = 11 total", () => {
    registerContactTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(11);
  });

  it("should register all CRUD tools", () => {
    registerContactTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_contacts_search");
    expect(names).toContain("boond_contacts_get");
    expect(names).toContain("boond_contacts_create");
    expect(names).toContain("boond_contacts_update");
    expect(names).toContain("boond_contacts_delete");
  });

  it("should register all 6 tab tools", () => {
    registerContactTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_contacts_information");
    expect(names).toContain("boond_contacts_actions");
    expect(names).toContain("boond_contacts_opportunities");
    expect(names).toContain("boond_contacts_projects");
    expect(names).toContain("boond_contacts_orders");
    expect(names).toContain("boond_contacts_invoices");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerContactTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_contacts_information",
            "boond_contacts_actions",
            "boond_contacts_opportunities",
            "boond_contacts_projects",
            "boond_contacts_orders",
            "boond_contacts_invoices",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(6);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });
});

describe("contact « Fonction » field (API attribute `function`)", () => {
  beforeEach(() => vi.restoreAllMocks());

  function getHandler(name: string) {
    const server = createMockServer();
    registerContactTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
    return call![2] as (p: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  }

  it("update: sends `function` via PUT /contacts/{id}/information (not a bogus `title`)", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "19692" } } as never);
    const handler = getHandler("boond_contacts_update");
    await handler({ id: "19692", function: "Directeur Technique" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    expect(put![0]).toBe("/contacts/19692/information");
    const attrs = (put![2] as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(attrs.function).toBe("Directeur Technique");
    expect(attrs).not.toHaveProperty("title");
  });

  it("update: legacy `title` is mapped to `function`", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "19692" } } as never);
    const handler = getHandler("boond_contacts_update");
    await handler({ id: "19692", title: "CTO" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    const attrs = (put![2] as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(attrs.function).toBe("CTO");
    expect(attrs).not.toHaveProperty("title");
  });

  it("update: explicit `function` wins over legacy `title`", async () => {
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: { id: "1" } } as never);
    const handler = getHandler("boond_contacts_update");
    await handler({ id: "1", function: "CTO", title: "ignored" });
    const put = api.mock.calls.find((c) => c[1] === "PUT");
    const attrs = (put![2] as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(attrs.function).toBe("CTO");
    expect(attrs).not.toHaveProperty("title");
  });

  it("create: sends `function` in the POST body", async () => {
    const api = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "500", type: "contact", attributes: {} } } as never);
    const handler = getHandler("boond_contacts_create");
    await handler({ firstName: "Ada", lastName: "Lovelace", function: "Analyste", companyId: "12" });
    const post = api.mock.calls.find((c) => c[1] === "POST");
    const data = (post![2] as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } })
      .data;
    expect(data.attributes.function).toBe("Analyste");
    expect(data.attributes).not.toHaveProperty("title");
    expect(data.relationships).toEqual({ company: { data: { id: "12", type: "company" } } });
  });
});
