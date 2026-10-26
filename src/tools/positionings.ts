import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  PositioningSearchSchema,
  PositioningCreateSchema,
  PositioningUpdateSchema,
  PositioningsUpdatedSchema,
  IdSchema,
} from "../schemas/index.js";
import type {
  PositioningUpdateInput,
  OpportunityPositioningsInput,
  PositioningsUpdatedInput,
  SearchInput,
} from "../schemas/index.js";
import { apiRequest, buildSearchQuery, formatDetailResponse } from "../services/boond-client.js";
import { buildJsonApiBody } from "./crud-factory.js";
import { getStateMap } from "../services/dictionary.js";
import type { JsonApiResponse, JsonApiResource } from "../types.js";

// ---- Positioning list formatter --------------------------------------------
//
// The generic `formatEntitySummary` only surfaces name/state/title, so the
// creationDate / updateDate that the BoondManager `/positionings` payload
// actually carries (verified live) were invisible on search + tab outputs.
// `formatPositioningsList` renders one line per positioning WITH those dates,
// the (label-resolved) state, the period, and the linked entities — mirroring
// the `formatActionsList` / `formatInvoiceList` pattern. Used by
// `boond_positionings_search`, `boond_positionings_get`, and the
// `boond_{candidates,resources,opportunities}_positionings` tab tools.

const POSITIONING_INCLUDE = "candidate,resource,project,opportunity";

function asAttrs(r: JsonApiResource): Record<string, unknown> {
  return (r.attributes ?? {}) as Record<string, unknown>;
}

/** "2026-06-09T18:53:13+0200" → "2026-06-09 18:53" ; "" / non-string → null. */
function fmtStamp(v: unknown): string | null {
  if (typeof v !== "string" || v.length < 10) return null;
  const date = v.slice(0, 10);
  const time = v.length >= 16 ? v.slice(11, 16) : "";
  return time ? `${date} ${time}` : date;
}

function indexIncluded(resp: JsonApiResponse): Map<string, JsonApiResource> {
  const m = new Map<string, JsonApiResource>();
  const inc = (resp as { included?: JsonApiResource[] }).included;
  if (Array.isArray(inc)) {
    for (const it of inc) if (it && it.id && it.type) m.set(`${it.type}:${it.id}`, it);
  }
  return m;
}

function relRef(r: JsonApiResource, key: string): { type: string; id: string } | null {
  const rels = (r.relationships ?? {}) as Record<string, { data?: { type?: string; id?: string } | null }>;
  const d = rels[key]?.data;
  return d && d.id && d.type ? { type: d.type, id: d.id } : null;
}

function displayEntity(ref: { type: string; id: string } | null, inc: Map<string, JsonApiResource>): string | null {
  if (!ref) return null;
  const e = inc.get(`${ref.type}:${ref.id}`);
  if (e) {
    const a = asAttrs(e);
    const name =
      [a["firstName"], a["lastName"]].filter(Boolean).join(" ").trim() ||
      (a["title"] as string) ||
      (a["reference"] as string) ||
      (a["name"] as string);
    if (name) return `${name} (${ref.type} #${ref.id})`;
  }
  return `${ref.type} #${ref.id}`;
}

// The consultant is carried by the polymorphic `dependsOn` relation
// (type ∈ {candidate, resource}) — NOT by `createdBy` (that's the author).
// Resolved from the natively-present included[] (no N+1).
function consultantLabel(p: JsonApiResource, inc: Map<string, JsonApiResource>): string {
  const dep = relRef(p, "dependsOn");
  if (!dep) return "(non renseigné)";
  const kind = dep.type === "resource" ? "ressource" : dep.type === "candidate" ? "candidat" : dep.type;
  const e = inc.get(`${dep.type}:${dep.id}`);
  if (e) {
    const a = asAttrs(e);
    const name = [a["firstName"], a["lastName"]].filter(Boolean).join(" ").trim();
    if (name) return `${name} (${kind})`;
  }
  return `${dep.type} #${dep.id} (${kind})`;
}

const APPLICATION_STATE_LABEL = "00 - Candidature annonce";

