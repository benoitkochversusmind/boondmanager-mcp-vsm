import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonApiResource } from "../types.js";
import {
  registerActionTools,
  formatActionSummary,
  stripHtml,
  parseDictionaryNode,
  mergeActionDictionary,
  resetActionTypeLabelsForTests,
  handleActionCreate,
  resolveCurrentUserResourceId,
  type ActionFormatContext,
} from "./actions.js";
import { ActionSearchSchema } from "../schemas/index.js";
import * as boondClient from "../services/boond-client.js";
import * as dictionaryService from "../services/dictionary.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

function indexFromIncluded(included: JsonApiResource[]): Map<string, JsonApiResource> {
  const m = new Map<string, JsonApiResource>();
  for (const r of included) m.set(`${r.type}:${r.id}`, r);
  return m;
}

function makeCtx(opts: { included?: JsonApiResource[]; typeLabels?: Map<number, string> } = {}): ActionFormatContext {
  return {
    included: indexFromIncluded(opts.included ?? []),
    typeLabels: opts.typeLabels ?? new Map(),
  };
}

describe("registerActionTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
    resetActionTypeLabelsForTests();
  });

  it("should register 4 action tools", () => {
    registerActionTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(4);
  });

  it("should register all expected tool names", () => {
    registerActionTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_actions_search");
    expect(names).toContain("boond_actions_get");
    expect(names).toContain("boond_actions_create");
    expect(names).toContain("boond_actions_delete");
  });

  it("should register search and get as readOnly", () => {
    registerActionTools(server);
    const readOnlyCalls = vi
      .mocked(server.registerTool)
      .mock.calls.filter(
        (c) => typeof c[0] === "string" && ["boond_actions_search", "boond_actions_get"].includes(c[0] as string)
      );
    for (const call of readOnlyCalls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });

  it("should register delete as destructive", () => {
    registerActionTools(server);
    const deleteCall = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_actions_delete");
    expect(deleteCall?.[1].annotations?.destructiveHint).toBe(true);
  });
});

describe("ActionSearchSchema (managerId)", () => {
  it("accepts a managerId filter", () => {
    const result = ActionSearchSchema.safeParse({ managerId: "36952" });
    expect(result.success).toBe(true);
  });

  it("still rejects unknown fields (strict mode)", () => {
    expect(ActionSearchSchema.safeParse({ mainManagers: ["36952"] }).success).toBe(false);
  });
});

describe("parseDictionaryNode", () => {
  it("parses { id, value } items (BoondManager canonical shape)", () => {
    const m = parseDictionaryNode([
      { id: 35, value: "Note" },
      { id: 7, value: "Email" },
    ]);
    expect(m.get(35)).toBe("Note");
    expect(m.get(7)).toBe("Email");
  });

  it("parses { id, label } and { id, name } fallbacks", () => {
    expect(parseDictionaryNode([{ id: 1, label: "X" }]).get(1)).toBe("X");
    expect(parseDictionaryNode([{ id: 2, name: "Y" }]).get(2)).toBe("Y");
  });

  it("coerces string ids to numbers", () => {
    expect(parseDictionaryNode([{ id: "35", value: "Note" }]).get(35)).toBe("Note");
  });

  it("parses a flat record { '35': 'Note', ... }", () => {
    expect(parseDictionaryNode({ "35": "Note", "7": "Email" }).get(35)).toBe("Note");
  });

  it("parses a record with nested label objects", () => {
    expect(parseDictionaryNode({ "35": { value: "Note" } }).get(35)).toBe("Note");
  });

  it("returns an empty map for unusable input", () => {
    expect(parseDictionaryNode(null).size).toBe(0);
    expect(parseDictionaryNode(undefined).size).toBe(0);
    expect(parseDictionaryNode("not a dict").size).toBe(0);
    expect(parseDictionaryNode([{ id: "abc", value: "no" }]).size).toBe(0);
  });
});

