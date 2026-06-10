import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCandidateTechnicalDataTools, updateCandidateTechnicalData } from "./candidates-technical-data.js";
import * as dictionary from "../services/dictionary.js";
import * as boondClient from "../services/boond-client.js";

// ---- Shared fixtures ---------------------------------------------------

/** Mirrors the live `data.setting.*` shapes verified against BoondManager. */
const DICT_PAYLOAD = {
  data: {
    setting: {
      tool: [
        { id: 1, value: "C#", isEnabled: true },
        { id: 2, value: "React", isEnabled: true },
        { id: 3, value: "Obsolète", isEnabled: false }, // disabled → must not resolve
      ],
      activityArea: [
        {
          id: "g1",
          value: "Profils",
          option: [
            { id: 10, value: "Développeur" },
            { id: 11, value: "Architecte" },
          ],
        },
        {
          id: "g2",
          value: "Certifications",
          option: [{ id: 20, value: "AWS Certified" }],
        },
      ],
      expertiseArea: [
        { id: 100, value: "Banque [S1]" },
        { id: 101, value: "Assurance [S2]" },
        { id: 102, value: "Secteur historique sans code" }, // no [Sn] → rejected
      ],
      experience: [
        { id: 1, value: "Junior" },
        { id: 5, value: "Senior" },
      ],
      languageSpoken: [
        { id: "anglais", value: "Anglais", isEnabled: true }, // lowercase id
        { id: "allemand", value: "Allemand", isEnabled: true },
        { id: "Italien", value: "Italien", isEnabled: true }, // capitalized id (heterogeneous)
      ],
      languageLevel: [
        { id: "A1", value: "A1 - Elémentaire-", isEnabled: true },
        { id: "A2", value: "A2 - Elémentaire+", isEnabled: true },
        { id: "B1", value: "B1 - Indépendant-", isEnabled: true },
        { id: "B2", value: "B2 - Indépendant+", isEnabled: true },
        { id: "C1", value: "C1 - Expérimenté-", isEnabled: true },
        { id: "C2", value: "C2 - Expérimenté+", isEnabled: true },
      ],
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

/**
 * Mocks apiRequest for the read-modify-write cycle:
 *   GET /candidates/{id}/technical-data → tdId
 *   GET /technical-datas/{tdId}         → current DT attributes
 *   PUT /technical-datas/{tdId}         → echoes the written attributes
 * `currentAttrs` lets each test control the existing DT (for merge/shape tests).
 */
function mockApi(currentAttrs: Record<string, unknown> = {}, tdId: number | string = 29489) {
  return vi
    .spyOn(boondClient, "apiRequest")
    .mockImplementation(async (path: string, method: string, body?: unknown) => {
      if (method === "GET" && path.endsWith("/technical-data")) {
        return { data: { type: "candidate", attributes: { tdId } } } as never;
      }
      if (method === "GET" && path.startsWith("/technical-datas/")) {
        return { data: { type: "technicaldata", id: String(tdId), attributes: currentAttrs } } as never;
      }
      if (method === "PUT" && path.startsWith("/technical-datas/")) {
        const attrs = (body as { data?: { attributes?: unknown } } | undefined)?.data?.attributes ?? {};
        return { data: { type: "technicaldata", id: String(tdId), attributes: attrs } } as never;
      }
      throw new Error(`unexpected apiRequest ${method} ${path}`);
    });
}

/** Pull the attributes from the PUT call (the actual write). */
function putAttrs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const putCall = spy.mock.calls.find((c) => c[1] === "PUT");
  expect(putCall, "a PUT write should have happened").toBeTruthy();
  return (putCall![2] as { data: { attributes: Record<string, unknown> } }).data.attributes;
}

describe("updateCandidateTechnicalData — label→id resolution", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves tools by value AND by id, writes string ids, PUTs /technical-datas/{tdId}", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });

    const res = await updateCandidateTechnicalData({
      candidateId: "29514",
      tools: ["C#", "2"], // one by value, one by raw id
      mode: "merge",
    });

    const [path, method] = api.mock.calls.find((c) => c[1] === "PUT")!;
    expect(path).toBe("/technical-datas/29489");
    expect(method).toBe("PUT");
    // tools are wrapped as { tool: <id>, level: <int> } objects (BoondManager rejects
    // flat ids with 1017 on /tools/0/tool because tools carry a level; default 0).
    expect(putAttrs(api)["tools"]).toEqual([
      { tool: "1", level: 0 },
      { tool: "2", level: 0 },
    ]);
    expect(res.tdId).toBe("29489");
    // untouched fields are NOT sent
    expect(putAttrs(api)).not.toHaveProperty("activityAreas");
    expect(putAttrs(api)).not.toHaveProperty("skills");
  });

  it("writes tools as { tool: id } objects but activityAreas/expertiseAreas as flat ids", async () => {
    mockDictionary();
    const api = mockApi({ tools: [], activityAreas: [], expertiseAreas: [] });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      tools: ["React"],
      activityAreas: ["Développeur"],
      expertiseAreas: ["Banque [S1]"],
      mode: "merge",
    });
    const attrs = putAttrs(api);
    expect(attrs["tools"]).toEqual([{ tool: "2", level: 0 }]); // wrapped + default level 0
    expect(attrs["activityAreas"]).toEqual(["10"]); // flat
    expect(attrs["expertiseAreas"]).toEqual(["100"]); // flat
  });

  it("parses an explicit tool level (<outil>|<niveau>)", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });
    await updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#|4", "React"], mode: "merge" });
    expect(putAttrs(api)["tools"]).toEqual([
      { tool: "1", level: 4 }, // explicit level
      { tool: "2", level: 0 }, // no level → 0
    ]);
  });

  it("is accent- and case-insensitive on labels", async () => {
    mockDictionary();
    const api = mockApi({ expertiseAreas: [] });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      expertiseAreas: ["banque [s1]", "ASSURANCE [S2]"],
    });
    expect(putAttrs(api)["expertiseAreas"]).toEqual(["100", "101"]);
  });

  it("flattens the hierarchical activityArea dictionary onto its leaves", async () => {
    mockDictionary();
    const api = mockApi({ activityAreas: [] });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      activityAreas: ["Développeur", "AWS Certified"], // leaves of distinct groups
    });
    expect(putAttrs(api)["activityAreas"]).toEqual(["10", "20"]);
  });

  it("resolves an experience label to its integer id", async () => {
    mockDictionary();
    const api = mockApi({});
    await updateCandidateTechnicalData({ candidateId: "29514", experience: "Senior" });
    expect(putAttrs(api)["experience"]).toBe(5);
  });
});

