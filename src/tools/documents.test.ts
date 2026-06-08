import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocumentTools } from "./documents.js";
import * as boondClient from "../services/boond-client.js";

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

// Grab the handler registered for boond_documents_create.
function getHandler(server: McpServer) {
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === "boond_documents_create");
  if (!call) throw new Error("tool not registered");
  return call[2] as (params: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
}

describe("registerDocumentTools", () => {
  let server: McpServer;
  beforeEach(() => {
    server = createMockServer();
  });

  it("registers exactly one tool named boond_documents_create", () => {
    registerDocumentTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(server.registerTool).mock.calls[0][0]).toBe("boond_documents_create");
  });

  it("is a write tool: not readOnly, not destructive", () => {
    registerDocumentTools(server);
    const meta = vi.mocked(server.registerTool).mock.calls[0][1];
    expect(meta.annotations?.readOnlyHint).toBe(false);
    expect(meta.annotations?.destructiveHint).toBe(false);
  });
});

describe("boond_documents_create handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads via fileUrl and reports the created document id", async () => {
    const spy = vi.spyOn(boondClient, "uploadDocument").mockResolvedValue({
      data: { id: "29481_document", type: "document", attributes: { name: "cr.pdf" } },
    } as never);
    const server = createMockServer();
    registerDocumentTools(server);
    const handler = getHandler(server);

    const res = await handler({ parentType: "action", parentId: "12345", fileUrl: "https://x/cr.pdf" });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ parentType: "action", parentId: "12345", fileUrl: "https://x/cr.pdf" })
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("29481_document");
    expect(res.content[0].text).toContain("cr.pdf");
  });

  it("uploads via fileName + base64", async () => {
    const spy = vi.spyOn(boondClient, "uploadDocument").mockResolvedValue({
      data: { id: "1_document", type: "document", attributes: { name: "note.txt" } },
    } as never);
    const server = createMockServer();
    registerDocumentTools(server);
    const handler = getHandler(server);

    await handler({ parentType: "contact", parentId: "514", fileName: "note.txt", fileContentBase64: "aGVsbG8=" });

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ fileName: "note.txt", fileContentBase64: "aGVsbG8=" }));
  });

  it("rejects when no file source is provided (no API call)", async () => {
    const spy = vi.spyOn(boondClient, "uploadDocument").mockResolvedValue({ data: null } as never);
    const server = createMockServer();
    registerDocumentTools(server);
    const handler = getHandler(server);

    const res = await handler({ parentType: "action", parentId: "12345" });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects when both file sources are provided", async () => {
    const spy = vi.spyOn(boondClient, "uploadDocument").mockResolvedValue({ data: null } as never);
    const server = createMockServer();
    registerDocumentTools(server);
    const handler = getHandler(server);

    const res = await handler({
      parentType: "action",
      parentId: "1",
      fileUrl: "https://x/a.pdf",
      fileName: "a.pdf",
      fileContentBase64: "eA==",
    });
    expect(res.isError).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces upload errors as a readable isError result", async () => {
    vi.spyOn(boondClient, "uploadDocument").mockRejectedValue(new Error("BoondManager API 422 ..."));
    const server = createMockServer();
    registerDocumentTools(server);
    const handler = getHandler(server);

    const res = await handler({ parentType: "action", parentId: "1", fileUrl: "https://x/a.pdf" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("422");
  });
});
