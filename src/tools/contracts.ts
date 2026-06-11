import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IdSchema } from "../schemas/index.js";
import { apiRequest, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";

// ---- Employment contracts (post-embauche, côté ressource) -------------------
//
// A contract is carried by a RESOURCE via the polymorphic `dependsOn` relation
// (type `resource`) — NOT `relationships.resource`, which the API ignores (same
// class of bug fixed on positionings: "1017 Missing required attribute dependsOn").
// `typeOf` accepts a label or id resolved against setting.typeOf.contract.

const CONTRACT_FIELDS = {
  startDate: z.string().optional().describe("Date de début (YYYY-MM-DD)"),
  endDate: z.string().optional().describe("Date de fin (YYYY-MM-DD, vide si CDI)"),
  classification: z
    .string()
    .optional()
    .describe("Classification / coefficient (texte, ex: 'Position 2.2 - Coefficient 130')"),
  monthlySalary: z.number().optional().describe("Salaire mensuel brut"),
  hourlySalary: z.number().optional().describe("Salaire horaire"),
  numberOfHoursPerWeek: z.number().optional().describe("Nombre d'heures par semaine"),
  employeeType: z.number().int().optional().describe("Type d'employé (id dictionnaire ; ex: cadre/non-cadre)"),
  workingTimeType: z.number().int().optional().describe("Type de temps de travail (id dictionnaire)"),
  probationState: z.number().int().optional().describe("État de la période d'essai (id dictionnaire)"),
  informationComments: z.string().optional().describe("Commentaires"),
} as const;

const ContractCreateSchema = z
  .object({
    resourceId: z
      .string()
      .min(1)
      .describe("ID de la ressource (collaborateur) titulaire du contrat — relation dependsOn (type resource)."),
    typeOf: z
      .string()
      .optional()
      .describe(
        "Type de contrat : libellé OU id setting.typeOf.contract (CDI, CDD, Sous-traitant, Freelance, Stage, Contrat pro, Contrat d'apprentissage)."
      ),
    ...CONTRACT_FIELDS,
  })
  .strict();

const ContractUpdateSchema = z
  .object({
    id: z.string().min(1).describe("ID du contrat à modifier"),
    typeOf: z.string().optional().describe("Type de contrat : libellé OU id setting.typeOf.contract."),
    ...CONTRACT_FIELDS,
  })
  .strict();

/** Normalize for accent/case-insensitive matching. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Resolve a contract type label/id to its integer id via setting.typeOf.contract. */
async function resolveContractType(label: string): Promise<number | undefined> {
  const dict = await getDictionary();
  const entries = resolveDictionaryPath(dict.payload, "setting.typeOf.contract");
  if (!Array.isArray(entries)) return undefined;
  const n = norm(label);
  for (const e of entries as Array<{ id?: unknown; value?: unknown; isEnabled?: boolean }>) {
    if (!e || e.isEnabled === false || e.id === undefined || e.id === null) continue;
    if (norm(String(e.id)) === n || (typeof e.value === "string" && norm(e.value) === n)) return Number(e.id);
  }
  return undefined;
}

/** Build the contract attribute bag from params, resolving `typeOf` to its id. */
async function buildContractAttrs(
  params: Record<string, unknown>,
  exclude: string[]
): Promise<Record<string, unknown>> {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (exclude.includes(k) || v === undefined) continue;
    if (k === "typeOf") {
      const id = await resolveContractType(String(v));
      if (id === undefined) {
        throw new Error(
          `Type de contrat non résolu : "${String(v)}". Utilisez un libellé/id de setting.typeOf.contract ` +
            `(CDI, CDD, Sous-traitant, Freelance, Stage, Contrat pro, Contrat d'apprentissage).`
        );
      }
      attrs["typeOf"] = id;
    } else {
      attrs[k] = v;
    }
  }
  return attrs;
}

export function registerContractTools(server: McpServer): void {
  server.registerTool(
    "boond_contracts_get",
    {
      title: "Détails d'un contrat",
      description: `Récupère les informations détaillées d'un contrat de travail par son ID.`,
      inputSchema: IdSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const response = await apiRequest(`/contracts/${params.id}`);
      return { content: [{ type: "text" as const, text: formatDetailResponse(response) }] };
    }
  );

  server.registerTool(
    "boond_contracts_create",
    {
      title: "Créer un contrat de travail",
      description: `Crée un contrat de travail (post-embauche) rattaché à une **ressource** via la relation dependsOn.

Paramètres : \`resourceId\` (requis), \`typeOf\` (libellé/id setting.typeOf.contract), \`startDate\`/\`endDate\`, \`classification\`, \`monthlySalary\`/\`hourlySalary\`, \`numberOfHoursPerWeek\`, \`employeeType\`, \`workingTimeType\`, \`probationState\`, \`informationComments\`.`,
      inputSchema: ContractCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (params) => {
      try {
        const p = params as Record<string, unknown>;
        const resourceId = p.resourceId as string;
        const attrs = await buildContractAttrs(p, ["resourceId"]);
        const body = buildJsonApiBody("contract", attrs) as { data: Record<string, unknown> };
        body.data.relationships = { dependsOn: { data: { id: resourceId, type: "resource" } } };
        const response = await apiRequest("/contracts", "POST", body);
        const entity = Array.isArray(response.data) ? response.data[0] : response.data;
        return {
          content: [
            { type: "text" as const, text: `✅ Contrat créé (ID ${entity?.id}).\n\n${formatDetailResponse(response)}` },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );

  server.registerTool(
    "boond_contracts_update",
    {
      title: "Modifier un contrat de travail",
      description: `Met à jour un contrat de travail existant via PUT /contracts/{id}. Seuls les champs fournis sont modifiés.

Paramètres : \`id\` (requis), \`typeOf\` (libellé/id), \`startDate\`/\`endDate\`, \`classification\`, \`monthlySalary\`/\`hourlySalary\`, \`numberOfHoursPerWeek\`, \`employeeType\`, \`workingTimeType\`, \`probationState\`, \`informationComments\`.`,
      inputSchema: ContractUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const p = params as Record<string, unknown>;
        const id = p.id as string;
        const attrs = await buildContractAttrs(p, ["id"]);
        if (Object.keys(attrs).length === 0) {
          return {
            content: [{ type: "text" as const, text: "Rien à mettre à jour : fournir au moins un champ." }],
            isError: true,
          };
        }
        const body = buildJsonApiBody("contract", attrs, id);
        const response = await apiRequest(`/contracts/${id}`, "PUT", body);
        return {
          content: [
            { type: "text" as const, text: `✅ Contrat #${id} mis à jour.\n\n${formatDetailResponse(response)}` },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );
}
