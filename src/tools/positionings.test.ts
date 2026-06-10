import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPositioningTools, formatPositioningsList } from "./positionings.js";
import * as dictionary from "../services/dictionary.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerPositioningTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
  });

  it("should register 5 positioning tools", () => {
    registerPositioningTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("should register all expected tool names", () => {
    registerPositioningTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_positionings_search");
    expect(names).toContain("boond_positionings_get");
    expect(names).toContain("boond_positionings_create");
    expect(names).toContain("boond_positionings_update");
    expect(names).toContain("boond_positionings_delete");
  });

  it("should register search and get as readOnly", () => {
    registerPositioningTools(server);
    const readOnlyCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) =>
          typeof c[0] === "string" && ["boond_positionings_search", "boond_positionings_get"].includes(c[0] as string)
      );
    for (const call of readOnlyCalls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("should register delete as destructive", () => {
    registerPositioningTools(server);
    const deleteCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_positionings_delete");
    expect(deleteCall?.[1].annotations?.destructiveHint).toBe(true);
  });
});

describe("formatPositioningsList", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function positioning(id: string, attrs: Record<string, unknown>, rels: Record<string, unknown> = {}) {
    return { id, type: "positioning", attributes: attrs, relationships: rels };
  }

  it("surfaces the consultant (dependsOn=candidate), dates, state label, period and opportunity", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({
      byId: new Map([[6, "04 - Sélectionné par le DO"]]),
      byLabel: new Map(),
    } as never);

    const response = {
      data: [
        positioning(
          "14549",
          {
            creationDate: "2026-05-26T15:45:00+0200",
            updateDate: "2026-06-08T17:02:00+0200",
            state: 6,
            startDate: "2026-07-01",
            endDate: "2026-09-30",
          },
          {
            dependsOn: { data: { id: "34592", type: "candidate" } },
            opportunity: { data: { id: "4370", type: "opportunity" } },
          }
        ),
      ],
      included: [
        { id: "34592", type: "candidate", attributes: { firstName: "David", lastName: "TA" } },
        { id: "4370", type: "opportunity", attributes: { title: "Dev JAVA" } },
      ],
      meta: { totals: { rows: 1 } },
    };

    const text = await formatPositioningsList(response as never);
    expect(text).toContain("Total: 1 positionnement(s)");
    expect(text).toContain("[positioning #14549]");
    expect(text).toContain("Dev JAVA (opportunity #4370)");
    expect(text).toContain("Consultant: David TA (candidat)"); // dependsOn resolved from included
    expect(text).toContain("04 - Sélectionné par le DO"); // state label
    expect(text).toContain("2026-07-01 → 2026-09-30");
    expect(text).toContain("créé 2026-05-26 15:45");
    expect(text).toContain("MàJ 2026-06-08 17:02");
  });

  it("labels a resource consultant as (ressource), even without included (fallback to id)", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({ byId: new Map(), byLabel: new Map() } as never);
    const response = {
      data: [
        positioning(
          "14914",
          { creationDate: "2026-01-02T08:00:00+0100", updateDate: "2026-01-02T08:00:00+0100", state: 2 },
          { dependsOn: { data: { id: "17537", type: "resource" } } }
        ),
      ],
    };
    const text = await formatPositioningsList(response as never);
    expect(text).toContain("[positioning #14914]");
    expect(text).toContain("Consultant: resource #17537 (ressource)"); // fallback to id, kind=ressource
    expect(text).toContain("état 2"); // numeric fallback when label missing
  });

  it("shows '(non renseigné)' when dependsOn is absent", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({ byId: new Map(), byLabel: new Map() } as never);
    const response = { data: [positioning("9", { creationDate: "2026-01-01T00:00:00+0100" }, {})] };
    const text = await formatPositioningsList(response as never);
    expect(text).toContain("Consultant: (non renseigné)");
  });

  it("filters out '00 - Candidature annonce' when excludeApplications is true", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({
      byId: new Map([
        [2, "00 - Candidature annonce"],
        [6, "04 - Sélectionné par le DO"],
      ]),
      byLabel: new Map(),
    } as never);
    const response = {
      data: [
        positioning(
          "100",
          { state: 2, creationDate: "2026-06-01T10:00:00+0200" },
          {
            dependsOn: { data: { id: "1", type: "candidate" } },
          }
        ),
        positioning(
          "101",
          { state: 6, creationDate: "2026-06-02T10:00:00+0200" },
          {
            dependsOn: { data: { id: "2", type: "resource" } },
          }
        ),
      ],
      meta: { totals: { rows: 2 } },
    };

    const kept = await formatPositioningsList(response as never, { excludeApplications: true });
    expect(kept).not.toContain("[positioning #100]"); // candidature annonce hidden
    expect(kept).toContain("[positioning #101]");
    expect(kept).toContain("1 masqué(s)");

    const all = await formatPositioningsList(response as never); // default: nothing hidden
    expect(all).toContain("[positioning #100]");
    expect(all).toContain("[positioning #101]");
  });

  it("returns a clear message for an empty result", async () => {
    const text = await formatPositioningsList({ data: [] } as never);
    expect(text).toBe("Aucun positionnement trouvé.");
  });
});