describe("updateCandidateTechnicalData — blocking errors (no partial write)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("throws and performs NO write when any label is unresolved", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#", "InconnuXYZ"] })).rejects.toThrow(
      /InconnuXYZ/
    );
    expect(api).not.toHaveBeenCalled(); // resolution happens before any GET/PUT
  });

  it("rejects expertise labels outside the S1–S12 codified set", async () => {
    mockDictionary();
    const api = mockApi({ expertiseAreas: [] });
    await expect(
      updateCandidateTechnicalData({
        candidateId: "29514",
        expertiseAreas: ["Secteur historique sans code"],
      })
    ).rejects.toThrow(/Secteur historique sans code/);
    expect(api).not.toHaveBeenCalled();
  });

  it("does not resolve disabled (isEnabled:false) dictionary entries", async () => {
    mockDictionary();
    mockApi({ tools: [] });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", tools: ["Obsolète"] })).rejects.toThrow(
      /Obsolète/
    );
  });

  it("lists every unresolved label across fields in one error", async () => {
    mockDictionary();
    mockApi({});
    const err = await updateCandidateTechnicalData({
      candidateId: "29514",
      tools: ["NopeTool"],
      expertiseAreas: ["NopeSector"],
      experience: "NopeXp",
    }).catch((e: Error) => e.message);
    // all three rejected entries are surfaced together (order-agnostic)
    expect(err).toContain("NopeTool");
    expect(err).toContain("NopeSector");
    expect(err).toContain("NopeXp");
  });
});

