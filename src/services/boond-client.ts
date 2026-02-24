import { DEFAULT_BASE_URL, CHARACTER_LIMIT } from "../constants.js";
import type { BoondConfig, JsonApiResponse, SearchParams } from "../types.js";

let config: BoondConfig | null = null;

export function initClient(): void {
  const baseUrl = process.env.BOOND_BASE_URL || DEFAULT_BASE_URL;

  // Support BasicAuth (user:password) or token-based auth
  const token = process.env.BOOND_API_TOKEN;
  const user = process.env.BOOND_USER;
  const password = process.env.BOOND_PASSWORD;

  let authHeader: string;

  if (token) {
    authHeader = `Bearer ${token}`;
  } else if (user && password) {
    const encoded = Buffer.from(`${user}:${password}`).toString("base64");
    authHeader = `Basic ${encoded}`;
  } else {
    throw new Error(
      "Authentication required. Set BOOND_API_TOKEN or both BOOND_USER and BOOND_PASSWORD environment variables."
    );
  }

  config = { baseUrl, authHeader };
}

function getConfig(): BoondConfig {
  if (!config) {
    initClient();
  }
  return config!;
}

export async function apiRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
  queryParams?: Record<string, string | number | undefined>
): Promise<JsonApiResponse> {
  const { baseUrl, authHeader } = getConfig();

  const url = new URL(`${baseUrl}${path}`);

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `BoondManager API error ${response.status} ${response.statusText}: ${errorText}\n` +
      `Endpoint: ${method} ${path}\n` +
      `Suggestion: Check your credentials and permissions for this endpoint.`
    );
  }

  // DELETE may return empty body
  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return { data: [] };
  }

  return (await response.json()) as JsonApiResponse;
}

export function buildSearchQuery(params: SearchParams): Record<string, string | number | undefined> {
  const query: Record<string, string | number | undefined> = {};

  if (params.keywords) query["keywords"] = params.keywords;
  if (params.page !== undefined) query["page"] = params.page;
  if (params.pageSize !== undefined) query["maxResults"] = params.pageSize;

  // Forward any additional filter params
  for (const [key, value] of Object.entries(params)) {
    if (!["keywords", "page", "pageSize"].includes(key) && value !== undefined) {
      query[key] = String(value);
    }
  }

  return query;
}

export function formatEntitySummary(entity: {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}): string {
  const attrs = entity.attributes;
  const parts: string[] = [`[${entity.type} #${entity.id}]`];

  // Common name fields
  if (attrs.firstName || attrs.lastName) {
    parts.push(`${attrs.firstName || ""} ${attrs.lastName || ""}`.trim());
  }
  if (attrs.name) parts.push(String(attrs.name));
  if (attrs.email1) parts.push(`Email: ${attrs.email1}`);
  if (attrs.phone1) parts.push(`Tel: ${attrs.phone1}`);
  if (attrs.city) parts.push(`Ville: ${attrs.city}`);
  if (attrs.state !== undefined) parts.push(`Statut: ${attrs.state}`);
  if (attrs.title) parts.push(`Titre: ${attrs.title}`);

  return parts.join(" | ");
}

export function formatListResponse(
  response: JsonApiResponse,
  entityType: string
): string {
  const data = Array.isArray(response.data) ? response.data : [response.data];
  const total = response.meta?.totals?.rows;

  if (data.length === 0) {
    return `Aucun(e) ${entityType} trouvé(e).`;
  }

  const lines = data.map((item) => formatEntitySummary(item));
  let result = lines.join("\n");

  if (total !== undefined) {
    result = `Total: ${total} ${entityType}(s)\n\n${result}`;
  }

  if (result.length > CHARACTER_LIMIT) {
    result = result.substring(0, CHARACTER_LIMIT) + "\n\n[Résultats tronqués...]";
  }

  return result;
}

export function formatDetailResponse(response: JsonApiResponse): string {
  const entity = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!entity) return "Entité non trouvée.";

  const result = JSON.stringify(
    { id: entity.id, type: entity.type, attributes: entity.attributes, relationships: entity.relationships },
    null,
    2
  );

  if (result.length > CHARACTER_LIMIT) {
    return result.substring(0, CHARACTER_LIMIT) + "\n\n[Résultat tronqué...]";
  }

  return result;
}
