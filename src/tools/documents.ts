import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocumentCreateSchema } from "../schemas/index.js";
import type { DocumentCreateInput } from "../schemas/index.js";
import { uploadDocument } from "../services/boond-client.js";
import type { JsonApiResource } from "../types.js";

// ---- Document upload tool (pièces jointes) ---------------------------------
//
// Wraps BoondManager's multipart `POST /documents` endpoint. The document is
// attached to its parent entity (action, candidate, contact, …) at creation
// time via parentType + parentId — no separate link step. Two file sources:
//   - fileUrl            : BoondManager fetches the URL itself (preferred).
//   - fileName + base64  : the bytes travel through the MCP server.
// Contract verified live against the prod API (v9.1.58.1).

const DOCUMENT_CREATE_DESCRIPTION = `Upload une pièce jointe dans BoondManager et la rattache à une entité (action, candidat, contact, société, opportunité, projet, ressource…).

Le document est lié à son entité parente dès la création via \`parentType\` + \`parentId\` (pas d'étape de liaison séparée). Après l'appel, la relation \`files\` de l'entité parente pointe sur le document créé.

Deux façons de fournir le fichier (exactement une) :
- \`fileUrl\` : URL publiquement accessible — BoondManager télécharge le fichier lui-même (recommandé, aucun binaire ne transite par le serveur MCP).
- \`fileName\` + \`fileContentBase64\` : le contenu du fichier encodé en base64 (à réserver aux petits fichiers).

Paramètres :
- \`parentType\` (requis) : type d'entité parente en minuscule (ex: \`action\`).
- \`parentId\` (requis) : ID numérique de l'entité parente (ex: l'ID de l'action — résoluble via \`boond_actions_search\`).
- \`fileUrl\` OU (\`fileName\` + \`fileContentBase64\`).

Returns : confirmation avec l'ID du document créé (format \`<n>_document\`) et son nom. Pour détacher, supprimer le document côté BoondManager.

Exemple : « Attache ce compte-rendu (URL) à l'action 12345 » → parentType="action", parentId="12345", fileUrl="https://…/cr.pdf".`;

function attrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

export function registerDocumentTools(server: McpServer): void {
  server.registerTool(
    "boond_documents_create",
    {
      title: "Uploader une pièce jointe et la lier à une entité",
      description: DOCUMENT_CREATE_DESCRIPTION,
      inputSchema: DocumentCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const p = params as DocumentCreateInput;

      // Source XOR : exactement une méthode de fourniture du fichier.
      const hasUrl = Boolean(p.fileUrl);
      const hasInline = Boolean(p.fileName && p.fileContentBase64);
      if (!hasUrl && !hasInline) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Fichier manquant : fournir soit `fileUrl`, soit `fileName` + `fileContentBase64`.",
            },
          ],
          isError: true,
        };
      }
      if (hasUrl && hasInline) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Ambiguïté : fournir `fileUrl` OU `fileName` + `fileContentBase64`, pas les deux.",
            },
          ],
          isError: true,
        };
      }
      if (p.fileName && !p.fileContentBase64) {
        return {
          content: [{ type: "text" as const, text: "`fileName` fourni sans `fileContentBase64`." }],
          isError: true,
        };
      }
      if (p.fileContentBase64 && !p.fileName) {
        return {
          content: [{ type: "text" as const, text: "`fileContentBase64` fourni sans `fileName`." }],
          isError: true,
        };
      }

      try {
        const resp = await uploadDocument({
          parentType: p.parentType,
          parentId: p.parentId,
          fileUrl: p.fileUrl,
          fileName: p.fileName,
          fileContentBase64: p.fileContentBase64,
        });
        const entity = Array.isArray(resp.data) ? resp.data[0] : resp.data;
        const docId = entity?.id ?? "(inconnu)";
        const name = entity ? (attrs(entity)["name"] as string | undefined) : undefined;
        const text = [
          `✅ Document attaché à ${p.parentType} #${p.parentId}.`,
          `   ID document : ${docId}${name ? ` · nom : ${name}` : ""}`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );
}
