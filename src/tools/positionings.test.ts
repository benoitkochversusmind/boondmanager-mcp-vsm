import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPositioningTools, formatPositioningsList } from "./positionings.js";
import * as dictionary from "../services/dictionary.js";

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

  it("should register 4 positioning tools", () => {
    registerPositioningTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("should register all expected tool names", () => {
    registerPositioningTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_positionings_search");
    expect(names).toContain("boond_positionings_get");
    expect(names).toContain("boond_positionings_create");
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

  it("surfaces creationDate and updateDate (the core gap), state label, period and linked entities", async () => {
    vi.spyOn(dictionary, "getStateMap").mockResolvedValue({
      byId: new Map([[2, "Proposé"]]),
      byLabel: new Map(),
    } as never);

    const response = {
      data: [
        positioning(
          "14935",
          {
            creationDate: "2026-06-09T18:53:13+0200",
            updateDate: "2026-06-10T09:00:00+0200",
            state: 2,
            startDate: "2026-07-01",
            endDate: "2026-09-30",
          },
          {
            candidate: { data: { id: "42893", type: "candidate" } },
            opportunity: { data: { id: "585", type: "opportunity" } },
          }
        ),
      ],
      included: [
        { id: "42893", type: "candidate", attributes: { firstName: "Jean", lastName: "Dupont" } },
        { id: "585", type: "opportunity", attributes: { title: "Mission Data" } },
      ],
      meta: { totals: { rows: 1 } },
    };

    const text = await formatPositioningsList(response as never);
    expect(text).toContain("Total: 1 positionnement(s)");
    expect(text).toContain("[positioning #14935]");
    expect(text).toContain("Jean Dupont (candidate #42893)");
    expect(text).toContain("→ Mission Data (opportunity #585)");
    expect(text).toContain("Proposé"); // state label resolved
    expect(text).toContain("2026-07-01 → 2026-09-30"); // period
    expect(text).toContain("créé 2026-06-09 18:53"); // creationDate
    expect(text).toContain("MàJ 2026-06-10 09:00"); // updateDate
  });

  it("falls back to numeric state and IDs when dictionary is down and included is absent", async () => {
    vi.spyOn(dictionary, "getStateMap").mockRejectedValue(new Error("dict down"));
    const response = {
      data: [
        positioning(
          "1",
          { creationDate: "2026-01-02T08:00:00+0100", updateDate: "2026-01-02T08:00:00+0100", state: 7 },
          { resource: { data: { id: "20", type: "resource" } } }
        ),
      ],
    };
    const text = await formatPositioningsList(response as never);
    expect(text).toContain("[positioning #1]");
    expect(text).toContain("resource #20"); // fallback to id (no included)
    expect(text).toContain("état 7"); // numeric fallback
    expect(text).toContain("créé 2026-01-02 08:00");
  });

  it("returns a clear message for an empty result", async () => {
    const text = await formatPositioningsList({ data: [] } as never);
    expect(text).toBe("Aucun positionnement trouvé.");
  });
});
