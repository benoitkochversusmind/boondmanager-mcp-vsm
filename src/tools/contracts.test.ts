import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContractTools } from "./contracts.js";
import * as dictionary from "../services/dictionary.js";
import * as boondClient from "../services/boond-client.js";

const DICT_PAYLOAD = {
  data: {
    setting: {
      typeOf: {
        contract: [
          { id: 0, value: "CDI", isEnabled: true },
          { id: 3, value: "Freelance", isEnabled: true },
        ],
      },
    },
  },
};

function mockDictionary() {
  vi.spyOn(dictionary, "getDictionary").mockResolvedValue({
    payload: DICT_PAYLOAD,
    fetchedAt: 0,
    language: "fr",
  } as never);
}

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function handlerFor(
  name: string
): (p: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }> {
  const server = createMockServer();
  registerContractTools(server);
  return vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name)![2] as never;
}

describe("registerContractTools", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers get, create and update", () => {
    const server = createMockServer();
    registerContractTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toEqual(["boond_contracts_get", "boond_contracts_create", "boond_contracts_update"]);
  });

  it("get is read-only, create/update are writes", () => {
    const server = createMockServer();
    registerContractTools(server);
    const calls = vi.mocked(server.registerTool).mock.calls;
    const ann = (n: string) => calls.find((c) => c[0] === n)![1].annotations;
    expect(ann("boond_contracts_get")?.readOnlyHint).toBe(true);
    expect(ann("boond_contracts_create")?.readOnlyHint).toBe(false);
    expect(ann("boond_contracts_update")?.readOnlyHint).toBe(false);
  });
});

describe("boond_contracts_create", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("links the resource via dependsOn (not relationships.resource) and resolves typeOf", async () => {
    mockDictionary();
    const api = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "1766", type: "contract", attributes: {} } } as never);

    await handlerFor("boond_contracts_create")({
      resourceId: "113",
      typeOf: "CDI",
      startDate: "2026-01-01",
      monthlySalary: 3500,
    });

    const [path, method, body] = api.mock.calls[0];
    expect(path).toBe("/contracts");
    expect(method).toBe("POST");
    const data = (body as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } })
      .data;
    expect(data.relationships).toEqual({ dependsOn: { data: { id: "113", type: "resource" } } });
    expect(data.relationships).not.toHaveProperty("resource");
    expect(data.attributes["typeOf"]).toBe(0); // CDI → 0
    expect(data.attributes["monthlySalary"]).toBe(3500);
    expect(data.attributes).not.toHaveProperty("resourceId");
  });

  it("rejects an unknown contract type without calling the API", async () => {
    mockDictionary();
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    const res = await handlerFor("boond_contracts_create")({ resourceId: "113", typeOf: "CDI-bis" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/CDI-bis/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("boond_contracts_update", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("PUTs /contracts/{id} with only the provided fields, resolving typeOf", async () => {
    mockDictionary();
    const api = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "1766", type: "contract", attributes: {} } } as never);

    await handlerFor("boond_contracts_update")({ id: "1766", monthlySalary: 3600, typeOf: "Freelance" });

    const [path, method, body] = api.mock.calls[0];
    expect(path).toBe("/contracts/1766");
    expect(method).toBe("PUT");
    const data = (body as { data: { id: string; attributes: Record<string, unknown> } }).data;
    expect(data.id).toBe("1766");
    expect(data.attributes["monthlySalary"]).toBe(3600);
    expect(data.attributes["typeOf"]).toBe(3); // Freelance → 3
  });

  it("rejects an empty update (no API call)", async () => {
    mockDictionary();
    const api = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    const res = await handlerFor("boond_contracts_update")({ id: "1766" });
    expect(res.isError).toBe(true);
    expect(api).not.toHaveBeenCalled();
  });
});
