import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IdSchema, DocumentGetSchema } from "../schemas/index.js";
import type { DocumentGetInput } from "../schemas/index.js";
import { apiRequest, fetchDocument } from "../services/boond-client.js";
import { extractPdfText } from "../services/pdf.js";
import { MAX_DOCUMENT_INLINE_READ_BYTES } from "../constants.js";
import type { JsonApiResource } from "../types.js";

// ---- Read / list candidate, resource & action attachments -------------------
//
// BoondManager exposes attachments through per-kind JSON:API relationships on
// the parent entity (verified live), NOT a `/documents` tab (which 404s):
//   - relationships.resumes → CVs        (composite id `<n>_resume`)
//   - relationships.files   → attachments (composite id `<n>_document`)
// The binary is fetched via GET /documents/{compositeId} (see fetchDocument).

/** Human label for a document, derived from its composite-id suffix. */
function docKind(id: string): string {
  const suffix = id.includes("_") ? id.slice(id.lastIndexOf("_") + 1) : "";
  switch (suffix) {
    case "resume":
      return "CV";
    case "document":
      return "pièce jointe";
    default:
      return suffix || "document";
  }
}

interface DocRef {
  id: string;
  kind: string;
}

/** Collect document refs from the given relationships of a parent entity. */
function collectDocs(entity: JsonApiResource | undefined, rels: string[]): DocRef[] {
  const out: DocRef[] = [];
  const relationships = (entity?.relationships ?? {}) as Record<string, { data?: unknown } | undefined>;
  for (const rel of rels) {
    const data = relationships[rel]?.data;
    const arr = Array.isArray(data) ? data : data ? [data] : [];
    for (const d of arr) {
      const id = (d as { id?: unknown } | null)?.id;
      if (id !== undefined && id !== null) out.push({ id: String(id), kind: docKind(String(id)) });
    }
  }
  return out;
}

async function listDocuments(apiPath: string, id: string, rels: string[], entityLabel: string): Promise<string> {
  const resp = await apiRequest(`${apiPath}/${id}`, "GET");
  const entity = (Array.isArray(resp.data) ? resp.data[0] : resp.data) as JsonApiResource | undefined;
  const docs = collectDocs(entity, rels);
  if (docs.length === 0) {
    return `Aucune pièce jointe trouvée sur ${entityLabel} #${id}.`;
  }
  return [
    `${docs.length} pièce(s) jointe(s) sur ${entityLabel} #${id} :`,
    ...docs.map((d) => `  - ${d.id} (${d.kind})`),
    "",
    "Lire le contenu : boond_documents_get(documentId). " +
      "Télécharger : GET /documents/download?documentId=<id> (endpoint hors-bande, auth Bearer).",
  ].join("\n");
}

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
  >;
  isError?: boolean;
};

/** Hybrid read: PDF text layer if present, else hand the raw PDF to the model. */
async function readDocument(documentId: string): Promise<ToolResult> {
  const { buffer, fileName, contentType } = await fetchDocument(documentId);
  const sizeKb = Math.round(buffer.length / 1024);
  const header = `Document ${documentId} · ${fileName} · ${sizeKb} Ko · ${contentType}`;
  const isPdf = contentType.toLowerCase().includes("pdf") || fileName.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return {
      content: [
        {
          type: "text",
          text:
            `${header}\n\nLe fichier n'est pas un PDF — pas d'extraction de texte. ` +
            `Téléchargez-le : GET /documents/download?documentId=${documentId}.`,
        },
      ],
    };
  }

  const text = await extractPdfText(buffer);
  if (text.length >= 20) {
    return { content: [{ type: "text", text: `${header}\n\n--- Contenu extrait ---\n${text}` }] };
  }

  // No usable text layer (scanned / image-only). Hand the raw PDF to the model,
  // unless it's too large to inline — then point to the download endpoint.
  if (buffer.length <= MAX_DOCUMENT_INLINE_READ_BYTES) {
    return {
      content: [
        {
          type: "text",
          text: `${header}\n\nPas de couche texte extractible (PDF probablement scanné) — le PDF est renvoyé ci-dessous pour lecture directe.`,
        },
        {
          type: "resource",
          resource: {
            uri: `boond://documents/${documentId}`,
            mimeType: "application/pdf",
            blob: buffer.toString("base64"),
          },
        },
      ],
    };
  }
  const capMb = Math.round(MAX_DOCUMENT_INLINE_READ_BYTES / 1024 / 1024);
  return {
    content: [
      {
        type: "text",
        text:
          `${header}\n\nPDF sans couche texte et trop volumineux pour une lecture inline (> ${capMb} Mo). ` +
          `Téléchargez-le : GET /documents/download?documentId=${documentId}.`,
      },
    ],
  };
}

const DOCUMENT_GET_DESCRIPTION = `Lit le contenu d'une pièce jointe BoondManager (PDF) par son ID composite (ex: '1896_resume', '12345_document').

Stratégie hybride : si le PDF a une couche texte, renvoie le **texte extrait** ; sinon (PDF scanné/image) renvoie le **PDF lui-même** pour lecture directe par le modèle (plafonné à ${Math.round(
  MAX_DOCUMENT_INLINE_READ_BYTES / 1024 / 1024
)} Mo ; au-delà, pointe vers le téléchargement). Fichier non-PDF : renvoie la métadonnée + le lien de téléchargement (pas d'extraction).

Pour obtenir l'ID d'un document : boond_candidates_documents / boond_resources_documents / boond_actions_documents (liste les CV et pièces jointes de l'entité).

Pour télécharger le binaire : endpoint hors-bande GET /documents/download?documentId=<id> (auth Bearer, jusqu'à 15 Mo).`;

export function registerDocumentReadTools(server: McpServer): void {
  const listTools: Array<{ name: string; title: string; apiPath: string; rels: string[]; label: string }> = [
    {
      name: "boond_candidates_documents",
      title: "Lister les pièces jointes d'un candidat",
      apiPath: "/candidates",
      rels: ["resumes", "files"],
      label: "candidat",
    },
    {
      name: "boond_resources_documents",
      title: "Lister les pièces jointes d'une ressource",
      apiPath: "/resources",
      rels: ["resumes", "files"],
      label: "ressource",
    },
    {
      name: "boond_actions_documents",
      title: "Lister les pièces jointes d'une action",
      apiPath: "/actions",
      rels: ["files"],
      label: "action",
    },
  ];

  for (const t of listTools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: `Liste les pièces jointes (CV + documents) rattachées à ${t.label === "action" ? "une" : t.label === "ressource" ? "une" : "un"} ${t.label}, via les relations ${t.rels.join(" / ")}. Renvoie l'ID composite + la nature de chaque document. Utiliser ensuite boond_documents_get pour lire le contenu.`,
        inputSchema: IdSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (params) => {
        try {
          const { id } = params as { id: string };
          const text = await listDocuments(t.apiPath, id, t.rels, t.label);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      }
    );
  }

  server.registerTool(
    "boond_documents_get",
    {
      title: "Lire le contenu d'une pièce jointe (PDF)",
      description: DOCUMENT_GET_DESCRIPTION,
      inputSchema: DocumentGetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        return await readDocument((params as DocumentGetInput).documentId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );
}
