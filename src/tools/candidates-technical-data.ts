import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateTechnicalDataUpdateSchema, ResourceTechnicalDataUpdateSchema } from "../schemas/index.js";
import type { CandidateTechnicalDataUpdateInput, ResourceTechnicalDataUpdateInput } from "../schemas/index.js";
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
//   - PUT write shapes differ per DT field (TAB_DT storage + live GET reads):
//       * tools          → `tool|level` pairs ⇒ array of { tool: <id>, level: <int 0-5> }
//                          (a flat id is rejected with 1017 on /tools/0/tool; level 0 = non évalué).
//       * activityAreas  → pipe-delimited ids ⇒ flat id array (as the GET returns).
//       * expertiseAreas → pipe-delimited ids ⇒ flat id array (as the GET returns).
//       * languages      → array of { language: <setting.languageSpoken id>, level: <setting.languageLevel CEFR id> }.

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
 * Extract the dictionary id from an existing DT array element, tolerating every
 * shape BoondManager may return: a flat id string ("aws"), a typed-key object
 * ({ tool: "aws" } / { activityArea: "x" } / { expertiseArea: "y" }, possibly
 * nested as { tool: { id } }), or a generic { id } object.
 */
function existingId(el: unknown, wrapKey?: string): string {
  if (el && typeof el === "object") {
    const o = el as Record<string, unknown>;
    if (wrapKey && o[wrapKey] !== undefined && o[wrapKey] !== null) {
      const v = o[wrapKey];
      return v !== null && typeof v === "object" ? String((v as { id?: unknown }).id) : String(v);
    }
    if (o["id"] !== undefined && o["id"] !== null) return String(o["id"]);
  }
  return String(el);
}

/**
 * Merge (union, dedup) or replace a DT id-array, emitting the EXACT write shape
 * BoondManager expects for that field (verified against the TAB_DT storage spec
 * + live reads):
 *   - `tools` are stored as `tool|level` pairs → each entry is an object keyed
 *     by `tool` (`wrapKey = "tool"`); a flat id is rejected with 1017 on
 *     `/tools/0/tool`.
 *   - `activityAreas` / `expertiseAreas` are plain pipe-delimited ids → flat id
 *     arrays (no wrapKey), matching exactly how the GET tab returns them.
 * `newIds` are always string ids already resolved from the dictionary.
 */
function buildArray(existing: unknown[], newIds: string[], mode: "merge" | "replace", wrapKey?: string): unknown[] {
  const existingIds = existing.map((e) => existingId(e, wrapKey));
  const finalIds = mode === "replace" ? [...newIds] : Array.from(new Set([...existingIds, ...newIds]));
  return wrapKey ? finalIds.map((id) => ({ [wrapKey]: id })) : finalIds;
}

/** Split a `"<label>|<level>"` entry into its label and optional level suffix (split on the LAST `|`). */
function splitLevel(raw: string): { label: string; level?: string } {
  const i = raw.lastIndexOf("|");
  if (i < 0) return { label: raw.trim() };
  return { label: raw.slice(0, i).trim(), level: raw.slice(i + 1).trim() };
}

// `type` (not `interface`) so these satisfy the Record<string, unknown> constraint
// of mergeKeyed — interfaces can be augmented, so TS won't treat them as such.
type ToolWrite = { tool: string; level: number };
type LanguageWrite = { language: string; level: string };

/** Coerce an existing DT tools element ({tool,level} | {id} | flat id) to the writable shape. */
function normExistingTool(el: unknown): ToolWrite | null {
  const id = existingId(el, "tool");
  if (!id || id === "undefined" || id === "null") return null;
  let level = 0;
  if (el && typeof el === "object") {
    const n = Number((el as Record<string, unknown>)["level"]);
    if (Number.isInteger(n) && n >= 0 && n <= 5) level = n;
  }
  return { tool: id, level };
}

/** Coerce an existing DT languages element ({language,level} | flat "lang|level") to the writable shape. */
function normExistingLanguage(el: unknown): LanguageWrite | null {
  if (el && typeof el === "object") {
    const o = el as Record<string, unknown>;
    const language = o["language"] !== undefined ? String(o["language"]) : o["id"] !== undefined ? String(o["id"]) : "";
    if (!language) return null;
    return { language, level: o["level"] !== undefined && o["level"] !== null ? String(o["level"]) : "" };
  }
  const s = String(el ?? "");
  if (!s) return null;
  const i = s.indexOf("|");
  return i >= 0 ? { language: s.slice(0, i), level: s.slice(i + 1) } : { language: s, level: "" };
}

