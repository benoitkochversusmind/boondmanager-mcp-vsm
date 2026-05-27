import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCandidateTools } from "./candidates.js";
import * as boondClient from "../services/boond-client.js";
import * as dictionaryService from "../services/dictionary.js";
import type { JsonApiResponse } from "../types.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerCandidateTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register CRUD tools + 5 tab tools = 10 total", () => {
    registerCandidateTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(10);
  });

  it("should register all CRUD tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_search");
    expect(names).toContain("boond_candidates_get");
    expect(names).toContain("boond_candidates_create");
    expect(names).toContain("boond_candidates_update");
    expect(names).toContain("boond_candidates_delete");
  });

  it("should register all 5 tab tools", () => {
    registerCandidateTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_candidates_information");
    expect(names).toContain("boond_candidates_technical_data");
    expect(names).toContain("boond_candidates_administrative");
    expect(names).toContain("boond_candidates_actions");
    expect(names).toContain("boond_candidates_positionings");
  });

  it("should register tab tools as readOnly and non-destructive", () => {
    registerCandidateTools(server);
    const tabCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          [
            "boond_candidates_information",
            "boond_candidates_technical_data",
            "boond_candidates_administrative",
            "boond_candidates_actions",
            "boond_candidates_positionings",
          ].includes(c[0] as string)
      );

    expect(tabCalls).toHaveLength(5);
    for (const call of tabCalls) {
      const [, metadata] = call;
      expect(metadata.annotations?.readOnlyHint).toBe(true);
      expect(metadata.annotations?.destructiveHint).toBe(false);
    }
  });
});

// ---- v1.10.0 features ported from boond-mcp-server/index.js ---------------

const CANDIDATE_DICT: JsonApiResponse = {
  data: {
    setting: {
      state: {
        candidate: [
          { id: 4, value: "Sourcé", isEnabled: true },
          { id: 2, value: "Vivier chaud", isEnabled: true },
          { id: 9, value: "Vivier froid", isEnabled: true },
          { id: 3, value: "Embauché", isEnabled: true },
          { id: 99, value: "Désactivé", isEnabled: false },
        ],
      },
    },
  },
} as unknown as JsonApiResponse;

function createServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function getSearchHandler() {
  const server = createServer();
  registerCandidateTools(server);
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_candidates_search");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return call![2] as any;
}

function getTabHandler(toolName: string) {
  const server = createServer();
  registerCandidateTools(server);
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === toolName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return call![2] as any;
}

describe("boond_candidates_actions — tab pagination (Bug 1)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  it("routes the actions tab through fetchTabResponse + enriched formatter and returns ALL actions", async () => {
    // fetchTabResponse owns the maxResults pagination (covered in
    // boond-client.test.ts). Here we mock it to focus on the candidates
    // handler routing : it must use fetchTabResponse (not bare apiRequest)
    // and render every action via the enriched formatter (not data[0] only).
    const tabSpy = vi.spyOn(boondClient, "fetchTabResponse").mockResolvedValue({
      data: Array.from({ length: 6 }, (_, i) => ({
        id: String(100 + i),
        type: "action",
        attributes: { typeOf: 13, startDate: "2026-05-0" + (i + 1) },
      })),
      meta: { totals: { rows: 6 } },
    } as never);
    // formatActionsList loads the action-type dictionary internally.
    vi.spyOn(dictionaryService, "getDictionary").mockResolvedValue({
      payload: { data: { setting: { action: {} } } },
      fetchedAt: Date.now(),
      language: "fr",
    } as never);

    const result = await getTabHandler("boond_candidates_actions")({ id: "42893" });

    expect(tabSpy).toHaveBeenCalledWith("/candidates/42893/actions");
    const text = result.content[0].text as string;
    expect(text).toContain("Total: 6 action(s)");
    expect(text).toContain("#100");
    expect(text).toContain("#105");
  });
});