describe("mergeActionDictionary", () => {
  // Mirrors the real shape captured from prod: setting.action is an object
  // with boolean siblings (forceMultiCreation, sort) and per-entity arrays.
  const sample = {
    forceMultiCreation: true,
    sort: false,
    contact: [
      { id: 35, isEnabled: true, value: "Prospection - autre prise de contact" },
      { id: 2, isEnabled: true, value: "Note" },
    ],
    candidate: [
      { id: 7, isEnabled: true, value: "Entretien" },
      { id: 2, isEnabled: true, value: "Note" }, // duplicate id, same label
    ],
    company: [{ id: 99, value: "Revue compte" }],
  };

  it("merges per-entity arrays into a single id → label map", () => {
    const m = mergeActionDictionary(sample);
    expect(m.get(35)).toBe("Prospection - autre prise de contact");
    expect(m.get(2)).toBe("Note");
    expect(m.get(7)).toBe("Entretien");
    expect(m.get(99)).toBe("Revue compte");
  });

  it("skips non-array sibling values (flags like forceMultiCreation / sort)", () => {
    const m = mergeActionDictionary(sample);
    // Sanity: no spurious string-keyed entries from the booleans.
    expect(m.size).toBe(4);
  });

  it("returns an empty map for unusable inputs", () => {
    expect(mergeActionDictionary(null).size).toBe(0);
    expect(mergeActionDictionary(undefined).size).toBe(0);
    expect(mergeActionDictionary([]).size).toBe(0); // arrays are not the right shape
    expect(mergeActionDictionary("nope").size).toBe(0);
    expect(mergeActionDictionary({ flagsOnly: true }).size).toBe(0);
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes common entities", () => {
    expect(stripHtml("<p>Hello&nbsp;<b>world</b></p>")).toBe("Hello world");
    expect(stripHtml("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(stripHtml("L&#39;équipe")).toBe("L'équipe");
  });

  it("leaves plain text untouched", () => {
    expect(stripHtml("Just plain text.")).toBe("Just plain text.");
  });

  it("does not decode entities outside the small allowlist", () => {
    expect(stripHtml("<span>&copy; 2026</span>")).toBe("&copy; 2026");
  });
});

describe("formatActionSummary", () => {
  // Sample built to mirror the real /actions payload shape captured from
  // ACA logs: typeOf as a numeric id, mainManager / dependsOn as JSON:API
  // relationships, included carrying the resolved entities.
  const sampleAction = {
    id: "216463",
    type: "action",
    attributes: {
      startDate: "2026-05-20T15:40:54+0200",
      typeOf: 35,
      text: "<p>Bonjour Florent, je me permets…</p>",
    },
    relationships: {
      mainManager: { data: { id: "36952", type: "resource" } },
      dependsOn: { data: { id: "16259", type: "contact" } },
      company: { data: { id: "1291", type: "company" } },
    },
  };

  it("renders the canonical line with included resolution + dictionary type label", () => {
    const ctx = makeCtx({
      typeLabels: new Map([[35, "Note"]]),
      included: [
        { id: "36952", type: "resource", attributes: { firstName: "Jean-Yves", lastName: "LOISEAU" } },
        { id: "16259", type: "contact", attributes: { firstName: "Florent", lastName: "Nallatamby" } },
      ],
    });
    const out = formatActionSummary(sampleAction, ctx);
    expect(out).toBe(
      "[action #216463] | 2026-05-20T15:40:54+0200 | Note | par Jean-Yves LOISEAU | → contact Florent Nallatamby (#16259) | Bonjour Florent, je me permets…"
    );
  });

  it("falls back to the static contact-scope label when the dictionary cache is empty", () => {
    // sampleAction.dependsOn.type = "contact" → ID 35 resolves via the
    // contact bucket of STATIC_TYPE_LABELS even when the live dictionary
    // is unavailable. This is the v1.10.0 behavior — the previous
    // "type#N" fallback was too coarse for the relance / sourcing flows.
    const out = formatActionSummary(sampleAction, makeCtx({ included: [] }));
    expect(out).toContain("1 bis - Prospection - autre prise de contact");
  });

  it("falls back to type#N when neither the dictionary nor the static map covers the ID", () => {
    const action = {
      id: "1",
      type: "action",
      attributes: { typeOf: 9999 }, // never seen anywhere
      relationships: { dependsOn: { data: { id: "1", type: "contact" } } },
    };
    const out = formatActionSummary(action, makeCtx({ included: [] }));
    expect(out).toContain("type#9999");
  });

  it("resolves a company as linked entity via its `name` attribute", () => {
    const action = {
      id: "1",
      type: "action",
      attributes: { typeOf: 35 },
      relationships: { dependsOn: { data: { id: "1291", type: "company" } } },
    };
    const ctx = makeCtx({
      included: [{ id: "1291", type: "company", attributes: { name: "Versusmind" } }],
    });
    expect(formatActionSummary(action, ctx)).toContain("→ company Versusmind (#1291)");
  });

  it("skips the linked entity when its include is missing from the response", () => {
    const action = {
      id: "1",
      attributes: {},
      relationships: { dependsOn: { data: { id: "9999", type: "contact" } } },
    };
    const out = formatActionSummary(action, makeCtx({ included: [] }));
    expect(out).toBe("[action #1]");
  });

  it("falls back to #id when a person has no firstName/lastName", () => {
    const action = {
      id: "1",
      attributes: { typeOf: 35 },
      relationships: { dependsOn: { data: { id: "5", type: "contact" } } },
    };
    const ctx = makeCtx({
      included: [{ id: "5", type: "contact", attributes: {} }],
    });
    expect(formatActionSummary(action, ctx)).toContain("→ contact #5 (#5)");
  });

  it("strips HTML tags and decodes entities in the text field", () => {
    const out = formatActionSummary(
      {
        id: "99",
        attributes: {
          text: "<p>Appel&nbsp;client&nbsp;: <b>OK</b> pour la suite. L&#39;équipe valide.</p><p>&lt;urgent&gt;</p>",
        },
      },
      makeCtx()
    );
    expect(out).toContain("Appel client : OK pour la suite. L'équipe valide. <urgent>");
    expect(out).not.toContain("&nbsp;");
    expect(out).not.toContain("<p>");
  });

  it("truncates very long text", () => {
    const longText = "A".repeat(500);
    const out = formatActionSummary({ id: "1", attributes: { text: `<p>prefix</p>\n\n  ${longText}` } }, makeCtx());
    expect(out).toMatch(/prefix .+…$/);
    expect(out.length).toBeLessThan(500);
  });

  it("drops the text field when stripping leaves an empty string", () => {
    const out = formatActionSummary({ id: "5", attributes: { text: "<br/><p>&nbsp;</p>" } }, makeCtx());
    expect(out).toBe("[action #5]");
  });

  it("omits missing relationships gracefully", () => {
    const out = formatActionSummary({ id: "42", attributes: {} }, makeCtx());
    expect(out).toBe("[action #42]");
  });

  it("works without a ctx (degraded mode — only attributes-derived fields + static fallback)", () => {
    const out = formatActionSummary(sampleAction);
    expect(out).toContain("[action #216463]");
    expect(out).toContain("2026-05-20T15:40:54+0200");
    // No ctx → no live dictionary, but the static contact-scope fallback
    // still resolves ID 35 (sampleAction.dependsOn.type === "contact").
    expect(out).toContain("1 bis - Prospection - autre prise de contact");
    expect(out).not.toContain("par "); // no included → no manager
    expect(out).not.toContain("→ "); // no included → no linked entity
  });
});

describe("boond_actions_search handler — query param mapping", () => {
  // Spies on the actual API request so we can assert which query the handler
  // hands off. Each test gets a fresh server + cleared module caches so
  // dictionary loading does not leak between cases.
  let server: McpServer;
  let apiSpy: ReturnType<typeof vi.spyOn>;

  function getSearchHandler() {
    registerActionTools(server);
    const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_actions_search");

    return call![2] as (params: Record<string, unknown>) => Promise<unknown>;
  }

  beforeEach(() => {
    // vi.spyOn on the same module property returns the existing spy if any,
    // so its mock.calls accumulates across tests. Reset everything first.
    vi.restoreAllMocks();
    server = createMockServer();
    resetActionTypeLabelsForTests();
    dictionaryService.resetDictionaryCacheForTests();
    // The handler also loads the dictionary for type labels; stub it so the
    // tests do not require network and stay focused on /actions params.
    vi.spyOn(dictionaryService, "getDictionary").mockResolvedValue({
      payload: { data: { setting: { action: {} } } },
      fetchedAt: Date.now(),
      language: "fr",
    } as never);
    apiSpy = vi.spyOn(boondClient, "apiRequest").mockResolvedValue({ data: [] } as never);
  });

  it("maps managerId → perimeterManagers[]", async () => {
    await getSearchHandler()({ managerId: "36952", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.perimeterManagers).toEqual(["36952"]);
    expect(query).not.toHaveProperty("mainManagers");
    expect(query).not.toHaveProperty("managerId");
  });

  it("maps dateFrom → startDate and dateTo → endDate (preserves period)", async () => {
    await getSearchHandler()({
      dateFrom: "2026-05-01",
      dateTo: "2026-05-20",
      period: "started",
      page: 1,
      pageSize: 30,
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.startDate).toBe("2026-05-01");
    expect(query.endDate).toBe("2026-05-20");
    expect(query.period).toBe("started");
    expect(query).not.toHaveProperty("dateFrom");
    expect(query).not.toHaveProperty("dateTo");
  });

  it("maps typeOf → actionTypes[]", async () => {
    await getSearchHandler()({ typeOf: [12, 19, 41], page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.actionTypes).toEqual([12, 19, 41]);
    expect(query).not.toHaveProperty("typeOf");
  });

  // ---- Bug 2 regression : period must NOT be sent without a date window ----

  it("does NOT send period when neither dates nor periodDynamic are provided", async () => {
    await getSearchHandler()({ candidateId: "42893", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    // The whole bug : period=started with no window returned 0 results.
    expect(query).not.toHaveProperty("period");
    // candidateId still routed through the CAND keyword prefix.
    expect(query.keywords).toBe("CAND42893");
  });

  it("sends period when a date window IS provided", async () => {
    await getSearchHandler()({
      candidateId: "42893",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-31",
      period: "started",
      page: 1,
      pageSize: 30,
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.period).toBe("started");
    expect(query.startDate).toBe("2026-05-01");
    expect(query.endDate).toBe("2026-05-31");
  });

  it("sends period when only dateFrom is provided (single open bound)", async () => {
    await getSearchHandler()({ dateFrom: "2026-05-01", period: "created", page: 1, pageSize: 30 });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.period).toBe("created");
    expect(query.startDate).toBe("2026-05-01");
  });

  it("sends period AND periodDynamic when only periodDynamic is provided", async () => {
    await getSearchHandler()({ periodDynamic: "thisMonth", period: "started", page: 1, pageSize: 30 });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.periodDynamic).toBe("thisMonth");
    expect(query.period).toBe("started"); // legitimate : dynamic window needs the field
  });

  it("omits typeOf when the array is empty", async () => {
    await getSearchHandler()({ typeOf: [], page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query).not.toHaveProperty("actionTypes");
  });

  it("combines all four mapped filters in a single call", async () => {
    await getSearchHandler()({
      managerId: "36952",
      dateFrom: "2026-05-01",
      dateTo: "2026-05-20",
      typeOf: [13],
      period: "created",
      page: 1,
      pageSize: 30,
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query).toMatchObject({
      perimeterManagers: ["36952"],
      startDate: "2026-05-01",
      endDate: "2026-05-20",
      actionTypes: [13],
      period: "created",
    });
  });

  // ---- v1.10.0 features ported from boond-mcp-server -----------------------

  it("resolves actionType='entretien' to the full entretien bucket [19, 12, 22, 23, 133]", async () => {
    await getSearchHandler()({ actionType: "entretien", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.actionTypes).toEqual([19, 12, 22, 23, 133]);
  });

  it("resolves actionType='rdv' (alias for rendez-vous)", async () => {
    await getSearchHandler()({ actionType: "rdv", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.actionTypes).toEqual([29, 55]);
  });

  it("accepts a stringified numeric actionType as a one-shot ID shortcut", async () => {
    await getSearchHandler()({ actionType: "42", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.actionTypes).toEqual([42]);
  });

  it("explicit typeOf wins over actionType keyword", async () => {
    await getSearchHandler()({
      typeOf: [13],
      actionType: "entretien",
      page: 1,
      pageSize: 30,
      period: "started",
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.actionTypes).toEqual([13]); // explicit wins
  });

  it("unknown actionType is silently ignored (no actionTypes filter sent)", async () => {
    await getSearchHandler()({ actionType: "spaghetti", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query).not.toHaveProperty("actionTypes");
  });

  it("forwards periodDynamic to the API as-is", async () => {
    await getSearchHandler()({ periodDynamic: "thisMonth", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.periodDynamic).toBe("thisMonth");
  });

  it("injects CAND<id> into keywords when candidateId is set", async () => {
    await getSearchHandler()({ candidateId: "12345", page: 1, pageSize: 30, period: "started" });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.keywords).toBe("CAND12345");
    expect(query).not.toHaveProperty("candidateId");
  });

  it("injects COMP<id> for resourceId, CCON for contactId, CSOC for companyId", async () => {
    await getSearchHandler()({
      resourceId: "100",
      contactId: "200",
      companyId: "300",
      page: 1,
      pageSize: 30,
      period: "started",
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.keywords).toBe("COMP100 CCON200 CSOC300");
  });

  it("prepends linked-entity prefixes to user-supplied keywords", async () => {
    await getSearchHandler()({
      candidateId: "777",
      keywords: "follow-up",
      page: 1,
      pageSize: 30,
      period: "started",
    });
    const query = apiSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(query.keywords).toBe("CAND777 follow-up");
  });
});

describe("ActionSearchSchema (typeOf)", () => {
  it("accepts an array of integers", () => {
    const r = ActionSearchSchema.safeParse({ typeOf: [12, 19, 41] });
    expect(r.success).toBe(true);
  });

  it("rejects non-integer values", () => {
    expect(ActionSearchSchema.safeParse({ typeOf: ["12"] }).success).toBe(false);
    expect(ActionSearchSchema.safeParse({ typeOf: [12.5] }).success).toBe(false);
  });
});

describe("handleActionCreate — dependsOn + mainManager (Bug fix)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // The current-user response shape used by resolveCurrentUserResourceId().
  const CURRENT_USER_RESP = {
    data: {
      id: "1",
      type: "currentuser",
      attributes: {
        firstName: "Benoit",
        lastName: "KOCH",
        thumbnail: "resource_42_895b910baa558f41c2f03cae63c8aa49d3142a17",
      },
    },
  };

  function mockApi(captured: { body?: unknown; path?: string; method?: string }) {
    return vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path, method, body) => {
      if (path === "/application/current-user") return CURRENT_USER_RESP as never;
      // /actions POST — capture the body for assertions
      captured.path = path;
      captured.method = method;
      captured.body = body;
      return {
        data: { id: "999", type: "action", attributes: {}, relationships: {} },
      } as never;
    });
  }

  it("builds dependsOn={type:contact} from contactId (Bug : 422 dependsOn missing)", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, contactId: "514", startDate: "2026-06-10" });
    const body = captured.body as { data: { relationships: { dependsOn: { data: { id: string; type: string } } } } };
    expect(body.data.relationships.dependsOn.data).toEqual({ id: "514", type: "contact" });
  });

  it("builds dependsOn={type:candidate} from candidateId", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 17, candidateId: "42893" });
    const body = captured.body as { data: { relationships: { dependsOn: { data: { id: string; type: string } } } } };
    expect(body.data.relationships.dependsOn.data).toEqual({ id: "42893", type: "candidate" });
  });

  it("builds dependsOn for company / opportunity / project / resource too (polymorphic)", async () => {
    const cases: Array<[Record<string, string>, { id: string; type: string }]> = [
      [{ companyId: "100" }, { id: "100", type: "company" }],
      [{ opportunityId: "200" }, { id: "200", type: "opportunity" }],
      [{ projectId: "300" }, { id: "300", type: "project" }],
      [{ resourceId: "400" }, { id: "400", type: "resource" }],
    ];
    for (const [extra, expected] of cases) {
      const captured: { body?: unknown } = {};
      mockApi(captured);
      await handleActionCreate({ typeOf: 1, ...extra });
      const body = captured.body as { data: { relationships: { dependsOn: { data: unknown } } } };
      expect(body.data.relationships.dependsOn.data).toEqual(expected);
    }
  });

  it("resolves mainManager from current user thumbnail when mainManagerId is omitted", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, contactId: "514" });
    const body = captured.body as { data: { relationships: { mainManager: { data: { id: string; type: string } } } } };
    expect(body.data.relationships.mainManager.data).toEqual({ id: "42", type: "resource" });
  });

  it("uses explicit mainManagerId when provided (overrides current-user resolution)", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, contactId: "514", mainManagerId: "33650" });
    const body = captured.body as { data: { relationships: { mainManager: { data: { id: string; type: string } } } } };
    expect(body.data.relationships.mainManager.data).toEqual({ id: "33650", type: "resource" });
  });

  it("accepts typeOf as numeric string ('3') and casts to integer", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: "3", contactId: "514" });
    const body = captured.body as { data: { attributes: { typeOf: unknown } } };
    expect(body.data.attributes.typeOf).toBe(3);
    expect(typeof body.data.attributes.typeOf).toBe("number");
  });

  it("rejects an invalid typeOf with a clear error (not 422)", async () => {
    mockApi({});
    await expect(handleActionCreate({ typeOf: "abc", contactId: "514" })).rejects.toThrow(/typeOf/i);
  });

  it("throws a clear error when NO linked-entity ID is provided", async () => {
    mockApi({});
    await expect(handleActionCreate({ typeOf: 3 })).rejects.toThrow(/dependsOn|entité parente/i);
  });

  it("respects priority order : contactId beats candidateId/companyId when both given", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, candidateId: "9", contactId: "514", companyId: "1" });
    const body = captured.body as { data: { relationships: { dependsOn: { data: { type: string } } } } };
    expect(body.data.relationships.dependsOn.data.type).toBe("contact");
  });

  it("normalises bare YYYY-MM-DD startDate to ISO with Paris offset", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, contactId: "514", startDate: "2026-06-10" });
    const body = captured.body as { data: { attributes: { startDate: string } } };
    expect(body.data.attributes.startDate).toBe("2026-06-10T00:00:00+0200");
  });

  it("passes through ISO 8601 startDate untouched", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({ typeOf: 3, contactId: "514", startDate: "2026-06-10T14:30:00+0200" });
    const body = captured.body as { data: { attributes: { startDate: string } } };
    expect(body.data.attributes.startDate).toBe("2026-06-10T14:30:00+0200");
  });

  it("maps subject → title and content → text (back-compat aliases)", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({
      typeOf: 3,
      contactId: "514",
      subject: "Rappel relance",
      content: "<p>À recontacter mardi</p>",
    });
    const body = captured.body as { data: { attributes: Record<string, string> } };
    expect(body.data.attributes.title).toBe("Rappel relance");
    expect(body.data.attributes.text).toBe("<p>À recontacter mardi</p>");
    expect(body.data.attributes).not.toHaveProperty("subject");
    expect(body.data.attributes).not.toHaveProperty("content");
  });

  it("title/text wins over subject/content when both provided", async () => {
    const captured: { body?: unknown } = {};
    mockApi(captured);
    await handleActionCreate({
      typeOf: 3,
      contactId: "514",
      title: "Canonique",
      subject: "Alias",
      text: "Body canonique",
      content: "Body alias",
    });
    const body = captured.body as { data: { attributes: Record<string, string> } };
    expect(body.data.attributes.title).toBe("Canonique");
    expect(body.data.attributes.text).toBe("Body canonique");
  });

  it("throws a clear error when current-user thumbnail cannot be parsed (no mainManagerId fallback)", async () => {
    vi.spyOn(boondClient, "apiRequest").mockImplementation(async (path) => {
      if (path === "/application/current-user") {
        return {
          data: { id: "1", type: "currentuser", attributes: { thumbnail: "garbage_no_resource" } },
        } as never;
      }
      return { data: {} } as never;
    });
    await expect(handleActionCreate({ typeOf: 3, contactId: "514" })).rejects.toThrow(/mainManagerId|current/i);
  });
});

describe("resolveCurrentUserResourceId", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the numeric resource id from the thumbnail prefix", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: {
        id: "1",
        type: "currentuser",
        attributes: { thumbnail: "resource_42_8abc" },
      },
    } as never);
    expect(await resolveCurrentUserResourceId()).toBe("42");
  });

  it("returns null when thumbnail is missing or malformed", async () => {
    vi.spyOn(boondClient, "apiRequest").mockResolvedValue({
      data: { id: "1", type: "currentuser", attributes: {} },
    } as never);
    expect(await resolveCurrentUserResourceId()).toBeNull();
  });
});
