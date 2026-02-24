import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpportunityCreateSchema, OpportunityUpdateSchema } from "../schemas/index.js";
import {
  registerSearchTool,
  registerGetTool,
  registerCreateTool,
  registerUpdateTool,
  registerDeleteTool,
  buildJsonApiBody,
} from "./crud-factory.js";

const OPTS = {
  entityName: "opportunité",
  entityNamePlural: "opportunités",
  apiPath: "/opportunities",
  prefix: "boond_opportunities",
};

export function registerOpportunityTools(server: McpServer): void {
  registerSearchTool(server, OPTS);
  registerGetTool(server, OPTS);

  registerCreateTool(server, OPTS, OpportunityCreateSchema, (params) => {
    const { companyId, contactId, ...attrs } = params;
    const body = buildJsonApiBody("opportunity", attrs);
    const relationships: Record<string, unknown> = {};
    if (companyId) relationships.company = { data: { id: companyId, type: "company" } };
    if (contactId) relationships.contact = { data: { id: contactId, type: "contact" } };
    if (Object.keys(relationships).length > 0) {
      (body as Record<string, Record<string, unknown>>).data.relationships = relationships;
    }
    return body;
  });

  registerUpdateTool(server, OPTS, OpportunityUpdateSchema, (params) => {
    const { id, ...attrs } = params;
    return buildJsonApiBody("opportunity", attrs, id as string);
  });

  registerDeleteTool(server, OPTS);
}
