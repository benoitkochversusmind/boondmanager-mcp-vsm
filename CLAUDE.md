# CLAUDE.md - BoondManager MCP Server

## Project Overview

MCP (Model Context Protocol) server for the BoondManager API. Exposes 158 tools across 36 domains, allowing Claude to interact with BoondManager ERP/CRM data.

- **Language**: TypeScript (strict mode), ES2022, Node16 module resolution
- **Runtime**: Node.js >= 20
- **Transport**: stdio (no network port)
- **API format**: JSON:API (BoondManager REST API)

## Commands

```bash
npm run build          # TypeScript compilation (tsc)
npm run dev            # Watch mode (tsc --watch)
npm start              # Run server (node dist/index.js)
npm test               # Run all tests (vitest run)
npm run test:coverage  # Tests + V8 coverage
npm run lint           # ESLint
npm run lint:fix       # ESLint with auto-fix
npm run typecheck      # tsc --noEmit
```

Run a single test file:
```bash
npx vitest run src/tools/candidates.test.ts
```

## Architecture

```
src/
├── index.ts              # Entry point: creates McpServer, registers all tools, starts stdio transport
├── constants.ts          # DEFAULT_BASE_URL, pagination limits, API_PATHS, ENTITY_TABS
├── types.ts              # JsonApiResource, JsonApiResponse, BoondConfig, SearchParams
├── services/
│   └── boond-client.ts   # HTTP client: apiRequest(), buildSearchQuery(), formatListResponse(), formatDetailResponse()
├── schemas/
│   └── index.ts          # Zod schemas: SearchSchema, IdSchema, IdTabSchema, plus entity-specific create/update schemas
└── tools/
    ├── index.ts          # Barrel export of all register*Tools functions
    ├── crud-factory.ts   # Generic CRUD tool factory (registerSearchTool, registerGetTool, etc.)
    └── *.ts              # One file per domain (37 tool files)
```

### Key Patterns

**CRUD Factory** (`crud-factory.ts`): Generic functions to register search/get/create/update/delete tools. Used by: candidates, resources, contacts, companies, opportunities, projects, products. Call signature: `registerSearchTool(server, opts)` where `opts = { entityName, entityNamePlural, apiPath, prefix }`.

**Tab tools**: Major entities (candidates, resources, contacts, companies, opportunities, projects) register additional tools for each tab endpoint. These are registered in loops over `ENTITY_TABS[entity]` from constants.ts. Tool name pattern: `boond_{entity}_{tab_name}` (hyphens replaced with underscores).

**Simple domains**: Most admin/reference domains (accounts, agencies, roles, etc.) register only search + get with direct `server.registerTool()` calls.

**JSON:API body builder**: `buildJsonApiBody(type, attributes, id?)` in crud-factory.ts builds the `{ data: { type, attributes } }` payload. Filters out undefined values.

## Tool Naming Convention

All tool names follow: `boond_{domain}_{operation}`

- Operations: `search`, `get`, `create`, `update`, `delete`
- Tab tools: `boond_{entity}_{tab_name}` (e.g., `boond_resources_technical_data`)
- Reporting: `boond_reporting_{type}` (e.g., `boond_reporting_companies`)
- Application: `boond_application_dictionary`, `boond_application_current_user`

## Testing

- **Framework**: Vitest 4 (with `globals: true`)
- **Pattern**: Each tool file has a corresponding `.test.ts` file
- **Approach**: Mock `McpServer` with `{ registerTool: vi.fn() }`, then verify:
  1. Correct number of `registerTool` calls
  2. Correct tool names
  3. Correct MCP annotations (readOnlyHint, destructiveHint, idempotentHint)
- **Coverage**: V8 provider, excludes test files and index.ts
- **Current stats**: 40 test files, 255 tests

### Test file template (for read-only search+get domains):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerXxxTools } from "./xxx.js";

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

describe("registerXxxTools", () => {
  let server: McpServer;
  beforeEach(() => { server = createMockServer(); });

  it("should register N tools", () => {
    registerXxxTools(server);
    expect(server.registerTool).toHaveBeenCalledTimes(N);
  });

  it("should register all expected tool names", () => {
    registerXxxTools(server);
    const names = vi.mocked(server.registerTool).mock.calls.map((c) => c[0]);
    expect(names).toContain("boond_xxx_search");
    expect(names).toContain("boond_xxx_get");
  });

  it("should register all tools as readOnly", () => {
    registerXxxTools(server);
    for (const call of vi.mocked(server.registerTool).mock.calls) {
      expect(call[1].annotations?.readOnlyHint).toBe(true);
    }
  });
});
```

## Adding a New Domain

1. Create `src/tools/{domain}.ts` with a `register{Domain}Tools(server: McpServer)` function
2. For simple search+get: use direct `server.registerTool()` calls with `SearchSchema`/`IdSchema`
3. For full CRUD: use `crud-factory.ts` functions or direct registration
4. Export from `src/tools/index.ts`
5. Register in `src/index.ts`
6. Add API path to `API_PATHS` in `constants.ts` (if applicable)
7. Create `src/tools/{domain}.test.ts` following the test pattern above
8. Run `npm test && npm run lint && npm run typecheck && npm run build`

## MCP Annotations

Every tool must declare annotations:
- `readOnlyHint: true` for search/get operations
- `destructiveHint: true` for delete operations
- `idempotentHint: true` for search/get/update operations
- `openWorldHint: true` for search operations (paginated, keyword-filtered)

## Authentication

Configured via environment variables (never hardcoded):
- `BOOND_USER` + `BOOND_PASSWORD` (BasicAuth, base64-encoded)
- `BOOND_API_TOKEN` (JWT Bearer)
- `BOOND_BASE_URL` (optional, defaults to `https://ui.boondmanager.com/api`)

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on push/PR to main. Matrix: Node 20 + 22. Steps: install, lint, typecheck, test:coverage, build.
- **Release** (`.github/workflows/release.yml`): Triggered on version tags.
- **Dependabot**: Configured for npm dependencies.

## Code Style

- ESLint 10 + typescript-eslint (recommended config)
- `@typescript-eslint/no-unused-vars` with `argsIgnorePattern: "^_"`
- `@typescript-eslint/no-explicit-any` as warning
- No semicolons preference not enforced (current code uses semicolons)
- French descriptions in tool metadata (titles, descriptions)
- English for code, comments, and commit messages
