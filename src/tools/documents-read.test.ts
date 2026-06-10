import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDocumentReadTools } from "./documents-read.js";
import * as boondClient from "../services/boond-client.js";
import * as pdf from "../services/pdf.js";
import { MAX_DOCUMENT_INLINE_READ_BYTES } from "../constants.js";

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

type Handler = (p: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string; resource?: { uri: string; mimeType: string; blob: string } }>;
}>;

function handlerFor(name: string): Handler {
  const server = createMockServer();
  registerDocumentReadTools(server);
  const call = vi.mocked(server.registerTool).mock.calls.find((c) => c[0] === name);
  return call![2] as Handler;
}

describe("registerDocumentReadTools", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("registers the 3 list tools + the get tool, all read-only", () => {
    const server = createMockServer();
    registerDocumentReadTools(server);
    const calls = vi.mocked(server.registerTool).mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toEqual([
      "boond_candidates_documents",
      "boond_resources_documents",
      "boond_actions_documents",
      "boond_documents_get",
    ]);
    for (const c of calls) expect(c[1].annotations?.readOnlyHint).toBe(true);
  });
});

describe("list documents", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("candidate: reads the MERGED base+/information fetch and aggregates resumes (CV) + files", async () => {
    // Regression: `resumes` is carried by /information, so the merged fetch is
    // required — a bare GET /candidates/{id} returns no resumes (the bug).
    const merged = vi.spyOn(boondClient, "fetchEntityWithInformation").mockResolvedValue({
      data: {
        id: "2123",
        type: "candidate",
        relationships: {
          resumes: {
            data: [
              { id: "1896_resume", type: "document" },
              { id: "10756_resume", type: "document" },
            ],
          },
          files: { data: [{ id: "55_document", type: "document" }] },
        },
      },
    } as never);

    const text = (await handlerFor("boond_candidates_documents")({ id: "2123" })).content[0].text!;
    expect(merged).toHaveBeenCalledWith("/candidates/2123");
    expect(text).toContain("3 pièce(s) jointe(s)");
    expect(text).toContain("1896_resume (CV)");
    expect(text).toContain("10756_resume (CV)");
    expect(text).toContain("55_document (pièce jointe)");
  });

  it("action: reads only the files relationship (merged fetch falls back to base)", async () => {
    const merged = vi.spyOn(boondClient, "fetchEntityWithInformation").mockResolvedValue({
      data: { id: "12345", type: "action", relationships: { files: { data: [{ id: "9_document" }] } } },
    } as never);
    const text = (await handlerFor("boond_actions_documents")({ id: "12345" })).content[0].text!;
    expect(merged).toHaveBeenCalledWith("/actions/12345");
    expect(text).toContain("9_document (pièce jointe)");
  });

  it("returns a clear message (not an error) when there is no attachment", async () => {
    vi.spyOn(boondClient, "fetchEntityWithInformation").mockResolvedValue({
      data: { id: "7", type: "resource", relationships: {} },
    } as never);
    const text = (await handlerFor("boond_resources_documents")({ id: "7" })).content[0].text!;
    expect(text).toMatch(/Aucune pièce jointe/);
  });
});

describe("boond_documents_get — hybrid read", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns the extracted text when the PDF has a text layer", async () => {
    vi.spyOn(boondClient, "fetchDocument").mockResolvedValue({
      buffer: Buffer.from("%PDF-1.4 ..."),
      fileName: "cv-thomas.pdf",
      contentType: "application/pdf",
    });
    const extract = vi.spyOn(pdf, "extractPdfText").mockResolvedValue("Thomas Berthemin — Analyste programmeur PHP");

    const res = await handlerFor("boond_documents_get")({ documentId: "1896_resume" });
    expect(extract).toHaveBeenCalled();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Contenu extrait");
    expect(res.content[0].text).toContain("Analyste programmeur PHP");
  });

  it("returns the PDF as an embedded resource when there is no text layer (scanned)", async () => {
    vi.spyOn(boondClient, "fetchDocument").mockResolvedValue({
      buffer: Buffer.from("scanned-bytes"),
      fileName: "scan.pdf",
      contentType: "application/pdf",
    });
    vi.spyOn(pdf, "extractPdfText").mockResolvedValue(""); // no text layer

    const res = await handlerFor("boond_documents_get")({ documentId: "2_document" });
    expect(res.content).toHaveLength(2);
    expect(res.content[1].type).toBe("resource");
    expect(res.content[1].resource?.mimeType).toBe("application/pdf");
    expect(res.content[1].resource?.blob).toBe(Buffer.from("scanned-bytes").toString("base64"));
  });

  it("does NOT inline a scanned PDF over the size cap — points to download", async () => {
    vi.spyOn(boondClient, "fetchDocument").mockResolvedValue({
      buffer: Buffer.alloc(MAX_DOCUMENT_INLINE_READ_BYTES + 1),
      fileName: "huge-scan.pdf",
      contentType: "application/pdf",
    });
    vi.spyOn(pdf, "extractPdfText").mockResolvedValue("");

    const res = await handlerFor("boond_documents_get")({ documentId: "3_document" });
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("/documents/download?documentId=3_document");
  });

  it("does not extract a non-PDF — returns metadata + download hint", async () => {
    vi.spyOn(boondClient, "fetchDocument").mockResolvedValue({
      buffer: Buffer.from("PK..."),
      fileName: "contrat.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const extract = vi.spyOn(pdf, "extractPdfText").mockResolvedValue("should not be called");

    const res = await handlerFor("boond_documents_get")({ documentId: "4_document" });
    expect(extract).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("n'est pas un PDF");
    expect(res.content[0].text).toContain("/documents/download?documentId=4_document");
  });

  it("surfaces a fetch error as isError without throwing", async () => {
    vi.spyOn(boondClient, "fetchDocument").mockRejectedValue(new Error("BoondManager API 404 Not Found"));
    const res = await handlerFor("boond_documents_get")({ documentId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("404");
  });
});