describe("updateCandidateTechnicalData — merge vs replace", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("merge: unions with the existing array, deduplicating (tools wrapped, level preserved)", async () => {
    mockDictionary();
    const api = mockApi({ tools: [{ tool: "1", level: 3 }] }); // C# already present with a level
    await updateCandidateTechnicalData({
      candidateId: "29514",
      tools: ["React"], // 2 (new)
      mode: "merge",
    });
    expect(putAttrs(api)["tools"]).toEqual([
      { tool: "1", level: 3 }, // existing level preserved
      { tool: "2", level: 0 },
    ]);
  });

  it("merge: a fresh tool entry overrides the existing one's level (new wins)", async () => {
    mockDictionary();
    const api = mockApi({ tools: [{ tool: "1", level: 1 }] });
    await updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#|5"], mode: "merge" });
    expect(putAttrs(api)["tools"]).toEqual([{ tool: "1", level: 5 }]);
  });

  it("merge: also tolerates flat existing tool ids when extracting", async () => {
    mockDictionary();
    const api = mockApi({ tools: ["1"] }); // defensive: flat existing
    await updateCandidateTechnicalData({ candidateId: "29514", tools: ["React"], mode: "merge" });
    expect(putAttrs(api)["tools"]).toEqual([
      { tool: "1", level: 0 },
      { tool: "2", level: 0 },
    ]);
  });

  it("replace: keeps only the provided entries (tools wrapped)", async () => {
    mockDictionary();
    const api = mockApi({
      tools: [
        { tool: "1", level: 2 },
        { tool: "99", level: 4 },
      ],
    });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      tools: ["React"],
      mode: "replace",
    });
    expect(putAttrs(api)["tools"]).toEqual([{ tool: "2", level: 0 }]);
  });

  it("defaults to merge when mode is omitted", async () => {
    mockDictionary();
    const api = mockApi({ tools: [{ tool: "1", level: 0 }] });
    await updateCandidateTechnicalData({ candidateId: "29514", tools: ["React"] });
    expect(putAttrs(api)["tools"]).toEqual([
      { tool: "1", level: 0 },
      { tool: "2", level: 0 },
    ]);
  });

  it("merge on activityAreas/expertiseAreas unions flat ids (no wrapper)", async () => {
    mockDictionary();
    const api = mockApi({ activityAreas: ["11"], expertiseAreas: ["101"] });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      activityAreas: ["Développeur"], // → 10, unions with existing 11
      expertiseAreas: ["Banque [S1]"], // → 100, unions with existing 101
      mode: "merge",
    });
    expect(putAttrs(api)["activityAreas"]).toEqual(["11", "10"]);
    expect(putAttrs(api)["expertiseAreas"]).toEqual(["101", "100"]);
  });

  it("writes skills verbatim", async () => {
    mockDictionary();
    const api = mockApi({});
    await updateCandidateTechnicalData({ candidateId: "29514", skills: "C#, microservices" });
    expect(putAttrs(api)["skills"]).toBe("C#, microservices");
  });
});

