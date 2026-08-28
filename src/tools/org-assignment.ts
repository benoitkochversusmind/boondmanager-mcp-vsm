import { apiRequest } from "../services/boond-client.js";
import type { QueryValue } from "../services/boond-client.js";
import type { JsonApiResource } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Org assignment — mainManager / agency / pole relationships
// ─────────────────────────────────────────────────────────────────────────────
// Candidates, contacts and companies all expose three writable JSON:API
// relationships that drive their organisational attachment (confirmed against
// the BoondManager API body schema):
//   - mainManager → the responsible resource (type "resource")
//   - agency      → the agency (type "agency")
//   - pole        → the pole (type "pole")
// Changing `mainManager` reassigns the responsible; `pole` is a DIRECT relation,
// so the pole can be set explicitly (not only inherited from the agency).
//
// Each field accepts an ID (fast path) OR a label, resolved by name against the
// corresponding collection (/resources, /agencies, /poles). Any value that
// cannot be resolved to exactly one entity is a BLOCKING error — the caller must
// not perform a partial write.

export interface OrgAssignmentFields {
  mainManager?: string;
  agency?: string;
  pole?: string;
}

interface RelSpec {
  field: keyof OrgAssignmentFields;
  type: string; // JSON:API resource type of the relationship target
  apiPath: string;
  /** true → narrow the search with `keywords` (large collection like /resources). */
  useKeywords: boolean;
}

const REL_SPECS: readonly RelSpec[] = [
  { field: "mainManager", type: "resource", apiPath: "/resources", useKeywords: true },
  { field: "agency", type: "agency", apiPath: "/agencies", useKeywords: false },
  { field: "pole", type: "pole", apiPath: "/poles", useKeywords: false },
] as const;

/** Accent + case insensitive normalization for forgiving label matching. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function asArray(v: unknown): JsonApiResource[] {
  return Array.isArray(v) ? (v as JsonApiResource[]) : v ? [v as JsonApiResource] : [];
}

/** Candidate display names for a resource/agency/pole (name, title, or first+last). */
function displayNames(attrs: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof attrs.name === "string") out.push(attrs.name);
  if (typeof attrs.title === "string") out.push(attrs.title);
  const fn = typeof attrs.firstName === "string" ? attrs.firstName : "";
  const ln = typeof attrs.lastName === "string" ? attrs.lastName : "";
  const full = `${fn} ${ln}`.trim();
  if (full) out.push(full);
  return out;
}

/** Resolve a label to exactly one id in `apiPath`; pushes a reason to `rejected` on 0/many. */
async function resolveByName(spec: RelSpec, label: string, rejected: string[]): Promise<string | undefined> {
  const query: Record<string, QueryValue> = spec.useKeywords
    ? { maxResults: 50, keywords: label }
    : { maxResults: 500 };
  let resp;
  try {
    resp = await apiRequest(spec.apiPath, "GET", undefined, query);
  } catch {
    rejected.push(`${spec.field}: "${label}" (recherche ${spec.apiPath} échouée)`);
    return undefined;
  }
  const target = norm(label);
  const hits = asArray(resp.data).filter((r) =>
    displayNames((r.attributes ?? {}) as Record<string, unknown>).some((n) => norm(n) === target)
  );
  if (hits.length === 1) return String(hits[0].id);
  rejected.push(`${spec.field}: "${label}" (${hits.length === 0 ? "introuvable" : `${hits.length} correspondances`})`);
  return undefined;
}

/**
 * Build the JSON:API `relationships` block for the org-assignment fields present
 * in `input`. Numeric values are used as ids directly; textual values are
 * resolved by name. Returns the relationships plus the list of unresolved
 * entries (empty ⇒ safe to write). Fields absent from `input` are left untouched.
 */
export async function resolveOrgRelationships(
  input: OrgAssignmentFields
): Promise<{ relationships: Record<string, unknown>; rejected: string[] }> {
  const relationships: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const spec of REL_SPECS) {
    const raw = input[spec.field];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const value = String(raw).trim();
    const id = /^[1-9][0-9]*$/.test(value) ? value : await resolveByName(spec, value, rejected);
    if (id !== undefined) relationships[spec.field] = { data: { id, type: spec.type } };
  }
  return { relationships, rejected };
}

/** True if the input carries at least one org-assignment field to write. */
export function hasOrgAssignment(input: OrgAssignmentFields): boolean {
  return (
    (input.mainManager !== undefined && String(input.mainManager).trim() !== "") ||
    (input.agency !== undefined && String(input.agency).trim() !== "") ||
    (input.pole !== undefined && String(input.pole).trim() !== "")
  );
}

/** Human-readable blocking error for unresolved org-assignment labels. */
export function orgAssignmentError(rejected: string[]): Error {
  return new Error(
    "Affectation non résolue — aucune écriture effectuée. Vérifiez l'ID ou le libellé " +
      "(responsable via boond_resources_search, agence via boond_agencies_search, pôle via boond_poles_search) :\n  - " +
      rejected.join("\n  - ")
  );
}
