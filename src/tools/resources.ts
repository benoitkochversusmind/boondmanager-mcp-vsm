import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceCreateSchema, ResourceUpdateSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
} from "./crud-factory.js";

const OPTS = {
  entityName: "ressource",
  entityNamePlural: "ressources",
  apiPath: "/resources",
  prefix: "boond_resources",
};

export function registerResourceTools(server: McpServer): void {
  registerSearchTool(server, OPTS);
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, ResourceCreateSchema, (params) => {
    const { ...attrs } = params;
    return buildJsonApiBody("resource", attrs);
  });

  registerUpdateTool(server, OPTS, ResourceUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("resource", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);
}
