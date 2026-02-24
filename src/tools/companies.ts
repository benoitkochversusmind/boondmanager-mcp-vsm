import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CompanyCreateSchema, CompanyUpdateSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
} from "./crud-factory.js";

const OPTS = {
  entityName: "société",
  entityNamePlural: "sociétés",
  apiPath: "/companies",
  prefix: "boond_companies",
};

export function registerCompanyTools(server: McpServer): void {
  registerSearchTool(server, OPTS);
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, CompanyCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("company", attrs);
  });

  registerUpdateTool(server, OPTS, CompanyUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("company", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);
}
