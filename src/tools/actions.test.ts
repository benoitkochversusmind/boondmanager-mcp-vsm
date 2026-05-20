import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTools, formatActionSummary, stripHtml } from "./actions.js";

function createMockServer() {
  return {
    registerTool: vi.fn(),
  } as unknown as McpServer;
}

describe("registerActionTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = createMockServer();
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
    // &copy; isn't in the list — should remain as-is.
    expect(stripHtml("<span>&copy; 2026</span>")).toBe("&copy; 2026");
  });
});

describe("formatActionSummary", () => {
  it("renders fields in the canonical order: id | date | typeLabel | manager | linkedTo | text", () => {
    const out = formatActionSummary({
      id: "12345",
      type: "action",
      attributes: {
        startDate: "2026-05-20 14:00",
        typeLabel: "Note",
        text: "Suivi commercial après envoi de la proposition.",
        manager: { nom: "Jean-Yves LOISEAU" },
        linkedTo: { type: "contact", nom: "Jean Martin", id: 789 },
      },
    });
    expect(out).toBe(
      "[action #12345] | 2026-05-20 14:00 | Note | par Jean-Yves LOISEAU | → contact Jean Martin (#789) | Suivi commercial après envoi de la proposition."
    );
  });

  it("strips HTML tags and decodes entities in the text field", () => {
    const out = formatActionSummary({
      id: "99",
      attributes: {
        text: "<p>Appel&nbsp;client&nbsp;: <b>OK</b> pour la suite. L&#39;équipe valide.</p><p>&lt;urgent&gt;</p>",
      },
    });
    expect(out).toContain("Appel client : OK pour la suite. L'équipe valide. <urgent>");
    expect(out).not.toContain("&nbsp;");
    expect(out).not.toContain("&#39;");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("<b>");
  });

  it("truncates very long text and collapses whitespace after stripping HTML", () => {
    const longText = "A".repeat(500);
    const out = formatActionSummary({
      id: "1",
      attributes: { text: `<p>prefix</p>\n\n  ${longText}` },
    });
    expect(out).toMatch(/prefix .+…$/);
    expect(out.length).toBeLessThan(500);
  });

  it("drops the text field when stripping leaves an empty string", () => {
    const out = formatActionSummary({ id: "5", attributes: { text: "<br/><p>&nbsp;</p>" } });
    expect(out).toBe("[action #5]");
  });

  it("omits missing fields gracefully", () => {
    const out = formatActionSummary({ id: "42", attributes: {} });
    expect(out).toBe("[action #42]");
  });

  it("handles linkedTo without an id", () => {
    const out = formatActionSummary({
      id: "7",
      attributes: { linkedTo: { type: "company", nom: "Acme" } },
    });
    expect(out).toContain("→ company Acme");
    expect(out).not.toContain("(#");
  });

  it("handles a manager object without a nom", () => {
    const out = formatActionSummary({
      id: "8",
      attributes: { manager: { firstName: "X" } },
    });
    expect(out).toBe("[action #8]");
  });

  it("falls back to typeOf as 'type#N' when typeLabel is absent (numeric id)", () => {
    const out = formatActionSummary({ id: "10", attributes: { typeOf: 7 } });
    expect(out).toContain("type#7");
  });

  it("falls back to typeOf as 'type#N' when typeLabel is absent (string id)", () => {
    const out = formatActionSummary({ id: "11", attributes: { typeOf: "rdv" } });
    expect(out).toContain("type#rdv");
  });

  it("uses typeOf.label or typeOf.name when typeOf is an object", () => {
    const labelOut = formatActionSummary({ id: "12", attributes: { typeOf: { id: 7, label: "Note" } } });
    expect(labelOut).toContain("Note");
    expect(labelOut).not.toContain("type#");

    const nameOut = formatActionSummary({ id: "13", attributes: { typeOf: { id: 7, name: "Email" } } });
    expect(nameOut).toContain("Email");
  });

  it("prefers typeLabel over typeOf when both are present", () => {
    const out = formatActionSummary({
      id: "14",
      attributes: { typeLabel: "Note", typeOf: 7 },
    });
    expect(out).toContain("Note");
    expect(out).not.toContain("type#");
  });
});