/**
 * Merge/replace a keyed object-array (tools keyed by `tool`, languages by
 * `language`): fresh entries win on key conflicts; in merge mode, existing
 * entries (read from the DT, then normalized to the writable shape) are kept
 * unless overridden. Dedups by key.
 */
function mergeKeyed<T extends Record<string, unknown>>(
  existing: unknown[],
  fresh: T[],
  keyField: keyof T & string,
  norm: (el: unknown) => T | null,
  mode: "merge" | "replace"
): T[] {
  const map = new Map<string, T>();
  if (mode === "merge") {
    for (const el of existing) {
      const n = norm(el);
      if (n) map.set(String(n[keyField]), n);
    }
  }
  for (const f of fresh) map.set(String(f[keyField]), f);
  return [...map.values()];
}

export interface TechnicalDataUpdateResult {
  response: JsonApiResponse;
  tdId: string;
  applied: string[];
}

/** The DT fields shared by candidates and resources (everything but the entity id). */
type TechnicalDataFields = Omit<CandidateTechnicalDataUpdateInput, "candidateId">;

/** A single professional-experience entry as accepted from the caller. */
type ReferenceInput = NonNullable<TechnicalDataFields["references"]>[number];

/**
 * The write shape of a reference (TAB_REFERENCE), matching EXACTLY the fields a
 * live GET /technical-datas/{id} round-trips (verified on candidate #18560):
 * id, title, company, location, startMonth/startYear, endMonth/endYear, skills,
 * description. The dates are stored as granular month/year strings — the API's
 * `startDate`/`endDate` are not persisted, so we never emit them.
 *
 * Every field is ALWAYS present. BoondManager's PUT validates each reference of
 * the array against the full shape: if a single entry omits `startMonth`,
 * `startYear`, `endMonth` or `endYear`, the API rejects the WHOLE array with a
 * 422 — even when the value is the empty string. So we emit "" rather than
 * dropping absent fields (verified in prod: a new entry without dates 422'd
 * every reference until the empty month/year keys were sent).
 */
type ReferenceWrite = {
  id: string;
  title: string;
  company: string;
  location: string;
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  skills: string;
  description: string;
};

/** Split "YYYY-MM" / "YYYY-MM-DD" into { year, month } (month un-padded, 1–12). */
function splitYearMonth(d?: string): { year: string; month: string } {
  if (!d) return { year: "", month: "" };
  const m = /^(\d{4})-(\d{2})/.exec(d);
  if (!m) return { year: "", month: "" };
  return { year: m[1], month: String(Number(m[2])) };
}

/** Read a string field off an existing (already-stored) reference, defaulting to "". */
function refStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return v === undefined || v === null ? "" : String(v);
}

/**
 * Build the full stored shape of a reference from caller input. `startDate`/
 * `endDate` are split into the granular month/year columns BoondManager persists
 * (REF_DEBUT_MOIS/ANNEE, REF_FIN_MOIS/ANNEE). ALL fields are emitted ("" when
 * absent) — see ReferenceWrite for why the empty date keys are mandatory.
 */
function buildReferenceWrite(r: ReferenceInput, id: string): ReferenceWrite {
  const s = splitYearMonth(r.startDate);
  const e = splitYearMonth(r.endDate);
  return {
    id,
    title: r.title,
    company: r.company ?? "",
    location: r.location ?? "",
    startMonth: s.month,
    startYear: s.year,
    endMonth: e.month,
    endYear: e.year,
    skills: r.skills ?? "",
    description: r.description,
  };
}

/**
 * Re-serialize an EXISTING reference (read back from the DT) into the full write
 * shape, guaranteeing every field is present ("" when missing). Preserves the
 * stored id and values verbatim; only fills in any key the API requires but the
 * stored object happens to lack — so a merge PUT never drops the mandatory empty
 * month/year keys that would 422 the whole array.
 */
function normalizeExistingReference(el: unknown): ReferenceWrite {
  const o = el && typeof el === "object" ? (el as Record<string, unknown>) : {};
  return {
    id: refStr(o, "id"),
    title: refStr(o, "title"),
    company: refStr(o, "company"),
    location: refStr(o, "location"),
    startMonth: refStr(o, "startMonth"),
    startYear: refStr(o, "startYear"),
    endMonth: refStr(o, "endMonth"),
    endYear: refStr(o, "endYear"),
    skills: refStr(o, "skills"),
    description: refStr(o, "description"),
  };
}