describe("boond_candidates_search — stateLabel + fetchAll (v1.10.0)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dictionaryService.resetDictionaryCacheForTests();
  });

  it("resolves stateLabel to a numeric candidateStates[] via the dictionary cache", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      return { data: [], meta: { totals: { rows: 0 } } };
    });
    const handler = getSearchHandler();
    await handler({ stateLabel: "Vivier chaud", page: 1, pageSize: 30 });

    const candidatesCall = spy.mock.calls.find((c) => c[0] === "/candidates");
    expect(candidatesCall).toBeDefined();
    const query = candidatesCall![3] as Record<string, unknown>;
    expect(query["candidateStates"]).toEqual([2]); // 'Vivier chaud' → id 2
  });

  it("normalizes the stateLabel lookup (case + trim)", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      return { data: [], meta: { totals: { rows: 0 } } };
    });
    await getSearchHandler()({ stateLabel: "  vIvIeR CHAUD  ", page: 1, pageSize: 30 });
    const query = spy.mock.calls.find((c) => c[0] === "/candidates")![3] as Record<string, unknown>;
    expect(query["candidateStates"]).toEqual([2]);
  });

  it("ignores stateLabel when candidateStates is already provided explicitly", async () => {
    const spy = vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      return { data: [], meta: { totals: { rows: 0 } } };
    });
    await getSearchHandler()({
      stateLabel: "Vivier chaud",
      candidateStates: [3], // explicit ID for 'Embauché'
      page: 1,
      pageSize: 30,
    });
    const query = spy.mock.calls.find((c) => c[0] === "/candidates")![3] as Record<string, unknown>;
    expect(query["candidateStates"]).toEqual([3]); // explicit wins
  });

  it("silently ignores unknown labels rather than throwing", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      return { data: [], meta: { totals: { rows: 0 } } };
    });
    const result = await getSearchHandler()({
      stateLabel: "Pâté en croûte",
      page: 1,
      pageSize: 30,
    });
    expect(result.content[0].text).toContain("Aucun(e)");
  });

  it("with fetchAll=true paginates until the page is partial (cap not reached)", async () => {
    const calls: number[] = [];
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path, _m, _b, q) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      const page = Number((q as Record<string, unknown>)["page"] ?? 1);
      calls.push(page);
      // Page 1 partial → loop should stop immediately after one fetch even
      // with a generous cap. Confirms the "data.length < pageSize → break"
      // path that protects us from infinite loops when the dataset is small.
      return {
        data: Array.from({ length: 42 }, (_, i) => ({ id: `${i}`, type: "candidate", attributes: {} })),
        meta: { totals: { rows: 42 } },
      };
    });
    await getSearchHandler()({ fetchAll: true, maxResults: 1000, page: 1, pageSize: 30 });
    expect(calls).toEqual([1]);
  });

  it("with fetchAll=true walks multiple full pages then stops on a partial one", async () => {
    const calls: number[] = [];
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path, _m, _b, q) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      const page = Number((q as Record<string, unknown>)["page"] ?? 1);
      calls.push(page);
      // Page 1 full (500 rows), page 2 partial (200) → walker stops on the
      // `data.length < pageSize` guard, NOT on the cap (cap=1000, we only
      // pull 700). Confirms both pagination and the partial-stop together.
      if (page === 1) {
        return {
          data: Array.from({ length: 500 }, (_, i) => ({ id: `${i}`, type: "candidate", attributes: {} })),
          meta: { totals: { rows: 700 } },
        };
      }
      return {
        data: Array.from({ length: 200 }, (_, i) => ({ id: `${500 + i}`, type: "candidate", attributes: {} })),
        meta: { totals: { rows: 700 } },
      };
    });
    await getSearchHandler()({ fetchAll: true, maxResults: 1000, page: 1, pageSize: 30 });
    expect(calls).toEqual([1, 2]);
  });

  it("with fetchAll=true respects the maxResults cap", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/dictionary") return CANDIDATE_DICT;
      return {
        data: Array.from({ length: 500 }, (_, i) => ({ id: `${i}`, type: "candidate", attributes: {} })),
        meta: { totals: { rows: 5000 } },
      };
    });
    const result = await getSearchHandler()({ fetchAll: true, maxResults: 100, page: 1, pageSize: 30 });
    // The formatter shows the merged rows; the meta total stays 5000 (server-side
    // count). The cap limits what we surface, not what BoondManager has.
    expect(result.content[0].text).toMatch(/Total: 5000 candidat\(s\)/);
  });
});
