import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerActionTools, formatActionSummary } from "./actions.js";

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

describe("formatActionSummary", () => {
  it("renders id, date, type, author, linkedTo and text", () => {
    const out = formatActionSummary({
      id: "12345",
      type: "action",
      attributes: {
        startDate: "2026-01-15",
        typeLabel: "Appel",
        text: "Suivi commercial après envoi de la proposition.",
        manager: { nom: "Dupont" },
        linkedTo: { type: "contact", nom: "Jean Martin", id: 789 },
      },
    });
    expect(out).toContain("[action #12345]");
    expect(out).toContain("2026-01-15");
    expect(out).toContain("Appel");
    expect(out).toContain("par Dupont");
    expect(out).toContain("→ contact Jean Martin (#789)");
    expect(out).toContain("Suivi commercial");
  });

  it("truncates very long text and collapses whitespace", () => {
    const longText = "A".repeat(500);
    const out = formatActionSummary({
      id: "1",
      attributes: { text: `prefix\n\n  ${longText}` },
    });
    expect(out).toMatch(/prefix .+…$/);
    expect(out.length).toBeLessThan(500);
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
});
