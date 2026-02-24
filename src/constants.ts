// BoondManager API constants
export const DEFAULT_BASE_URL = "https://ui.boondmanager.com/api";
export const CHARACTER_LIMIT = 50000;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// API paths
export const API_PATHS = {
  candidates: "/candidates",
  resources: "/resources",
  contacts: "/contacts",
  companies: "/companies",
  opportunities: "/opportunities",
  actions: "/actions",
} as const;

// Tab names available on entities
export const ENTITY_TABS = {
  candidates: ["information", "technical", "actions", "documents"] as const,
  resources: ["information", "technical", "financial", "actions", "contracts", "documents"] as const,
  contacts: ["information", "actions", "documents"] as const,
  companies: ["information", "actions", "documents"] as const,
  opportunities: ["information", "actions", "documents"] as const,
} as const;