/**
 * Merge/replace the DT `references` array (professional experiences), keyed by id:
 *   - an input reference WITH `id` updates the matching existing entry;
 *   - an input reference WITHOUT `id` is a new entry, assigned a temporary
 *     negative id (-1, -2, …) — BoondManager assigns the real id on write;
 *   - in `merge`, existing entries not cited by id are re-serialized (full shape,
 *     empty keys preserved); in `replace`, only the provided references survive.
 * Every emitted entry carries the full ReferenceWrite shape so the API never
 * 422s the array over a missing (even empty) field.
 */
function buildReferences(existing: unknown[], provided: ReferenceInput[], mode: "merge" | "replace"): ReferenceWrite[] {
  const out: ReferenceWrite[] = [];
  let temp = -1;

  if (mode === "replace") {
    for (const r of provided) out.push(buildReferenceWrite(r, r.id ?? String(temp--)));
    return out;
  }

  // merge: override existing entries by id, keep the rest, append id-less new ones.
  const overrides = new Map<string, ReferenceInput>();
  for (const r of provided) if (r.id) overrides.set(r.id, r);
  for (const el of existing) {
    const eid = existingId(el);
    const ov = overrides.get(eid);
    if (ov) {
      out.push(buildReferenceWrite(ov, eid));
      overrides.delete(eid);
    } else {
      out.push(normalizeExistingReference(el));
    }
  }
  // ids provided but not currently present → treat as explicit upserts.
  for (const [id, r] of overrides) out.push(buildReferenceWrite(r, id));
  // brand-new entries (no id).
  for (const r of provided) if (!r.id) out.push(buildReferenceWrite(r, String(temp--)));
  return out;
}

/** Parent entity carrying the DT — only the tdId-lookup path/label differs. */
interface TechnicalDataParent {
  apiPath: "candidates" | "resources";
  label: string;
  id: string;
}

/** Candidate wrapper — resolves the tdId via /candidates/{id}/technical-data. */
export async function updateCandidateTechnicalData(
  input: CandidateTechnicalDataUpdateInput
): Promise<TechnicalDataUpdateResult> {
  return updateEntityTechnicalData({ apiPath: "candidates", label: "candidat", id: input.candidateId }, input);
}

/** Resource wrapper — resolves the tdId via /resources/{id}/technical-data. */
export async function updateResourceTechnicalData(
  input: ResourceTechnicalDataUpdateInput
): Promise<TechnicalDataUpdateResult> {
  return updateEntityTechnicalData({ apiPath: "resources", label: "ressource", id: input.resourceId }, input);
}

/**
 * Core, reusable logic. Resolves labels → ids, reads the current DT, applies
 * merge/replace, and PUTs the shared `/technical-datas/{tdId}` endpoint. Throws
 * on any unresolved label (with the explicit list) before performing any write.
 * Only the tdId lookup depends on the parent entity (candidate vs resource).
 */
