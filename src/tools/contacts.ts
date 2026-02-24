import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContactCreateSchema, ContactUpdateSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
} from "./crud-factory.js";

const OPTS = {
  entityName: "contact",
  entityNamePlural: "contacts",
  apiPath: "/contacts",
  prefix: "boond_contacts",
};

export function registerContactTools(server: McpServer): void {
  registerSearchTool(server, OPTS);
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, ContactCreateSchema, (params) => {
    const { companyId, ...attrs } = params;
    const body = buildJsonApiBody("contact", attrs);
    if (companyId) {
      (body as Record<string, Record<string, unknown>>).data.relationships = {
        company: { data: { id: companyId as string, type: "company" } },
      };
    }
    return body;
  });

  registerUpdateTool(server, OPTS, ContactUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("contact", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);
}
