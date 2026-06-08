import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocumentCreateSchema } from "../schemas/index.js";
import type { DocumentCreateInput } from "../schemas/index.js";
import { uploadDocument } from "../services/boond-client.js";
import { MAX_DOCUMENT_BASE64_CHARS } from "../constants.js";
import type { JsonApiResource } from "../types.js";

// ---- Document upload tool (pièces jointes) ---------------------------------
//
// Wraps BoondManager's multipart `POST /documents` endpoint. The document is
// attached to its parent entity (action, candidate, contact, …) at creation
// time via parentType + parentId — no separate link step.
//
// File sources, by reliability for large files (Boond caps at 15 Mo) :
//   - fileUrl              : BoondManager fetches the URL itself — bytes touch
//                            neither the LLM nor our server. SAS/token URLs work.
//   - HTTP upload endpoint : POST /documents/upload (out-of-band, multi-Mo) —
//                            for local files in Cowork ; bytes never go through
//                            the model. See index.ts.
//   - fileContentBase64    : inline, but CAPPED (~1 Mo base64 / ~750 Ko file)
//                            because the model must regenerate the whole string.
// Contract verified live against the prod API (v9.1.58.1).

const DOCUMENT_CREATE_DESCRIPTION = `Upload une pièce jointe dans BoondManager et la rattache à une entité (action, candidat, contact, société, opportunité, projet, ressource…).

Le document est lié à son entité parente dès la création via \`parentType\` + \`parentId\` (pas d'étape de liaison séparée). Après l'appel, la relation \`files\` de l'entité parente pointe sur le document créé.

Façons de fournir le fichier (exactement une), de la plus fiable pour les gros fichiers à la plus limitée :
- \`fileUrl\` : URL accessible par BoondManager (lien public OU pré-signé/SAS, ex: lien de partage SharePoint) — Boond télécharge le fichier lui-même, aucun binaire ne transite par le LLM ni par le serveur MCP. **Idéal pour les fichiers de plusieurs Mo.**
- \`fileName\` + \`fileContentBase64\` : contenu encodé en base64, **plafonné à ~750 Ko de fichier** (~1 Mo de base64). Au-delà, le tool refuse et renvoie vers l'endpoint d'upload ou \`fileUrl\` (sinon l'argument est tronqué par la limite de tokens du modèle).

Pour un fichier local volumineux (jusqu'à 15 Mo, plafond Boond), utiliser l'endpoint hors-bande \`POST /documents/upload\` (multipart, auth Bearer) qui forwarde directement vers Boond — voir la doc technique.

Paramètres : \`parentType\` (requis, minuscule, ex: \`action\`), \`parentId\` (requis), puis \`fileUrl\` OU (\`fileName\` + \`fileContentBase64\`).

Returns : ID du document créé (\`<n>_document\`) + son nom. Pour détacher, supprimer le document côté BoondManager.`;

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
      // Hard cap on the inline base64 path: beyond the model's output-token
      // budget the argument is silently truncated → corrupt file. Refuse early
      // and point to the robust out-of-band channels.
      if (p.fileContentBase64 && p.fileContentBase64.length > MAX_DOCUMENT_BASE64_CHARS) {
        const kb = Math.round((p.fileContentBase64.length * 3) / 4 / 1024);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Fichier trop volumineux pour le mode base64 (~${kb} Ko ; limite ~750 Ko). ` +
                "Utilisez plutôt `fileUrl` (lien public ou SAS/SharePoint, jusqu'à 15 Mo) " +
                "ou l'endpoint d'upload hors-bande `POST /documents/upload` (fichier local en Cowork).",
            },
          ],
          isError: true,
        };
      }

      try {
        const resp = await uploadDocument({
          parentType: p.parentType,
          parentId: p.parentId,
          fileUrl: p.fileUrl,
          fileName: p.fileName,
          fileBuffer: p.fileContentBase64 ? Buffer.from(p.fileContentBase64, "base64") : undefined,
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
