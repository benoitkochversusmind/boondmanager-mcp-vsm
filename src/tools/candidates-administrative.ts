import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateAdministrativeUpdateSchema } from "../schemas/index.js";
import type { CandidateAdministrativeUpdateInput } from "../schemas/index.js";
import { apiRequest, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import type { JsonApiResource, JsonApiResponse } from "../types.js";

// ---- Candidate availability / mobility / administrative write tool ----------
//
// Makes writable the candidate profile fields the generic update can't reach:
//   - base attributes : availability, mobilityAreas (setting.mobilityArea, hierarchical)
//   - administrative  : salaries (actual / desired{min,max}), average daily costs,
//                       desiredContract (setting.typeOf.contract), situation
//                       (setting.situation), nationality, birth, comments.
//
// Write routing (verified in prod — PATCH /candidates/{id} returns 405):
//   - base attributes        → PUT /candidates/{id}
//   - administrative subset   → PUT /candidates/{id}/administrative (sub-resource)
//
// Label→id resolution (accent/case-insensitive) for mobilityAreas / desiredContract
// / situation; any unresolved label is a blocking error (no partial write), like
// the technical-data tool.
//
// Still prod-validate: `availability` format (date), and `mobilityAreas` write
// shape — sent as a flat id array (like activityAreas); switch to
// `{ mobilityArea: id }` objects in buildArray-equivalent below if 1017 occurs.

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

interface DictEntry {
  id: string | number;
  value?: string;
  isEnabled?: boolean;
  option?: unknown[];
}

interface Resolver {
  resolve(label: string): string | number | undefined;
}

function buildResolver(entries: DictEntry[]): Resolver {
  const byId = new Map<string, string | number>();
  const byValue = new Map<string, string | number>();
  for (const e of entries) {
    if (!e || e.isEnabled === false || e.id === undefined || e.id === null) continue;
    byId.set(norm(String(e.id)), e.id);
    if (typeof e.value === "string") byValue.set(norm(e.value), e.id);
  }
  return {
    resolve(label: string) {
      const n = norm(label);
      return byId.get(n) ?? byValue.get(n);
    },
  };
}

/** Flatten the hierarchical mobilityArea dict: keep both region nodes and their
 *  `.option[]` leaves so a label matches at either level. */
function flattenMobility(node: unknown): DictEntry[] {
  if (!Array.isArray(node)) return [];
  const out: DictEntry[] = [];
  for (const region of node) {
    if (!region || typeof region !== "object") continue;
    out.push(region as DictEntry);
    const opts = (region as DictEntry).option;
    if (Array.isArray(opts)) for (const o of opts) if (o && typeof o === "object") out.push(o as DictEntry);
  }
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export interface AdministrativeUpdateResult {
  response: JsonApiResponse;
  applied: string[];
}

/**
 * Core logic. Resolves labels → ids, merges salary bounds with the current
 * administrative payload, then PATCHes /candidates/{id}. Throws (no write) on
 * any unresolved label.
 */
export async function updateCandidateAdministrative(
  input: CandidateAdministrativeUpdateInput
): Promise<AdministrativeUpdateResult> {
  const dict = await getDictionary();
  const mobilityResolver = buildResolver(flattenMobility(resolveDictionaryPath(dict.payload, "setting.mobilityArea")));
  const contractResolver = buildResolver(
    asArray(resolveDictionaryPath(dict.payload, "setting.typeOf.contract")) as DictEntry[]
  );
  const situationResolver = buildResolver(
    asArray(resolveDictionaryPath(dict.payload, "setting.situation")) as DictEntry[]
  );

  const rejected: string[] = [];

  let mobilityIds: string[] | undefined;
  if (input.mobilityAreas) {
    mobilityIds = [];
    for (const label of input.mobilityAreas) {
      const id = mobilityResolver.resolve(label);
      if (id === undefined) rejected.push(`mobilityAreas: "${label}"`);
      else mobilityIds.push(String(id));
    }
  }
  let desiredContractId: number | undefined;
  if (input.desiredContract !== undefined) {
    const r = contractResolver.resolve(input.desiredContract);
    if (r === undefined) rejected.push(`desiredContract: "${input.desiredContract}"`);
    else desiredContractId = Number(r);
  }
  let situationId: number | undefined;
  if (input.situation !== undefined) {
    const r = situationResolver.resolve(input.situation);
    if (r === undefined) rejected.push(`situation: "${input.situation}"`);
    else situationId = Number(r);
  }

  if (rejected.length > 0) {
    throw new Error(
      `Libellé(s) non résolu(s) — aucune écriture effectuée. Vérifiez l'orthographe ou utilisez ` +
        `boond_application_dictionary (setting.mobilityArea / setting.typeOf.contract / setting.situation).\n  - ` +
        `${rejected.join("\n  - ")}`
    );
  }

  // Read current administrative payload — needed to preserve the untouched bound
  // of a salary/TJM range when only one of min/max is provided.
  const current = await apiRequest(`/candidates/${input.candidateId}/administrative`, "GET");
  const curEntity = (Array.isArray(current.data) ? current.data[0] : current.data) as JsonApiResource | undefined;
  const cur = (curEntity?.attributes ?? {}) as Record<string, unknown>;

  function rangeMerge(
    curRange: unknown,
    min: number | undefined,
    max: number | undefined
  ): { min: number; max: number } | undefined {
    if (min === undefined && max === undefined) return undefined;
    const c = asObj(curRange);
    return {
      min: min ?? (typeof c["min"] === "number" ? (c["min"] as number) : 0),
      max: max ?? (typeof c["max"] === "number" ? (c["max"] as number) : 0),
    };
  }

  const attrs: Record<string, unknown> = {};
  const applied: string[] = [];
  const set = (key: string, value: unknown, label = key): void => {
    attrs[key] = value;
    applied.push(label);
  };

  if (input.availability !== undefined) set("availability", input.availability);
  if (mobilityIds) set("mobilityAreas", mobilityIds, `mobilityAreas (${mobilityIds.length})`);
  if (input.actualSalary !== undefined) set("actualSalary", input.actualSalary);
  const desiredSalary = rangeMerge(cur["desiredSalary"], input.desiredSalaryMin, input.desiredSalaryMax);
  if (desiredSalary) set("desiredSalary", desiredSalary);
  if (input.actualAverageDailyCost !== undefined) set("actualAverageDailyCost", input.actualAverageDailyCost);
  const desiredAdc = rangeMerge(
    cur["desiredAverageDailyCost"],
    input.desiredAverageDailyCostMin,
    input.desiredAverageDailyCostMax
  );
  if (desiredAdc) set("desiredAverageDailyCost", desiredAdc);
  if (desiredContractId !== undefined)
    set("desiredContract", desiredContractId, `desiredContract (${desiredContractId})`);
  if (situationId !== undefined) set("situation", situationId, `situation (${situationId})`);
  if (input.nationality !== undefined) set("nationality", input.nationality);
  if (input.dateOfBirth !== undefined) set("dateOfBirth", input.dateOfBirth);
  if (input.placeOfBirth !== undefined) set("placeOfBirth", input.placeOfBirth);
  if (input.healthCareNumber !== undefined) set("healthCareNumber", input.healthCareNumber);
  if (input.administrativeComments !== undefined) set("administrativeComments", input.administrativeComments);

  if (Object.keys(attrs).length === 0) {
    throw new Error(
      "Rien à mettre à jour : fournir au moins un champ (availability, mobilityAreas, salaires, desiredContract, situation, …)."
    );
  }

  // Route each field to its write target — verified in prod: PATCH /candidates
  // is rejected (405), so we use PUT, and the administrative attributes live on
  // the dedicated sub-resource:
  //   - base attributes (availability, mobilityAreas) → PUT /candidates/{id}
  //   - administrative attributes                     → PUT /candidates/{id}/administrative
  // (Fallback if the admin sub-resource PUT is ever rejected: send adminAttrs to
  //  PUT /candidates/{id} as well — the administrative payload is the candidate.)
  const BASE_KEYS = new Set(["availability", "mobilityAreas"]);
  const baseAttrs: Record<string, unknown> = {};
  const adminAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) (BASE_KEYS.has(k) ? baseAttrs : adminAttrs)[k] = v;

  const id = input.candidateId;
  let response: JsonApiResponse | undefined;
  if (Object.keys(baseAttrs).length > 0) {
    response = await apiRequest(`/candidates/${id}`, "PUT", buildJsonApiBody("candidate", baseAttrs, id));
  }
  if (Object.keys(adminAttrs).length > 0) {
    response = await apiRequest(
      `/candidates/${id}/administrative`,
      "PUT",
      buildJsonApiBody("candidate", adminAttrs, id)
    );
  }
  return { response: response as JsonApiResponse, applied };
}

const DESCRIPTION = `Met à jour la **disponibilité**, la **mobilité** et les **données administratives** d'un candidat (champs non couverts par boond_candidates_update).

Paramètres :
- \`candidateId\` (requis).
- \`availability\` : date de disponibilité (YYYY-MM-DD).
- \`mobilityAreas\` (string[]) : zones de mobilité, libellés OU ids \`setting.mobilityArea\` (hiérarchique régions › villes). Remplace la liste existante.
- \`actualSalary\`, \`desiredSalaryMin\`/\`desiredSalaryMax\` : salaire annuel actuel / souhaité (fourchette).
- \`actualAverageDailyCost\`, \`desiredAverageDailyCostMin\`/\`Max\` : TJM actuel / souhaité.
- \`desiredContract\` : contrat souhaité, libellé OU id \`setting.typeOf.contract\` (CDI, CDD, Freelance…).
- \`situation\` : situation familiale, libellé OU id \`setting.situation\`.
- \`nationality\`, \`dateOfBirth\`, \`placeOfBirth\`, \`healthCareNumber\`, \`administrativeComments\`.

Résolution libellé→id insensible casse/accents (mobilité / contrat / situation). **Tout libellé non résolu est une erreur bloquante** (aucune écriture partielle). Seuls les champs fournis sont modifiés ; pour une fourchette, la borne non fournie est préservée. Écriture : PUT /candidates/{id}/administrative (administratif) et/ou PUT /candidates/{id} (disponibilité, mobilité).`;

export function registerCandidateAdministrativeTools(server: McpServer): void {
  server.registerTool(
    "boond_candidates_administrative_update",
    {
      title: "Modifier disponibilité / mobilité / administratif d'un candidat",
      description: DESCRIPTION,
      inputSchema: CandidateAdministrativeUpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const { response, applied } = await updateCandidateAdministrative(params as CandidateAdministrativeUpdateInput);
        const text = [
          `✅ Candidat #${(params as CandidateAdministrativeUpdateInput).candidateId} mis à jour.`,
          `   Champs : ${applied.join(", ") || "(aucun)"}`,
          "",
          formatDetailResponse(response),
        ].join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }
  );
}
