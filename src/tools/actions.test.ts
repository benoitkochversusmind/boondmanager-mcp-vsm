import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JsonApiResource } from "../types.js";
import {
  registerActionTools,
  formatActionSummary,
  stripHtml,
  parseDictionaryNode,
  resetActionTypeLabelsForTests,
  type ActionFormatContext,
} from "./actions.js";
import { ActionSearchSchema } from "../schemas/index.js";

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

  it("falls back to type#N when the dictionary cache is empty", () => {
    const out = formatActionSummary(sampleAction, makeCtx({ included: [] }));
    expect(out).toContain("type#35");
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

  it("works without a ctx (degraded mode — only attributes-derived fields)", () => {
    const out = formatActionSummary(sampleAction);
    expect(out).toContain("[action #216463]");
    expect(out).toContain("2026-05-20T15:40:54+0200");
    expect(out).toContain("type#35"); // no dictionary → fallback
    expect(out).not.toContain("par "); // no included → no manager
    expect(out).not.toContain("→ "); // no included → no linked entity
  });
});
