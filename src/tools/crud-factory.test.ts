import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildJsonApiBody,
  buildTabHandler,
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
} from "./crud-factory.js";
import * as boondClient from "../services/boond-client.js";
import * as dictionaryService from "../services/dictionary.js";
import { z } from "zod";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

const OPTS = {
  entityName: "test-entity",
  entityNamePlural: "test-entities",
  apiPath: "/tests",
  prefix: "boond_tests",
};

describe("buildJsonApiBody", () => {
  it("should build correct JSON:API structure", () => {
    const result = buildJsonApiBody("candidate", { firstName: "Jean", lastName: "Dupont" });
    expect(result).toEqual({
      data: {
        type: "candidate",
        attributes: { firstName: "Jean", lastName: "Dupont" },
      },
    });
  });

  it("should include id when provided", () => {
    const result = buildJsonApiBody("candidate", { firstName: "Jean" }, "123") as {
      data: { id: string; type: string; attributes: Record<string, unknown> };
    };
    expect(result.data.id).toBe("123");
  });

  it("should filter out undefined values", () => {
    const result = buildJsonApiBody("candidate", {
      firstName: "Jean",
      lastName: undefined,
      city: "Paris",
    }) as { data: { attributes: Record<string, unknown> } };
    expect(result.data.attributes).toEqual({ firstName: "Jean", city: "Paris" });
    expect(result.data.attributes).not.toHaveProperty("lastName");
  });

  it("should handle empty attributes", () => {
    const result = buildJsonApiBody("candidate", {}) as {
      data: { attributes: Record<string, unknown> };
    };
    expect(result.data.attributes).toEqual({});
  });
});

describe("registerSearchTool", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register a tool with correct name", () => {
    registerSearchTool(server, OPTS);
    expect(server.registerTool).toHaveBeenCalledOnce();
    const [name] = vi.mocked(server.registerTool).mock.calls[0];
    expect(name).toBe("boond_tests_search");
  });

  it("should register with readOnly annotations", () => {
    registerSearchTool(server, OPTS);
    const [, metadata] = vi.mocked(server.registerTool).mock.calls[0];
    expect(metadata.annotations?.readOnlyHint).toBe(true);
    expect(metadata.annotations?.destructiveHint).toBe(false);
  });
});

describe("registerGetTool", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register a tool with correct name", () => {
    registerGetTool(server, OPTS);
    const [name] = vi.mocked(server.registerTool).mock.calls[0];
    expect(name).toBe("boond_tests_get");
  });

  it("should register with readOnly annotations", () => {
    registerGetTool(server, OPTS);
    const [, metadata] = vi.mocked(server.registerTool).mock.calls[0];
    expect(metadata.annotations?.readOnlyHint).toBe(true);
  });
});

describe("registerCreateTool", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register a tool with correct name", () => {
    const schema = z.object({ name: z.string() });
    registerCreateTool(server, OPTS, schema, (p) => buildJsonApiBody("test", p));
    const [name] = vi.mocked(server.registerTool).mock.calls[0];
    expect(name).toBe("boond_tests_create");
  });

  it("should register with non-readOnly, non-destructive annotations", () => {
    const schema = z.object({ name: z.string() });
    registerCreateTool(server, OPTS, schema, (p) => buildJsonApiBody("test", p));
    const [, metadata] = vi.mocked(server.registerTool).mock.calls[0];
    expect(metadata.annotations?.readOnlyHint).toBe(false);
    expect(metadata.annotations?.destructiveHint).toBe(false);
  });
});

describe("registerUpdateTool", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register a tool with correct name", () => {
    const schema = z.object({ id: z.string(), name: z.string().optional() });
    registerUpdateTool(server, OPTS, schema, (p) => buildJsonApiBody("test", p));
    const [name] = vi.mocked(server.registerTool).mock.calls[0];
    expect(name).toBe("boond_tests_update");
  });

  it("should register as idempotent", () => {
    const schema = z.object({ id: z.string() });
    registerUpdateTool(server, OPTS, schema, (p) => buildJsonApiBody("test", p));
    const [, metadata] = vi.mocked(server.registerTool).mock.calls[0];
    expect(metadata.annotations?.idempotentHint).toBe(true);
  });
});

describe("registerDeleteTool", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register a tool with correct name", () => {
    registerDeleteTool(server, OPTS);
    const [name] = vi.mocked(server.registerTool).mock.calls[0];
    expect(name).toBe("boond_tests_delete");
  });

  it("should register with destructive annotation", () => {
    registerDeleteTool(server, OPTS);
    const [, metadata] = vi.mocked(server.registerTool).mock.calls[0];
    expect(metadata.annotations?.destructiveHint).toBe(true);
  });
});

// ---- Transverse tab-pagination fix (1.10.3) -------------------------------

describe("buildTabHandler — pagination + auto formatter on every collection tab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  // Note : `fetchTabResponse` calls the module-internal `apiRequest`, which a
  // spy on the export can't intercept. We mock `fetchTabResponse` itself, and
  // assert on the path it receives. Pagination + maxResults are covered by
  // dedicated tests in boond-client.test.ts.

  it("calls fetchTabResponse with the entity tab path (no more bare apiRequest+formatDetailResponse)", async () => {
    const tabSpy = vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: [],
      meta: { totals: { rows: 0 } },
    } as never);
    await buildTabHandler("/resources", "ressource", "projects")({ id: "20" });
    expect(tabSpy).toHaveBeenCalledWith("/resources/20/projects");
  });

  it("renders ALL collection rows (not just data[0]) for a multi-row tab", async () => {
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: Array.from({ length: 6 }, (_, i) => ({
        id: String(100 + i),
        type: "project",
        attributes: { reference: `MISSION-${i + 1}`, name: `Client #${i + 1}` },
      })),
      meta: { totals: { rows: 6 } },
    } as never);
    const out = await buildTabHandler("/resources", "ressource", "projects")({ id: "20" });
    const text = out.content[0].text;
    expect(text).toContain("Total: 6 ressource(s)");
    expect(text).toContain("#100");
    // Last row : pre-1.10.3 this row was DROPPED by formatDetailResponse(data[0]).
    // The fix is that the full list now renders.
    expect(text).toContain("#105");
  });

  it("uses the enriched action formatter when tabName === 'actions'", async () => {
    vi.spyOn(dictionaryService, "getDictionary").mockResolvedValue({
      payload: { data: { setting: { action: {} } } },
      fetchedAt: Date.now(),
      language: "fr",
    } as never);
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: [
        {
          id: "1",
          type: "action",
          attributes: { typeOf: 13, startDate: "2026-06-01", text: "<p>Note</p>" },
        },
      ],
      meta: { totals: { rows: 1 } },
    } as never);
    const out = await buildTabHandler("/companies", "société", "actions")({ id: "100" });
    const text = out.content[0].text;
    // Enriched formatter : [action #N] | date | typeLabel | ... and HTML stripped.
    expect(text).toContain("[action #1]");
    expect(text).toContain("2026-06-01");
    expect(text).not.toContain("<p>");
  });

  it("falls back to detail view for single-entity tabs (information, technical-data...)", async () => {
    vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: { id: "20", type: "resource", attributes: { firstName: "Damien", lastName: "BLAISE" } },
    } as never);
    const out = await buildTabHandler("/resources", "ressource", "information")({ id: "20" });
    const text = out.content[0].text;
    expect(text).toContain('"firstName": "Damien"');
  });
});