async function updateEntityTechnicalData(
  parent: TechnicalDataParent,
  input: TechnicalDataFields
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
  const languageResolver = buildResolver(
    asArray(resolveDictionaryPath(dict.payload, "setting.languageSpoken")) as DictEntry[]
  );
  const languageLevelResolver = buildResolver(
    asArray(resolveDictionaryPath(dict.payload, "setting.languageLevel")) as DictEntry[]
  );

  // 2. Resolve every provided label; collect rejected entries (no silent drop,
  //    no partial write — a single rejection blocks the whole call).
  const rejected: string[] = [];
  function resolveAll(labels: string[] | undefined, resolver: Resolver, field: string): string[] {
    if (!labels) return [];
    const ids: string[] = [];
    for (const label of labels) {
      const id = resolver.resolve(label);
      if (id === undefined) rejected.push(`${field}: "${label}"`);
      else ids.push(String(id));
    }
    return ids;
  }
  const activityIds = resolveAll(input.activityAreas, activityResolver, "activityAreas");
  const expertiseIds = resolveAll(input.expertiseAreas, expertiseResolver, "expertiseAreas");

  // tools: "<outil>" or "<outil>|<niveau 0-5>" → { tool: <id>, level: <int, défaut 0> }.
  const toolEntries: ToolWrite[] = [];
  for (const raw of input.tools ?? []) {
    const { label, level } = splitLevel(raw);
    const id = toolResolver.resolve(label);
    if (id === undefined) rejected.push(`tools: "${label}"`);
    let lvl = 0;
    if (level !== undefined && level !== "") {
      const n = Number(level);
      if (!Number.isInteger(n) || n < 0 || n > 5) rejected.push(`tools (niveau): "${raw}" (entier 0–5 attendu)`);
      else lvl = n;
    }
    if (id !== undefined) toolEntries.push({ tool: String(id), level: lvl });
  }

  // languages: "<langue>|<niveau CEFR>" → { language: <id>, level: <CEFR id|""> }.
  const languageEntries: LanguageWrite[] = [];
  for (const raw of input.languages ?? []) {
    const { label, level } = splitLevel(raw);
    const langId = languageResolver.resolve(label);
    if (langId === undefined) rejected.push(`languages: "${label}"`);
    let levelId = "";
    if (level !== undefined && level !== "") {
      const lv = languageLevelResolver.resolve(level);
      if (lv === undefined) rejected.push(`languages (niveau CEFR A1–C2): "${level}"`);
      else levelId = String(lv);
    }
    if (langId !== undefined) languageEntries.push({ language: String(langId), level: levelId });
  }

  let experienceId: number | undefined;
  if (input.experience !== undefined) {
    const r = experienceResolver.resolve(input.experience);
    if (r === undefined) rejected.push(`experience: "${input.experience}"`);
    else experienceId = Number(r);
  }

  if (rejected.length > 0) {
    throw new Error(
      `Entrée(s) non résolue(s) ou invalide(s) — aucune écriture effectuée. Vérifiez l'orthographe ou utilisez ` +
        `boond_application_dictionary (setting.tool / setting.activityArea / setting.expertiseArea — secteurs ` +
        `restreints à S1–S12 / setting.experience / setting.languageSpoken / setting.languageLevel).\n  - ` +
        `${rejected.join("\n  - ")}`
    );
  }

  // 3. Resolve tdId via the parent's technical-data tab, then read the current DT
  //    (for merge union + element-shape detection). The tdId lookup is the ONLY
  //    parent-dependent step — the write below targets the shared /technical-datas.
  const tdLookup = await apiRequest(`/${parent.apiPath}/${parent.id}/technical-data`, "GET");
  const tdEntity = Array.isArray(tdLookup.data) ? tdLookup.data[0] : tdLookup.data;
  const tdId = (tdEntity?.attributes as Record<string, unknown> | undefined)?.["tdId"];
  if (tdId === undefined || tdId === null) {
    throw new Error(`Dossier technique introuvable pour ${parent.label} #${parent.id} (attribut tdId absent).`);
  }
  const tdIdStr = String(tdId);

  const current = await apiRequest(`/technical-datas/${tdIdStr}`, "GET");
  const currentEntity = (Array.isArray(current.data) ? current.data[0] : current.data) as JsonApiResource | undefined;
  const cur = (currentEntity?.attributes ?? {}) as Record<string, unknown>;

  // 4. Build the attributes to write (only fields the caller touched).
  const attrs: Record<string, unknown> = {};
  const applied: string[] = [];
  if (input.tools) {
    // tools carry a level (stored `tool|level`) → array of { tool: <id>, level: <int> }.
    attrs["tools"] = mergeKeyed(asArray(cur["tools"]), toolEntries, "tool", normExistingTool, mode);
    applied.push(`tools (${(attrs["tools"] as unknown[]).length})`);
  }
  if (input.activityAreas) {
    // Plain pipe-delimited ids → flat id array (matches the GET tab shape).
    attrs["activityAreas"] = buildArray(asArray(cur["activityAreas"]), activityIds, mode);
    applied.push(`activityAreas (${(attrs["activityAreas"] as unknown[]).length})`);
  }
  if (input.expertiseAreas) {
    // Plain pipe-delimited ids → flat id array (matches the GET tab shape).
    attrs["expertiseAreas"] = buildArray(asArray(cur["expertiseAreas"]), expertiseIds, mode);
    applied.push(`expertiseAreas (${(attrs["expertiseAreas"] as unknown[]).length})`);
  }
  if (input.languages) {
    // { language: <id>, level: <CEFR id|""> } objects, deduped by language.
    attrs["languages"] = mergeKeyed(asArray(cur["languages"]), languageEntries, "language", normExistingLanguage, mode);
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
  if (input.references) {
    // Professional experiences (TAB_REFERENCE) — free-text/date, no dictionary resolution.
    attrs["references"] = buildReferences(asArray(cur["references"]), input.references, mode);
    applied.push(`references (${(attrs["references"] as unknown[]).length})`);
  }

  if (Object.keys(attrs).length === 0) {
    throw new Error(
      "Rien à mettre à jour : fournir au moins un de tools/activityAreas/expertiseAreas/skills/experience/languages/references."
    );
  }

  // 5. PUT the shared /technical-datas/{tdId} endpoint (same for candidate & resource).
  const body = buildJsonApiBody("technicaldata", attrs, tdIdStr);
  const response = await apiRequest(`/technical-datas/${tdIdStr}`, "PUT", body);
  return { response, tdId: tdIdStr, applied };
}

/** Build the (identical-but-for-the-entity) tool description. */
function technicalDataDescription(entityLabel: string, idField: string, apiPath: string): string {
  return `Met à jour le Dossier Technique (DT) d'un(e) ${entityLabel} : compétences/outils, domaines, secteurs, expérience, langues, expériences professionnelles.

Paramètres :
- \`${idField}\` (requis) : ID du/de la ${entityLabel}.
- \`tools\` (string[]) : outils/technos, format \`"<outil>"\` ou \`"<outil>|<niveau>"\`. Outil = libellé OU id de \`setting.tool\`. Le libellé doit matcher la **value exacte** du dictionnaire (« C# » seul NE résout PAS → « .Net: C# » ou l'id « csharp »). Niveau = entier 0–5 (0 = non évalué, défaut si absent). Ex: ["Cloud: AWS|2", "React"].
- \`activityAreas\` (string[]) : domaines (\`setting.activityArea\`, hiérarchique — feuilles « Profils »/« Certifications »).
- \`expertiseAreas\` (string[]) : secteurs, **restreints au jeu codifié S1–S12** (\`setting.expertiseArea\` dont la value contient [S1]…[S12]). Une valeur hors S1–S12 est rejetée.
- \`skills\` (string) : texte libre des compétences.
- \`experience\` (string) : niveau de séniorité, libellé résolu en id via \`setting.experience\` (à ne PAS confondre avec \`references\`).
- \`languages\` (string[]) : format \`"<langue>|<niveau>"\`. Langue = libellé/id de \`setting.languageSpoken\`. Niveau = CEFR via \`setting.languageLevel\` : "A1","A2","B1","B2","C1","C2" (ou la value "B1 - Indépendant-"). Ex: ["Anglais|B2"]. En merge, le niveau d'une langue déjà présente est écrasé.
- \`references\` (object[]) : **expériences professionnelles** (parcours). Chaque entrée : \`title\` + \`description\` requis ; \`company\`, \`location\`, \`startDate\`/\`endDate\` ("YYYY-MM" ou "YYYY-MM-DD"), \`skills\` optionnels. Fournir \`id\` pour **modifier** une expérience existante (id lu dans le DT), l'**omettre** pour en **créer** une. Pas de résolution dictionnaire (texte libre).
- \`mode\` : \`merge\` (défaut, union sans doublon ; dédoublonnage par outil/langue ; références fusionnées par \`id\`, existantes non citées conservées) ou \`replace\` (remplace les seuls champs fournis ; pour \`references\`, ne garde que celles passées).

Résolution libellé→id insensible casse/accents (match id exact OU value). **Tout libellé non résolu est une erreur bloquante** (aucune écriture partielle ; liste des libellés en échec). Stratégie read-modify-write : lecture du tdId via /${apiPath}/{id}/technical-data, lecture du DT courant, fusion/remplacement, PUT /technical-datas/{tdId}.

Returns : confirmation + payload mis à jour.`;
}

const DT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerCandidateTechnicalDataTools(server: McpServer): void {
  server.registerTool(
    "boond_candidates_technical_data_update",
    {
      title: "Modifier le dossier technique d'un candidat",
      description: technicalDataDescription("candidat", "candidateId", "candidates"),
      inputSchema: CandidateTechnicalDataUpdateSchema,
      annotations: DT_ANNOTATIONS,
    },
    async (params) => {
      try {
        const p = params as CandidateTechnicalDataUpdateInput;
        const { response, tdId, applied } = await updateCandidateTechnicalData(p);
        const text = [
          `✅ Dossier technique du candidat #${p.candidateId} mis à jour (tdId ${tdId}).`,
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

export function registerResourceTechnicalDataTools(server: McpServer): void {
  server.registerTool(
    "boond_resources_technical_data_update",
    {
      title: "Modifier le dossier technique d'une ressource",
      description: technicalDataDescription("ressource", "resourceId", "resources"),
      inputSchema: ResourceTechnicalDataUpdateSchema,
      annotations: DT_ANNOTATIONS,
    },
    async (params) => {
      try {
        const p = params as ResourceTechnicalDataUpdateInput;
        const { response, tdId, applied } = await updateResourceTechnicalData(p);
        const text = [
          `✅ Dossier technique de la ressource #${p.resourceId} mis à jour (tdId ${tdId}).`,
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
