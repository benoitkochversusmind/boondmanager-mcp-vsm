#!/usr/bin/env node

/**
 * Scan BoondManager API for new endpoints and tabs not yet implemented.
 *
 * This script:
 * 1. Probes known and potential BoondManager API endpoints
 * 2. Compares with currently implemented endpoints in src/constants.ts
 * 3. Outputs a report and sets GitHub Actions outputs
 *
 * Required env vars (at least one auth method):
 *   BOOND_API_TOKEN or (BOOND_USER + BOOND_PASSWORD)
 * Optional:
 *   BOOND_BASE_URL (defaults to https://ui.boondmanager.com/api)
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Auth setup ──────────────────────────────────────────────────────────────

const baseUrl = process.env.BOOND_BASE_URL || "https://ui.boondmanager.com/api";

function getAuthHeader() {
  const token = process.env.BOOND_API_TOKEN;
  const user = process.env.BOOND_USER;
  const password = process.env.BOOND_PASSWORD;

  if (token) return `Bearer ${token}`;
  if (user && password) return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  console.error("WARNING: No BoondManager credentials configured. Using documentation-based detection only.");
  return null;
}

const authHeader = getAuthHeader();

// ── Load current implementation ─────────────────────────────────────────────

function loadCurrentEndpoints() {
  const constantsPath = resolve(ROOT, "src/constants.ts");
  const content = readFileSync(constantsPath, "utf-8");

  // Extract API_PATHS keys
  const pathsMatch = content.match(/API_PATHS\s*=\s*\{([^}]+)\}/s);
  const implementedPaths = new Set();
  if (pathsMatch) {
    const matches = pathsMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g);
    for (const m of matches) {
      implementedPaths.add(m[2]); // the path value like "/candidates"
    }
  }

  // Extract ENTITY_TABS
  const tabsMatch = content.match(/ENTITY_TABS\s*=\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)?\}/s);
  const implementedTabs = {};
  if (tabsMatch) {
    const entityMatches = tabsMatch[0].matchAll(/(\w+):\s*\[([^\]]+)\]/g);
    for (const m of entityMatches) {
      const entity = m[1];
      const tabs = [...m[2].matchAll(/"([^"]+)"/g)].map((t) => t[1]);
      implementedTabs[entity] = tabs;
    }
  }

  return { implementedPaths, implementedTabs };
}

// ── Probe API endpoints ─────────────────────────────────────────────────────

// Known BoondManager API endpoint candidates (comprehensive list)
const POTENTIAL_ENDPOINTS = [
  // Currently implemented
  "/candidates",
  "/resources",
  "/contacts",
  "/companies",
  "/opportunities",
  "/actions",
  "/projects",
  "/invoices",
  "/orders",
  "/deliveries",
  "/absences",
  "/expenses",
  "/products",
  "/positionings",
  "/payments",
  "/advantages",
  "/application",
  // Potential new endpoints to discover
  "/contracts",
  "/agencies",
  "/poles",
  "/flags",
  "/currencies",
  "/countries",
  "/languages",
  "/skills",
  "/formations",
  "/certifications",
  "/meetings",
  "/tasks",
  "/goals",
  "/evaluations",
  "/reports",
  "/dashboards",
  "/exports",
  "/imports",
  "/templates",
  "/signatures",
  "/credits",
  "/subscriptions",
  "/logs",
  "/notifications",
  "/settings",
  "/users",
  "/roles",
  "/permissions",
  "/groups",
  "/tags",
  "/categories",
  "/milestones",
  "/planning",
  "/availability",
  "/intraday",
  "/rates",
  "/margins",
  "/turnovers",
  "/commissions",
  "/bonuses",
  "/documents",
  "/attachments",
  "/comments",
  "/histories",
  "/workflows",
  "/validations",
  "/kpis",
  "/indicators",
  "/charts",
  "/calendars",
  "/holidays",
  "/sectors",
  "/clients",
  "/providers",
  "/subcontractors",
  "/freelancers",
  "/interns",
  "/timesreports",
  "/billing",
  "/quotations",
  "/proposals",
  "/amendments",
  "/renewals",
];

// Known tabs to probe on entities
const POTENTIAL_TABS = {
  candidates: ["information", "technical", "actions", "documents", "financial", "contracts", "positionings"],
  resources: ["information", "technical", "financial", "actions", "contracts", "documents", "absences", "timesheets", "expenses", "advantages", "positionings", "evaluations"],
  contacts: ["information", "actions", "documents", "opportunities", "projects"],
  companies: ["information", "actions", "documents", "contacts", "opportunities", "projects", "invoices", "orders"],
  opportunities: ["information", "actions", "documents", "positionings", "projects"],
  projects: ["information", "planning", "actions", "documents", "deliveries", "invoices", "orders", "expenses", "positionings", "timesheets"],
};

async function probeEndpoint(path) {
  if (!authHeader) return null;

  try {
    const url = `${baseUrl}${path}?maxResults=1`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return { status: response.status, exists: true };
    }
    if (response.status === 401 || response.status === 403) {
      // Auth issue but endpoint might exist
      return { status: response.status, exists: "maybe" };
    }
    return { status: response.status, exists: false };
  } catch {
    return { status: 0, exists: false };
  }
}

async function probeTab(entity, tab) {
  if (!authHeader) return null;

  try {
    // Try with ID "1" — we expect 404 for the ID, not 404 for the route
    const url = `${baseUrl}/${entity}/1/${tab}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    // 200, 404 (entity not found) = tab route exists
    // 400 = might exist (bad request but route valid)
    // 500 = endpoint exists but errored
    if (response.ok || response.status === 404 || response.status === 400 || response.status === 500) {
      return { status: response.status, exists: true };
    }
    return { status: response.status, exists: false };
  } catch {
    return { status: 0, exists: false };
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Scanning BoondManager API for new endpoints...\n");

  const { implementedPaths, implementedTabs } = loadCurrentEndpoints();

  console.log(`Currently implemented: ${implementedPaths.size} endpoints`);
  console.log(`Entities with tabs: ${Object.keys(implementedTabs).join(", ")}\n`);

  const newEndpoints = [];
  const newTabs = [];

  // Probe potential new endpoints
  console.log("── Probing endpoints ──");
  for (const path of POTENTIAL_ENDPOINTS) {
    if (implementedPaths.has(path)) continue;

    const result = await probeEndpoint(path);
    if (result && result.exists === true) {
      console.log(`  ✅ NEW: ${path} (HTTP ${result.status})`);
      newEndpoints.push(path);
    } else if (result && result.exists === "maybe") {
      console.log(`  🔒 MAYBE: ${path} (HTTP ${result.status} - auth issue)`);
      newEndpoints.push(path);
    } else if (result) {
      console.log(`  ❌ ${path} (HTTP ${result.status})`);
    }
  }

  // Probe potential new tabs
  console.log("\n── Probing entity tabs ──");
  for (const [entity, tabs] of Object.entries(POTENTIAL_TABS)) {
    const currentTabs = implementedTabs[entity] || [];
    for (const tab of tabs) {
      if (currentTabs.includes(tab)) continue;

      const result = await probeTab(entity, tab);
      if (result && result.exists) {
        console.log(`  ✅ NEW TAB: ${entity}/${tab} (HTTP ${result.status})`);
        newTabs.push({ entity, tab });
      } else if (result) {
        console.log(`  ❌ ${entity}/${tab} (HTTP ${result.status})`);
      }
    }
  }

  // Build report
  const hasChanges = newEndpoints.length > 0 || newTabs.length > 0;

  let report = "# BoondManager API Scan Report\n\n";
  report += `**Date**: ${new Date().toISOString()}\n`;
  report += `**Base URL**: ${baseUrl}\n`;
  report += `**Auth method**: ${authHeader ? (authHeader.startsWith("Bearer") ? "JWT" : "BasicAuth") : "None (dry run)"}\n\n`;

  if (newEndpoints.length > 0) {
    report += `## New Endpoints Detected (${newEndpoints.length})\n\n`;
    for (const ep of newEndpoints) {
      const name = ep.replace(/^\//, "");
      report += `- \`${ep}\` → needs new tool file \`src/tools/${name}.ts\` with CRUD operations (search, get, create, update, delete), schema in \`src/schemas/index.ts\`, test file, and registration in index files\n`;
    }
    report += "\n";
  }

  if (newTabs.length > 0) {
    report += `## New Tabs Detected (${newTabs.length})\n\n`;
    for (const { entity, tab } of newTabs) {
      report += `- \`${entity}/${tab}\` → add tab tool \`boond_${entity}_${tab}\` in \`src/tools/${entity}.ts\`, update ENTITY_TABS in constants, update tests\n`;
    }
    report += "\n";
  }

  if (!hasChanges) {
    report += "## No Changes Detected\n\nAll known BoondManager API endpoints and tabs are already implemented.\n";
  }

  console.log(`\n${report}`);

  // Set GitHub Actions outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && existsSync(outputFile)) {
    appendFileSync(outputFile, `has_changes=${hasChanges}\n`);
    // Escape multiline for GH Actions
    const escapedReport = report.replace(/%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D");
    appendFileSync(outputFile, `report=${escapedReport}\n`);
  }

  if (hasChanges) {
    console.log(`\n🚀 ${newEndpoints.length} new endpoint(s) and ${newTabs.length} new tab(s) detected!`);
    process.exit(0);
  } else {
    console.log("\n✅ API is up to date, nothing to do.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