describe("boond_positionings_search entity-filter routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function getSearchHandler() {
    const server = createMockServer();
    registerPositioningTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_positionings_search");
    return call![2] as (p: Record<string, unknown>) => Promise<unknown>;
  }

  it("routes candidateId/resourceId/projectId/opportunityId through keyword prefixes (not raw query params)", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({ byId: new Map(), byLabel: new Map() } as never);
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: [] } as never);

    const handler = getSearchHandler();
    await handler({ candidateId: "34592", projectId: "1864", page: 1, pageSize: 30 });

    const query = apiSpy.mock.calls[0][3] as Record<string, unknown>;
    expect(String(query["keywords"])).toContain("CAND34592");
    expect(String(query["keywords"])).toContain("PRJ1864");
    // entity ids must NOT leak as literal query params (the API ignores them)
    expect(query["candidateId"]).toBeUndefined();
    expect(query["projectId"]).toBeUndefined();
  });

  it("maps resourceId→COMP and opportunityId→AO and preserves user keywords", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({ byId: new Map(), byLabel: new Map() } as never);
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: [] } as never);

    const handler = getSearchHandler();
    await handler({ resourceId: "17537", opportunityId: "4370", keywords: "java", page: 1, pageSize: 30 });

    const kw = String((apiSpy.mock.calls[0][3] as Record<string, unknown>)["keywords"]);
    expect(kw).toContain("COMP17537");
    expect(kw).toContain("AO4370");
    expect(kw).toContain("java");
  });
});

describe("boond_positionings_create / _update", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function getHandler(name: string) {
    const server = createMockServer();
    registerPositioningTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
    return call![2] as (p: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  }

  it("create: candidateId → dependsOn(candidate) + opportunity, note → informationComments", async () => {
    const apiSpy = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "14948", type: "positioning", attributes: {} } } as never);
    const handler = getHandler("boond_positionings_create");

    await handler({ candidateId: "34592", opportunityId: "4370", state: 1, note: "go" });

    const [path, method, body] = apiSpy.mock.calls[0];
    expect(path).toBe("/positionings");
    expect(method).toBe("POST");
    const data = (body as { data: { attributes: Record<string, unknown>; relationships: Record<string, unknown> } })
      .data;
    expect(data.relationships).toEqual({
      dependsOn: { data: { id: "34592", type: "candidate" } },
      opportunity: { data: { id: "4370", type: "opportunity" } },
    });
    expect(data.attributes["informationComments"]).toBe("go");
    expect(data.attributes["state"]).toBe(1);
    expect(data.attributes).not.toHaveProperty("note");
  });

  it("create: resourceId → dependsOn(resource) + project", async () => {
    const apiSpy = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "1", type: "positioning", attributes: {} } } as never);
    const handler = getHandler("boond_positionings_create");

    await handler({ resourceId: "17537", projectId: "1864" });

    const data = (apiSpy.mock.calls[0][2] as { data: { relationships: Record<string, unknown> } }).data;
    expect(data.relationships).toEqual({
      dependsOn: { data: { id: "17537", type: "resource" } },
      project: { data: { id: "1864", type: "project" } },
    });
  });

  it("create: rejects when no consultant (no API call)", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    const handler = getHandler("boond_positionings_create");
    const res = await handler({ opportunityId: "4370" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/candidateId|resourceId|[Cc]onsultant/);
    expect(apiSpy).not.toHaveBeenCalled();
  });

  it("create: rejects when no target (no API call)", async () => {
    const apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: null } as never);
    const handler = getHandler("boond_positionings_create");
    const res = await handler({ candidateId: "34592" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/opportunityId|projectId|[Cc]ible/);
    expect(apiSpy).not.toHaveBeenCalled();
  });

  it("update: PUT /positionings/{id} with note → informationComments", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({ byId: new Map(), byLabel: new Map() } as never);
    const apiSpy = vi
      .spyOn(boondClient, "apiRequest")
      .mockResolvedValue({ data: { id: "14948", type: "positioning", attributes: { state: 1 } } } as never);
    const handler = getHandler("boond_positionings_update");

    await handler({ id: "14948", state: 1, note: "MAJ" });

    const [path, method, body] = apiSpy.mock.calls[0];
    expect(path).toBe("/positionings/14948");
    expect(method).toBe("PUT");
    const data = (body as { data: { id: string; attributes: Record<string, unknown> } }).data;
    expect(data.id).toBe("14948");
    expect(data.attributes["informationComments"]).toBe("MAJ");
    expect(data.attributes["state"]).toBe(1);
  });
});