function resolveStateLabel(stateNum: unknown, stateById?: Map<number, string>): string | null {
  const n = Number(stateNum);
  if (!Number.isFinite(n)) return null;
  return stateById?.get(n) ?? `état ${n}`;
}

/**
 * Normalise un libellé d'état pour un rapprochement tolérant : retire le préfixe
 * numérique (« 00 - », « 03 - », « 00 bis - ») et passe en minuscules.
 * « 03 - No Go Interne » → « no go interne ».
 */
function normStateLabel(label: string): string {
  return label
    .replace(/^\s*\d+\s*(?:bis|ter)?\s*-\s*/i, "")
    .trim()
    .toLowerCase();
}

/** La date de MàJ (« 2026-10-23T10:25:31+0200 ») tombe-t-elle dans [from, to] (bornes incluses, Europe/Paris) ? */
function inUpdateWindow(updateDate: unknown, from?: string, to?: string): boolean {
  if (typeof updateDate !== "string" || updateDate.length < 10) return false;
  const d = updateDate.slice(0, 10); // l'horodatage porte l'offset +0200 → la partie date EST déjà la date de Paris.
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/** Rendu d'une ligne de positionnement (onglet / recherche) : cible, consultant, état, période, dates. */
function renderPositioningLine(
  p: JsonApiResource,
  inc: Map<string, JsonApiResource>,
  stateById?: Map<number, string>
): string {
  const a = asAttrs(p);
  const stateLabel = resolveStateLabel(a["state"], stateById);
  const what = displayEntity(relRef(p, "project") ?? relRef(p, "opportunity"), inc);

  const parts: string[] = [`[positioning #${p.id}]`];
  if (what) parts.push(what);
  parts.push(`Consultant: ${consultantLabel(p, inc)}`);
  if (stateLabel) parts.push(stateLabel);

  const start = typeof a["startDate"] === "string" && a["startDate"] ? (a["startDate"] as string) : null;
  const end = typeof a["endDate"] === "string" && a["endDate"] ? (a["endDate"] as string) : null;
  if (start || end) parts.push(`${start ?? "?"} → ${end ?? "?"}`);

  const created = fmtStamp(a["creationDate"]);
  const updated = fmtStamp(a["updateDate"]);
  if (created) parts.push(`créé ${created}`);
  if (updated) parts.push(`MàJ ${updated}`);

  return parts.join(" · ");
}

export interface PositioningFilterOptions {
  updatedFrom?: string;
  updatedTo?: string;
  excludeStates?: string[];
  sort?: "updateDate" | "creationDate";
  order?: "asc" | "desc";
}

interface FilterCounts {
  read: number;
  byDate: number;
  byState: number;
}

/**
 * Filtre côté serveur une liste de positionnements par fenêtre de date de MàJ
 * puis par état exclu (libellé résolu, préfixe/casse ignorés). Tri optionnel.
 */
function filterPositionings(
  all: JsonApiResource[],
  opts: PositioningFilterOptions,
  stateById?: Map<number, string>
): { retained: JsonApiResource[]; counts: FilterCounts } {
  const excludeSet = new Set((opts.excludeStates ?? []).map(normStateLabel).filter(Boolean));
  const hasWindow = Boolean(opts.updatedFrom || opts.updatedTo);
  let byDate = 0;
  let byState = 0;
  const retained: JsonApiResource[] = [];

  for (const p of all) {
    const a = asAttrs(p);
    if (hasWindow && !inUpdateWindow(a["updateDate"], opts.updatedFrom, opts.updatedTo)) {
      byDate++;
      continue;
    }
    if (excludeSet.size > 0) {
      const label = resolveStateLabel(a["state"], stateById);
      if (label && excludeSet.has(normStateLabel(label))) {
        byState++;
        continue;
      }
    }
    retained.push(p);
  }

  if (opts.sort) {
    const key = opts.sort;
    const dir = opts.order === "asc" ? 1 : -1;
    retained.sort((x, y) => {
      const xv = String(asAttrs(x)[key] ?? "");
      const yv = String(asAttrs(y)[key] ?? "");
      return xv < yv ? -dir : xv > yv ? dir : 0;
    });
  }

  return { retained, counts: { read: all.length, byDate, byState } };
}

/**
 * Récupère TOUS les positionnements d'un onglet (`/opportunities/{id}/positionings`),
 * en fusionnant `data` ET `included` de toutes les pages — contrairement à
 * `fetchTabResponse` qui ne garde que l'`included` de la page 1 (la résolution du
 * consultant serait alors perdue sur les pages 2+ des opportunités récurrentes).
 */
export async function fetchAllPositionings(path: string, maxPages = 100, pageSize = 500): Promise<JsonApiResponse> {
  const first = await apiRequest(path, "GET", undefined, { maxResults: pageSize, page: 1 });
  const firstData = Array.isArray(first.data) ? first.data : first.data ? [first.data] : [];
  const total = first.meta?.totals?.rows;
  const allData = [...firstData];
  const allIncluded = [...(((first as { included?: JsonApiResource[] }).included as JsonApiResource[]) ?? [])];

  if (total !== undefined && firstData.length > 0 && firstData.length < total) {
    for (let page = 2; page <= maxPages && allData.length < total; page++) {
      const resp = await apiRequest(path, "GET", undefined, { maxResults: pageSize, page });
      const data = Array.isArray(resp.data) ? resp.data : resp.data ? [resp.data] : [];
      if (data.length === 0) break;
      allData.push(...data);
      const incl = ((resp as { included?: JsonApiResource[] }).included as JsonApiResource[]) ?? [];
      allIncluded.push(...incl);
    }
  }

  return { ...first, data: allData, included: allIncluded } as JsonApiResponse;
}

export async function formatPositioningsList(
  response: JsonApiResponse,
  opts: { excludeApplications?: boolean } = {}
): Promise<string> {
  const all = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
  if (all.length === 0) return "Aucun positionnement trouvé.";

  let stateById: Map<number, string> | undefined;
  try {
    stateById = (await getStateMap("positioning")).byId;
  } catch {
    // Best effort — fall back to the numeric state if the dictionary is down.
  }
  const inc = indexIncluded(response);

  let hidden = 0;
  const lines: string[] = [];
  for (const p of all) {
    const stateLabel = resolveStateLabel(asAttrs(p)["state"], stateById);
    // Filter out "Candidature annonce" noise on the resolved label (not the prefix).
    if (opts.excludeApplications && stateLabel && stateLabel.trim() === APPLICATION_STATE_LABEL) {
      hidden++;
      continue;
    }
    lines.push(renderPositioningLine(p, inc, stateById));
  }

  const total = (response as { meta?: { totals?: { rows?: number } } }).meta?.totals?.rows;
  let header = total !== undefined ? `Total: ${total} positionnement(s)` : `${all.length} positionnement(s)`;
  if (hidden > 0) header += ` · ${hidden} masqué(s) (${APPLICATION_STATE_LABEL})`;
  if (lines.length === 0) {
    return `${header}\n(aucun positionnement à afficher après filtrage de cette page)`;
  }
  return [header, ...lines].join("\n");
}

/**
 * Évolution 1 — rendu de l'onglet positionnements d'une opportunité AVEC filtrage
 * serveur (fenêtre de MàJ + états exclus). En-tête de comptage explicite destiné
 * au contrôle de complétude du skill daily-synthesis.
 */
export async function formatOpportunityPositionings(
  response: JsonApiResponse,
  opts: PositioningFilterOptions
): Promise<string> {
  const all = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
  let stateById: Map<number, string> | undefined;
  try {
    stateById = (await getStateMap("positioning")).byId;
  } catch {
    // Best effort.
  }
  const inc = indexIncluded(response);
  const { retained, counts } = filterPositionings(all, opts, stateById);
  const filtered = counts.byDate + counts.byState;
  const header =
    `Total: ${retained.length} positionnement(s) retenu(s) — ${counts.read} lu(s), ${filtered} filtré(s) ` +
    `[date: ${counts.byDate}, états exclus: ${counts.byState}]`;
  if (retained.length === 0) {
    return `${header}\n(aucun positionnement retenu après filtrage)`;
  }
  const lines = retained.map((p) => renderPositioningLine(p, inc, stateById));
  return [header, ...lines].join("\n");
}

/**
 * Évolution 1 — handler de l'onglet `boond_opportunities_positionings`.
 * Sans paramètre de filtre, le comportement est strictement identique à
 * l'historique (liste complète). Avec un filtre, applique le filtrage serveur
 * et l'en-tête de comptage détaillé.
 */
export function buildOpportunityPositioningsHandler(): (
  params: OpportunityPositioningsInput
) => Promise<{ content: { type: "text"; text: string }[] }> {
  return async (params) => {
    const { id, updatedFrom, updatedTo, excludeStates, sort, order } = params;
    const hasFilter = Boolean(updatedFrom || updatedTo || (excludeStates && excludeStates.length > 0) || sort);
    const response = await fetchAllPositionings(`/opportunities/${id}/positionings`);
    const text = hasFilter
      ? await formatOpportunityPositionings(response, { updatedFrom, updatedTo, excludeStates, sort, order })
      : await formatPositioningsList(response);
    return { content: [{ type: "text" as const, text }] };
  };
}

// ---- Évolution 2 — boond_positionings_updated --------------------------------

function displayName(e?: JsonApiResource): string | null {
  if (!e) return null;
  const a = asAttrs(e);
  const name =
    [a["firstName"], a["lastName"]].filter(Boolean).join(" ").trim() || (a["name"] as string) || (a["title"] as string);
  return name || null;
}

/** Résout le nom d'une relation (`company`, `mainManager`…) via l'`included[]` indexé. */
function resolveRelName(owner: JsonApiResource, key: string, inc: Map<string, JsonApiResource>): string | null {
  const ref = relRef(owner, key);
  if (!ref) return null;
  return displayName(inc.get(`${ref.type}:${ref.id}`));
}

/**
 * Ligne de sortie de `boond_positionings_updated` :
 * `[positioning #id] · Consultant (candidat|ressource) · opportunité #id Titre · Société · État · MàJ ... [· BM: ...]`
 */
function renderUpdatedLine(
  p: JsonApiResource,
  opp: JsonApiResource,
  posInc: Map<string, JsonApiResource>,
  oppInc: Map<string, JsonApiResource>,
  stateById?: Map<number, string>
): string {
  const a = asAttrs(p);
  const oppTitle = (asAttrs(opp)["title"] as string) || "";
  const companyName = resolveRelName(opp, "company", oppInc);
  const bmName = resolveRelName(opp, "mainManager", oppInc);
  const stateLabel = resolveStateLabel(a["state"], stateById) ?? "état ?";
  const updated = fmtStamp(a["updateDate"]) ?? "?";

  const parts: string[] = [
    `[positioning #${p.id}]`,
    consultantLabel(p, posInc),
    `opportunité #${opp.id}${oppTitle ? ` ${oppTitle}` : ""}`,
    companyName ?? "(société ?)",
    stateLabel,
    `MàJ ${updated}`,
  ];
  if (bmName) parts.push(`BM: ${bmName}`);
  return parts.join(" · ");
}

/** Exécute `fn` sur `items` avec une concurrence bornée (préserve l'ordre des résultats). */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface OppResult {
  ok: boolean;
  oppId: string;
  read: number;
  inWindow: number;
  excluded: number;
  entries: { line: string; updated: string }[];
}

const POSITIONINGS_UPDATED_CONCURRENCY = 5;
const OPP_SEARCH_MAX_PAGES = 100;

export async function runPositioningsUpdated(params: PositioningsUpdatedInput): Promise<string> {
  const { startDate, endDate, excludeStates, maxOpportunities, ...perimeter } = params;
  const windowLabel = startDate === endDate ? startDate : `${startDate} → ${endDate}`;

  // 1) Opportunités mises à jour (positionnement) sur la fenêtre, pagination complète,
  //    avec la société et le responsable résolus via include.
  const query = buildSearchQuery({
    ...(perimeter as Record<string, unknown>),
    period: "updatedPositioning",
    startDate,
    endDate,
    pageSize: 500,
  } as unknown as SearchInput);
  query["include"] = "company,mainManager";

  const opps: JsonApiResource[] = [];
  const oppInc = new Map<string, JsonApiResource>();
  for (let page = 1; page <= OPP_SEARCH_MAX_PAGES; page++) {
    const resp = await apiRequest("/opportunities", "GET", undefined, { ...query, page });
    const data = Array.isArray(resp.data) ? resp.data : resp.data ? [resp.data] : [];
    for (const it of (resp as { included?: JsonApiResource[] }).included ?? []) {
      if (it?.id && it?.type) oppInc.set(`${it.type}:${it.id}`, it);
    }
    opps.push(...data);
    const total = resp.meta?.totals?.rows;
    if (data.length === 0 || (total !== undefined && opps.length >= total)) break;
  }

  if (opps.length === 0) {
    return `Opportunités: 0/0 traitées · aucune opportunité avec un positionnement mis à jour sur ${windowLabel}.`;
  }

  const capped = opps.length > maxOpportunities;
  const toProcess = capped ? opps.slice(0, maxOpportunities) : opps;

  let stateById: Map<number, string> | undefined;
  try {
    stateById = (await getStateMap("positioning")).byId;
  } catch {
    // Best effort.
  }

  // 2) Positionnements de chaque opportunité, filtrés sur la fenêtre + états exclus.
  const results = await mapPool<JsonApiResource, OppResult>(
    toProcess,
    POSITIONINGS_UPDATED_CONCURRENCY,
    async (opp) => {
      try {
        const resp = await fetchAllPositionings(`/opportunities/${opp.id}/positionings`);
        const all = Array.isArray(resp.data) ? resp.data : resp.data ? [resp.data] : [];
        const posInc = indexIncluded(resp);
        const { retained, counts } = filterPositionings(
          all,
          { updatedFrom: startDate, updatedTo: endDate, excludeStates },
          stateById
        );
        const entries = retained.map((p) => ({
          line: renderUpdatedLine(p, opp, posInc, oppInc, stateById),
          updated: String(asAttrs(p)["updateDate"] ?? ""),
        }));
        return {
          ok: true,
          oppId: String(opp.id),
          read: counts.read,
          inWindow: counts.read - counts.byDate,
          excluded: counts.byState,
          entries,
        };
      } catch {
        return { ok: false, oppId: String(opp.id), read: 0, inWindow: 0, excluded: 0, entries: [] };
      }
    }
  );

  // 3) Agrégation + rendu.
  let read = 0;
  let inWindow = 0;
  let excluded = 0;
  const entries: { line: string; updated: string }[] = [];
  const failed: string[] = [];
  for (const r of results) {
    if (!r.ok) {
      failed.push(r.oppId);
      continue;
    }
    read += r.read;
    inWindow += r.inWindow;
    excluded += r.excluded;
    entries.push(...r.entries);
  }
  entries.sort((x, y) => (x.updated < y.updated ? 1 : x.updated > y.updated ? -1 : 0)); // MàJ décroissante
  const okCount = toProcess.length - failed.length;

  const out: string[] = [
    `Opportunités: ${okCount}/${opps.length} traitées · Positionnements: ${read} lus, ${inWindow} dans la fenêtre, ` +
      `${excluded} exclus, ${entries.length} retenus`,
  ];
  if (capped) {
    out.push(
      `⚠️ Plafond de ${maxOpportunities} opportunités atteint : ${opps.length} trouvées, ${toProcess.length} traitées.`
    );
  }
  if (entries.length > 0) {
    out.push("", ...entries.map((e) => e.line));
  } else if (failed.length === 0) {
    out.push("(aucun positionnement retenu sur la fenêtre)");
  }
  if (failed.length > 0) {
    out.push("", `⚠️ Opportunités en échec (résultat partiel) : ${failed.map((id) => `#${id}`).join(", ")}`);
  }
  return out.join("\n");
}

export function registerPositioningTools(server: McpServer): void {
  // Search positionings
  server.registerTool(
    "boond_positionings_search",
    {
      title: "Rechercher des positionnements",
      description: `Recherche des positionnements (placement de candidats/ressources sur des projets/opportunités) dans BoondManager.

Args:
  - keywords (string, optional): Termes de recherche
  - candidateId, resourceId, projectId, opportunityId (string, optional): Filtrer par entité liée. L'API /positionings ignore ces noms en query littérale → le serveur les route via les préfixes keyword BoondManager (CAND/COMP/PRJ/AO), vérifié en prod.
  - excludeApplications (boolean, optional, défaut false): masque les positionnements à l'état « 00 - Candidature annonce »
  - page, pageSize: Pagination

Returns: Une ligne par positionnement avec **consultant** (Prénom NOM, candidat ou ressource), opportunité/projet, état (libellé), période, et **date de création + date de mise à jour**.`,
      inputSchema: PositioningSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      // excludeApplications : filtre côté serveur MCP (libellé résolu), pas un
      // paramètre d'API. candidateId/resourceId/projectId/opportunityId : l'API
      // /positionings ignore ces noms en query → on les injecte dans `keywords`
      // via les préfixes BoondManager (CAND/COMP/PRJ/AO), comme boond_actions_search.
      const { excludeApplications, candidateId, resourceId, projectId, opportunityId, keywords, ...rest } = params;
      const prefixes: string[] = [];
      if (candidateId) prefixes.push(`CAND${candidateId}`);
      if (resourceId) prefixes.push(`COMP${resourceId}`);
      if (projectId) prefixes.push(`PRJ${projectId}`);
      if (opportunityId) prefixes.push(`AO${opportunityId}`);
      const mergedKeywords = [prefixes.join(" "), keywords].filter(Boolean).join(" ").trim() || undefined;

      const query = buildSearchQuery({ ...rest, keywords: mergedKeywords });
      query["include"] = POSITIONING_INCLUDE;
      const response = await apiRequest("/positionings", "GET", undefined, query);
      return {
        content: [{ type: "text" as const, text: await formatPositioningsList(response, { excludeApplications }) }],
      };
    }
  );

  // Get positioning details
  server.registerTool(
    "boond_positionings_get",
    {
      title: "Détails d'un positionnement",
      description: `Récupère les informations détaillées d'un positionnement par son ID (état, période, date de création, date de mise à jour, simulation, entités liées).`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const response = await apiRequest(`/positionings/${params.id}`, "GET", undefined, {
        include: POSITIONING_INCLUDE,
      });
      // Clean one-line summary (with the dates) on top of the full JSON:API payload.
      const summary = await formatPositioningsList(response);
      return {
        content: [{ type: "text" as const, text: `${summary}\n\n${formatDetailResponse(response)}` }],
      };
    }
  );

  // Create positioning
  server.registerTool(
    "boond_positionings_create",
    {
      title: "Créer un positionnement",
      description: `Crée un positionnement = place un consultant (candidat OU ressource) sur une cible (opportunité OU projet).

L'API BoondManager exige DEUX relations :
  - le consultant via \`dependsOn\` (polymorphe) → fournir candidateId OU resourceId ;
  - la cible → fournir opportunityId OU projectId.
Le serveur construit \`dependsOn\` automatiquement (candidateId → type candidate, resourceId → type resource). Sans consultant ou sans cible, l'appel est refusé côté serveur avec un message clair (l'API renvoie sinon « Missing required attribute: dependsOn »).

Attributs optionnels : state (entier dictionnaire setting.state.positioning), startDate/endDate (YYYY-MM-DD), note (→ informationComments).`,
      inputSchema: PositioningCreateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { candidateId, resourceId, projectId, opportunityId, note, ...rest } = params;

      // Consultant → relation polymorphe `dependsOn` (candidate|resource), PAS
      // `relationships.candidate/resource` (que l'API ignore → 422 dependsOn).
      const consultant = candidateId
        ? { id: candidateId, type: "candidate" }
        : resourceId
          ? { id: resourceId, type: "resource" }
          : null;
      if (!consultant) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Consultant manquant : fournir `candidateId` (candidat) ou `resourceId` (ressource).",
            },
          ],
          isError: true,
        };
      }
      if (!opportunityId && !projectId) {
        return {
          content: [{ type: "text" as const, text: "Cible manquante : fournir `opportunityId` ou `projectId`." }],
          isError: true,
        };
      }

      // note → informationComments (nom d'attribut réel côté API).
      const attrs: Record<string, unknown> = { ...rest };
      if (note !== undefined) attrs["informationComments"] = note;

      const body = buildJsonApiBody("positioning", attrs);
      const relationships: Record<string, unknown> = { dependsOn: { data: consultant } };
      if (opportunityId) relationships.opportunity = { data: { id: opportunityId, type: "opportunity" } };
      if (projectId) relationships.project = { data: { id: projectId, type: "project" } };
      (body as Record<string, Record<string, unknown>>).data.relationships = relationships;

      const response = await apiRequest("/positionings", "POST", body);
      const entity = Array.isArray(response.data) ? response.data[0] : response.data;
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Positionnement créé avec succès.\nID: ${entity?.id}\n\n${formatDetailResponse(response)}`,
          },
        ],
      };
    }
  );

  // Update positioning
  server.registerTool(
    "boond_positionings_update",
    {
      title: "Modifier un positionnement",
      description: `Met à jour un positionnement existant (état, période, commentaires). Seuls les champs fournis sont modifiés.

Args : id (requis), state (entier dictionnaire setting.state.positioning), startDate/endDate (YYYY-MM-DD), note (→ informationComments). Pour changer le consultant ou la cible, supprimer puis recréer.`,
      inputSchema: PositioningUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const { id, note, ...rest } = params as PositioningUpdateInput;
      const attrs: Record<string, unknown> = { ...rest };
      if (note !== undefined) attrs["informationComments"] = note;
      const body = buildJsonApiBody("positioning", attrs, id);
      const response = await apiRequest(`/positionings/${id}`, "PUT", body);
      const summary = await formatPositioningsList(response);
      return {
        content: [{ type: "text" as const, text: `✅ Positionnement #${id} mis à jour.\n${summary}` }],
      };
    }
  );

  // Delete positioning
  server.registerTool(
    "boond_positionings_delete",
    {
      title: "Supprimer un positionnement",
      description: `Supprime un positionnement de BoondManager. ⚠️ Action irréversible.`,
      inputSchema: IdSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      await apiRequest(`/positionings/${params.id}`, "DELETE");
      return {
        content: [{ type: "text" as const, text: `🗑️ Positionnement #${params.id} supprimé.` }],
      };
    }
  );

  // Composite : positionnements mis à jour sur une fenêtre de dates (Évolution 2).
  server.registerTool(
    "boond_positionings_updated",
    {
      title: "Positionnements mis à jour sur une fenêtre de dates",
      description: `Liste, en un seul appel, les positionnements dont la **date de mise à jour** tombe dans une fenêtre de dates (Europe/Paris). Enchaîne côté serveur : recherche des opportunités via \`period: "updatedPositioning"\` (pagination complète), puis récupération + filtrage de leurs positionnements.

Args :
  - startDate, endDate (requis, YYYY-MM-DD) : fenêtre de MàJ, bornes incluses.
  - excludeStates (string[], optionnel) : libellés d'état à exclure (préfixe numérique et casse ignorés, ex: ["Candidature annonce", "No Go Interne"]).
  - maxOpportunities (défaut 200) : plafond d'opportunités traitées ; un dépassement est signalé.
  - perimeterDynamic / perimeterManagers / perimeterAgencies / perimeterPoles / perimeterBusinessUnits / narrowPerimeter : mêmes filtres de périmètre que \`boond_opportunities_search\`.

Returns : en-tête de couverture (opportunités traitées, positionnements lus / dans la fenêtre / exclus / retenus) puis une ligne par positionnement retenu (consultant, opportunité, société, état, date de MàJ). Les opportunités en échec sont listées en fin de réponse (jamais de résultat partiel silencieux).`,
      inputSchema: PositioningsUpdatedSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const text = await runPositioningsUpdated(params as PositioningsUpdatedInput);
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
