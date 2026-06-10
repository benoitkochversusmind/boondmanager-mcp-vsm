import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateTechnicalDataUpdateSchema } from "../schemas/index.js";
import type { CandidateTechnicalDataUpdateInput } from "../schemas/index.js";
import { apiRequest, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import { getDictionary, resolveDictionaryPath } from "../services/dictionary.js";
import type { JsonApiResponse, JsonApiResource } from "../types.js";

// ---- Candidate technical-data (Dossier Technique) write tool ----------------
//
// Updates a candidate's "Dossier Technique" (DT): tools, activity areas,
// expertise sectors, skills, experience, languages. Label→id resolution is
// done against the live BoondManager dictionaries (accent/case-insensitive),
// and ANY unresolved label is a hard error — no partial write.
//
// Verified live shapes:
//   - GET /candidates/{id}/technical-data → attributes.tdId (the DT id).
//   - PUT envelope resource type is `technicaldata` (GET /technical-datas/{id}).
//   - setting.tool          : flat list {id,value,isEnabled}.
//   - setting.activityArea  : hierarchical (groups with .option[] leaves) → flatten on leaves.
//   - setting.expertiseArea : restricted to the S1–S12 codified set (value matches /\[S\d+\]/) ;
//                             historical non-S entries are rejected (not resolvable).
//   - setting.experience    : flat list {id:number,value}.
//   - DT arrays (tools/activityAreas/expertiseAreas) are arrays of plain string ids,
//     but we detect the existing element shape and align to it ({id} objects vs strings).

const S_CODE_RE = /\[S\d+\]/;

/** Accent + case insensitive normalization for forgiving label matching. */
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

/** A label→id resolver built from a dictionary node. Matches id exact OR value (normalized). */
interface Resolver {
  resolve(label: string): string | number | undefined;
}

function buildResolver(entries: DictEntry[]): Resolver {
  const byNormValue = new Map<string, string | number>();
  const byNormId = new Map<string, string | number>();
  for (const e of entries) {
    if (!e || e.isEnabled === false) continue;
    if (e.id === undefined || e.id === null) continue;
    byNormId.set(norm(String(e.id)), e.id);
    if (typeof e.value === "string") byNormValue.set(norm(e.value), e.id);
  }
  return {
    resolve(label: string) {
      const n = norm(label);
      return byNormId.get(n) ?? byNormValue.get(n);
    },
  };
}

/** Flatten the hierarchical activityArea dictionary onto its leaves (group.option[]). */
function flattenActivityAreas(node: unknown): DictEntry[] {
  if (!Array.isArray(node)) return [];
  const leaves: DictEntry[] = [];
  for (const group of node) {
    if (!group || typeof group !== "object") continue;
    const opts = (group as DictEntry).option;
    if (Array.isArray(opts)) {
      for (const o of opts) if (o && typeof o === "object") leaves.push(o as DictEntry);
    }
  }
  return leaves;
}

/** Keep only the S1–S12 codified expertise sectors (value contains "[Sn]"). */
function sCodedExpertise(node: unknown): DictEntry[] {
  if (!Array.isArray(node)) return [];
  return (node as DictEntry[]).filter((e) => e && typeof e.value === "string" && S_CODE_RE.test(e.value));
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Merge (union, dedup) or replace a DT id-array, preserving the EXISTING element
 * shape: if the current array holds `{id}` objects, emit objects; otherwise emit
 * plain string ids. `newIds` are always string ids resolved from the dictionary.
 */
function buildArray(existing: unknown[], newIds: string[], mode: "merge" | "replace"): unknown[] {
  const objectShape = existing.length > 0 && typeof existing[0] === "object" && existing[0] !== null;
  const existingIds = existing.map((e) => (objectShape ? String((e as { id?: unknown }).id) : String(e)));
  const finalIds = mode === "replace" ? [...newIds] : Array.from(new Set([...existingIds, ...newIds]));
  return objectShape ? finalIds.map((id) => ({ id })) : finalIds;
}

export interface TechnicalDataUpdateResult {
  response: JsonApiResponse;
  tdId: string;
  applied: string[];
}

/**
 * Core, reusable logic. Resolves labels → ids, reads the current DT, applies
 * merge/replace, and PUTs `/technical-datas/{tdId}`. Throws on any unresolved
 * label (with the explicit list) before performing any write.
 */
export async function updateCandidateTechnicalData(
  input: CandidateTechnicalDataUpdateInput
): Promise<TechnicalDataUpdateResult> {
  const mode = input.mode ?? "merge";

  // 1. Load dictionaries once and build resolvers.
  const dict = await getDictionary();
  const toolResolver = buildResolver(asArray(resolveDictionaryPath(dict.payload, "setting.tool")) as DictEntry[]);
  const activityResolver = buildResolver(
    flattenActivityAreas(resolveDictionaryPath(dict.payload, "setting.activityArea"))
  );
  const expertiseResolver = buildResolver(
    sCodedExpertise(resolveDictionaryPath(dict.payload, "setting.expertiseArea"))
  );
  const experienceResolver = buildResolver(
    asArray(resolveDictionaryPath(dict.payload, "setting.experience")) as DictEntry[]
  );

  // 2. Resolve every provided label; collect unresolved per field (no silent drop).
  const unresolved: string[] = [];
  function resolveAll(labels: string[] | undefined, resolver: Resolver, field: string): string[] {
    if (!labels) return [];
    const ids: string[] = [];
    for (const label of labels) {
      const id = resolver.resolve(label);
      if (id === undefined) unresolved.push(`${field}: "${label}"`);
      else ids.push(String(id));
    }
    return ids;
  }
  const toolIds = resolveAll(input.tools, toolResolver, "tools");
  const activityIds = resolveAll(input.activityAreas, activityResolver, "activityAreas");
  const expertiseIds = resolveAll(input.expertiseAreas, expertiseResolver, "expertiseAreas");

  let experienceId: number | undefined;
  if (input.experience !== undefined) {
    const r = experienceResolver.resolve(input.experience);
    if (r === undefined) unresolved.push(`experience: "${input.experience}"`);
    else experienceId = Number(r);
  }

  if (unresolved.length > 0) {
    throw new Error(
      `Libellé(s) non résolu(s) — aucune écriture effectuée. Vérifiez l'orthographe ou utilisez ` +
        `boond_application_dictionary (setting.tool / setting.activityArea / setting.expertiseArea — ` +
        `secteurs restreints à S1–S12 / setting.experience).\n  - ${unresolved.join("\n  - ")}`
    );
  }

  // 3. Resolve tdId, then read the current DT (for merge union + element-shape detection).
  const tdLookup = await apiRequest(`/candidates/${input.candidateId}/technical-data`, "GET");
  const tdEntity = Array.isArray(tdLookup.data) ? tdLookup.data[0] : tdLookup.data;
  const tdId = (tdEntity?.attributes as Record<string, unknown> | undefined)?.["tdId"];
  if (tdId === undefined || tdId === null) {
    throw new Error(`Dossier technique introuvable pour le candidat #${input.candidateId} (attribut tdId absent).`);
  }
  const tdIdStr = String(tdId);

  const current = await apiRequest(`/technical-datas/${tdIdStr}`, "GET");
  const currentEntity = (Array.isArray(current.data) ? current.data[0] : current.data) as JsonApiResource | undefined;
  const cur = (currentEntity?.attributes ?? {}) as Record<string, unknown>;

  // 4. Build the attributes to write (only fields the caller touched).
  const attrs: Record<string, unknown> = {};
  const applied: string[] = [];
  if (input.tools) {
    attrs["tools"] = buildArray(asArray(cur["tools"]), toolIds, mode);
    applied.push(`tools (${(attrs["tools"] as unknown[]).length})`);
  }
  if (input.activityAreas) {
    attrs["activityAreas"] = buildArray(asArray(cur["activityAreas"]), activityIds, mode);
    applied.push(`activityAreas (${(attrs["activityAreas"] as unknown[]).length})`);
  }
  if (input.expertiseAreas) {
    attrs["expertiseAreas"] = buildArray(asArray(cur["expertiseAreas"]), expertiseIds, mode);
    applied.push(`expertiseAreas (${(attrs["expertiseAreas"] as unknown[]).length})`);
  }
  if (input.languages) {
    const existing = asArray(cur["languages"]).map((x) => String(x));
    attrs["languages"] =
      mode === "replace" ? [...input.languages] : Array.from(new Set([...existing, ...input.languages]));
    applied.push(`languages (${(attrs["languages"] as unknown[]).length})`);
  }
  if (input.skills !== undefined) {
    attrs["skills"] = input.skills;
    applied.push("skills");
  }
  if (experienceId !== undefined) {
    attrs["experience"] = experienceId;
    applied.push(`experience (${experienceId})`);
  }

  if (Object.keys(attrs).length === 0) {
    throw new Error(
      "Rien à mettre à jour : fournir au moins un de tools/activityAreas/expertiseAreas/skills/experience/languages."
    );
  }

  // 5. PUT /technical-datas/{tdId} (recommended endpoint).
  const body = buildJsonApiBody("technicaldata", attrs, tdIdStr);
  const response = await apiRequest(`/technical-datas/${tdIdStr}`, "PUT", body);
  // Deprecated fallback (kept for reference; do not use unless /technical-datas is unavailable):
  //   const response = await apiRequest(`/candidates/${input.candidateId}/technical-data`, "PUT", body);
  return { response, tdId: tdIdStr, applied };
}

const TECHNICAL_DATA_UPDATE_DESCRIPTION = `Met à jour le Dossier Technique (DT) d'un candidat : compétences/outils, domaines, secteurs, expérience, langues.

Paramètres :
- \`candidateId\` (requis) : ID du candidat.
- \`tools\` (string[]) : outils/technos. Libellé OU id du dictionnaire \`setting.tool\` (ex: "C#", "React", ou "csharp").
- \`activityAreas\` (string[]) : domaines (\`setting.activityArea\`, hiérarchique — feuilles « Profils »/« Certifications »).
- \`expertiseAreas\` (string[]) : secteurs, **restreints au jeu codifié S1–S12** (\`setting.expertiseArea\` dont la value contient [S1]…[S12]). Une valeur hors S1–S12 est rejetée.
- \`skills\` (string) : texte libre des compétences.
- \`experience\` (string) : libellé résolu en id via \`setting.experience\`.
- \`languages\` (string[]) : format "langueId|niveauId" (transmis tel quel).
- \`mode\` : \`merge\` (défaut, union sans doublon) ou \`replace\`.

Résolution libellé→id insensible casse/accents (match id exact OU value). **Tout libellé non résolu est une erreur bloquante** (aucune écriture partielle ; liste des libellés en échec). Stratégie read-modify-write : lecture du tdId via /candidates/{id}/technical-data, lecture du DT courant, fusion/remplacement, PUT /technical-datas/{tdId}.

Returns : confirmation + payload mis à jour.`;

export function registerCandidateTechnicalDataTools(server: McpServer): void {
  server.registerTool(
    "boond_candidates_technical_data_update",
    {
      title: "Modifier le dossier technique d'un candidat",
      description: TECHNICAL_DATA_UPDATE_DESCRIPTION,
      inputSchema: CandidateTechnicalDataUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const { response, tdId, applied } = await updateCandidateTechnicalData(
          params as CandidateTechnicalDataUpdateInput
        );
        const text = [
          `✅ Dossier technique du candidat #${(params as CandidateTechnicalDataUpdateInput).candidateId} mis à jour (tdId ${tdId}).`,
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
