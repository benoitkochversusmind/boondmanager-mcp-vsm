import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCandidateAdministrativeTools, updateCandidateAdministrative } from "./candidates-administrative.js";
import * as dictionary from "../services/dictionary.js";
import * as boondClient from "../services/boond-client.js";

const DICT_PAYLOAD = {
  data: {
    setting: {
      mobilityArea: [
        {
          id: "alsace",
          value: "Alsace",
          isEnabled: true,
          option: [
            { id: "Strasbourg", value: "Strasbourg", isEnabled: true },
            { id: "Mulhouse", value: "Mulhouse", isEnabled: true },
          ],
        },
        {
          id: "franceentiere",
          value: "France entière",
          isEnabled: true,
          option: [{ id: "toutelafrance", value: "Toute la France", isEnabled: true }],
        },
      ],
      typeOf: {
        contract: [
          { id: 0, value: "CDI", isEnabled: true },
          { id: 3, value: "Freelance", isEnabled: true },
        ],
      },
      situation: [
        { id: 0, value: "Célibataire", isEnabled: true },
        { id: 1, value: "Marié(e)", isEnabled: true },
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

/** GET /candidates/{id}/administrative → currentAdmin ; PUT (base or admin) → echo. */
function mockApi(currentAdmin: Record<string, unknown> = {}) {
  return vi
    .spyOn(boondClient, "apiRequest")
    .mockImplementation(async (path: string, method: string, body?: unknown) => {
      if (method === "GET" && path.endsWith("/administrative")) {
        return { data: { type: "candidate", id: "2123", attributes: currentAdmin } } as never;
      }
      if (method === "PUT") {
        const attrs = (body as { data?: { attributes?: unknown } } | undefined)?.data?.attributes ?? {};
        return { data: { type: "candidate", id: "2123", attributes: attrs } } as never;
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
}

/** Return the data block of the PUT to the given path, or undefined if none. */
function putTo(
  spy: ReturnType<typeof vi.spyOn>,
  path: string
): { attributes: Record<string, unknown>; id?: string } | undefined {
  const call = spy.mock.calls.find((c) => c[1] === "PUT" && c[0] === path);
  return call ? (call[2] as { data: { attributes: Record<string, unknown>; id?: string } }).data : undefined;
}

describe("updateCandidateAdministrative — resolution & write", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("writes ALL fields via PUT /candidates/{id}/administrative (never the base path)", async () => {
    mockDictionary();
    const api = mockApi({});
    await updateCandidateAdministrative({
      candidateId: "2123",
      availability: "2026-09-01",
      mobilityAreas: ["Strasbourg", "Toute la France"],
      desiredContract: "Freelance",
      situation: "Marié(e)",
      actualSalary: 45000,
    });
    expect(putTo(api, "/candidates/2123"), "must NOT hit the base path (405)").toBeUndefined();
    const admin = putTo(api, "/candidates/2123/administrative");
    expect(admin, "admin PUT should have happened").toBeTruthy();
    expect(admin!.id).toBe("2123");
    expect(admin!.attributes["availability"]).toBe("2026-09-01");
    expect(admin!.attributes["mobilityAreas"]).toEqual(["Strasbourg", "toutelafrance"]); // canonical ids
    expect(admin!.attributes["desiredContract"]).toBe(3); // Freelance → 3
    expect(admin!.attributes["situation"]).toBe(1); // Marié(e) → 1
    expect(admin!.attributes["actualSalary"]).toBe(45000);
  });

  it("merges a salary range, preserving the bound not provided", async () => {
    mockDictionary();
    const api = mockApi({ desiredSalary: { min: 40000, max: 55000 } });
    await updateCandidateAdministrative({ candidateId: "2123", desiredSalaryMin: 48000 });
    expect(putTo(api, "/candidates/2123/administrative")!.attributes["desiredSalary"]).toEqual({
      min: 48000, // provided
      max: 55000, // preserved from current
    });
  });

  it("falls back to POST /administrative when PUT returns 405", async () => {
    mockDictionary();
    const calls: Array<{ method: string; path: string }> = [];
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path: string, method: string) => {
      if (method === "GET") return { data: { type: "candidate", id: "2123", attributes: {} } } as never;
      calls.push({ method, path });
      if (method === "PUT") throw new Error("BoondManager API 405 Method Not Allowed");
      return { data: { type: "candidate", id: "2123", attributes: {} } } as never; // POST ok
    });
    await updateCandidateAdministrative({ candidateId: "2123", actualSalary: 50000 });
    expect(calls).toEqual([
      { method: "PUT", path: "/candidates/2123/administrative" },
      { method: "POST", path: "/candidates/2123/administrative" },
    ]);
  });

  it("rejects an unknown label (blocking, no write)", async () => {
    mockDictionary();
    const api = mockApi({});
    await expect(updateCandidateAdministrative({ candidateId: "2123", mobilityAreas: ["Pluton"] })).rejects.toThrow(
      /Pluton/
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("rejects an unknown contract / situation label", async () => {
    mockDictionary();
    mockApi({});
    await expect(
      updateCandidateAdministrative({ candidateId: "2123", desiredContract: "Alternance++" })
    ).rejects.toThrow(/Alternance\+\+/);
  });

  it("throws when nothing is provided", async () => {
    mockDictionary();
    mockApi({});
    await expect(updateCandidateAdministrative({ candidateId: "2123" })).rejects.toThrow(/Rien à mettre à jour/);
  });
});

describe("registerCandidateAdministrativeTools", () => {
  beforeEach(() => vi.restoreAllMocks());
  function createMockServer() {
    return { registerTool: vi.fn() } as unknown as McpServer;
  }

  it("registers boond_candidates_administrative_update as a write tool", () => {
    const server = createMockServer();
    registerCandidateAdministrativeTools(server);
    const call = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_candidates_administrative_update");
    expect(call).toBeTruthy();
    expect(call![1].annotations?.readOnlyHint).toBe(false);
  });

  it("handler returns isError on an unresolved label", async () => {
    mockDictionary();
    const api = mockApi({});
    const server = createMockServer();
    registerCandidateAdministrativeTools(server);
    const handler = vi
      .mocked(server.registerTool)
      .mock.calls.find((c) => c[0] === "boond_candidates_administrative_update")![2] as (
      p: Record<string, unknown>
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    const res = await handler({ candidateId: "2123", situation: "Inconnu" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Inconnu/);
    expect(api).not.toHaveBeenCalled();
  });
});