describe("updateCandidateTechnicalData — languages (CEFR)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("serializes { language: <id>, level: <CEFR id> }, resolving label/level by id OR value", async () => {
    mockDictionary();
    const api = mockApi({ languages: [] });
    await updateCandidateTechnicalData({
      candidateId: "29514",
      languages: ["Anglais|B2", "allemand|B1 - Indépendant-"], // level by id, then by value
    });
    expect(putAttrs(api)["languages"]).toEqual([
      { language: "anglais", level: "B2" }, // canonical lowercase id emitted
      { language: "allemand", level: "B1" },
    ]);
  });

  it("emits the exact canonical id for heterogeneous-cased languages", async () => {
    mockDictionary();
    const api = mockApi({ languages: [] });
    await updateCandidateTechnicalData({ candidateId: "29514", languages: ["italien|C1"] });
    expect(putAttrs(api)["languages"]).toEqual([{ language: "Italien", level: "C1" }]); // capitalized canonical id
  });

  it("allows a language with no level (empty level)", async () => {
    mockDictionary();
    const api = mockApi({ languages: [] });
    await updateCandidateTechnicalData({ candidateId: "29514", languages: ["Anglais"] });
    expect(putAttrs(api)["languages"]).toEqual([{ language: "anglais", level: "" }]);
  });

  it("merge: converts existing {language,level} objects and dedups (new level wins)", async () => {
    mockDictionary();
    const api = mockApi({
      languages: [
        { language: "anglais", level: "A1" },
        { language: "français", level: "" }, // legacy id absent from current dict → preserved
      ],
    });
    await updateCandidateTechnicalData({ candidateId: "29514", languages: ["Anglais|C1"], mode: "merge" });
    expect(putAttrs(api)["languages"]).toEqual([
      { language: "anglais", level: "C1" }, // overridden
      { language: "français", level: "" }, // preserved untouched
    ]);
  });

  it("rejects an unknown language (blocking, no write)", async () => {
    mockDictionary();
    const api = mockApi({ languages: [] });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", languages: ["Klingon|B2"] })).rejects.toThrow(
      /Klingon/
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects an unknown CEFR level (blocking, no write)", async () => {
    mockDictionary();
    const api = mockApi({ languages: [] });
    await expect(
      updateCandidateTechnicalData({ candidateId: "29514", languages: ["Anglais|courant"] })
    ).rejects.toThrow(/courant/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("updateCandidateTechnicalData — tool level validation", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects a tool level outside 0–5 (blocking, no write)", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#|9"] })).rejects.toThrow(/0–5/);
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects a non-integer tool level (blocking, no write)", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#|abc"] })).rejects.toThrow(/0–5/);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("updateCandidateTechnicalData — guards", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("throws when nothing is provided to update", async () => {
    mockDictionary();
    mockApi({});
    await expect(updateCandidateTechnicalData({ candidateId: "29514" })).rejects.toThrow(/Rien à mettre à jour/);
  });

  it("throws when the candidate has no technical data (tdId absent)", async () => {
    mockDictionary();
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path: string, method: string) => {
      if (method === "GET" && path.endsWith("/technical-data")) {
        return { data: { type: "candidate", attributes: {} } } as never; // no tdId
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    await expect(updateCandidateTechnicalData({ candidateId: "29514", tools: ["C#"] })).rejects.toThrow(/tdId/);
  });
});

describe("registerCandidateTechnicalDataTools", () => {
  function createMockServer() {
    return { registerTool: vi.fn() } as unknown as McpServer;
  }

  beforeEach(() => vi.restoreAllMocks());

  it("registers boond_candidates_technical_data_update as a write tool", () => {
    const server = createMockServer();
    registerCandidateTechnicalDataTools(server);
    const call = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_candidates_technical_data_update");
    expect(call).toBeTruthy();
    expect(call![1].annotations?.readOnlyHint).toBe(false);
  });

  it("handler returns isError (not a throw) on an unresolved label", async () => {
    mockDictionary();
    const api = mockApi({ tools: [] });
    const server = createMockServer();
    registerCandidateTechnicalDataTools(server);
    const handler = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_candidates_technical_data_update")![2] as (
      p: Record<string, unknown>
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;

    const res = await handler({ candidateId: "29514", tools: ["InconnuXYZ"], mode: "merge" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/InconnuXYZ/);
    expect(api).not.toHaveBeenCalled();
  });
});
