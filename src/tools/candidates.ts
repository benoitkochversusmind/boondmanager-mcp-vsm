import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateCreateSchema, CandidateUpdateSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
} from "./crud-factory.js";

const OPTS = {
  entityName: "candidat",
  entityNamePlural: "candidats",
  apiPath: "/candidates",
  prefix: "boond_candidates",
};

export function registerCandidateTools(server: McpServer): void {
  registerSearchTool(server, OPTS);
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, CandidateCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("candidate", attrs);
  });

  registerUpdateTool(server, OPTS, CandidateUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("candidate", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);
}
