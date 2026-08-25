/**
 * The single registry every `cyboflow_*` MCP tool surface derives from.
 *
 * cyboflowMcpServer.ts advertises `declarationsForScope(scope)` and dispatches
 * through `findTool(scope, name)` — it holds no per-tool declaration, no
 * per-tool argument check and no per-tool envelope literal of its own. Adding a
 * tool means adding one entry to one of the three scope tables; forgetting a
 * surface is no longer possible, because there is only one.
 *
 * SCOPE is part of the key, not a filter. Two tools (`cyboflow_report_artifact`
 * and `cyboflow_create_task`) are advertised in more than one scope with a
 * DIFFERENT schema and a different envelope mapping — the design session
 * narrows both — so a table keyed by name alone could not express them.
 */
import type { RegisteredTool } from './defineTool';
import type { JsonSchemaObject } from './toolSchema';
import { RUN_SCOPE_TOOLS } from './runScopeTools';
import { GLOBAL_AGENT_SCOPE_TOOLS } from './globalAgentTools';
import { DESIGN_SCOPE_TOOLS } from './designTools';

export type { RegisteredTool, McpEnvelopeType, EnvelopeParams } from './defineTool';
export type { JsonSchemaObject, JsonSchemaNode } from './toolSchema';
export { RUN_SCOPE_TOOLS } from './runScopeTools';
export { GLOBAL_AGENT_SCOPE_TOOLS } from './globalAgentTools';
export { DESIGN_SCOPE_TOOLS } from './designTools';

/**
 * Which tool family the subprocess serves. Resolved once from
 * CYBOFLOW_MCP_SCOPE at server start — a session is one scope for its lifetime.
 */
export type McpToolScope = 'run' | 'global-agent' | 'design';

export const MCP_TOOL_SCOPES: readonly McpToolScope[] = ['run', 'global-agent', 'design'];

/** The MCP ListTools entry shape — what the SDK puts on the wire. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

const TOOLS_BY_SCOPE: Readonly<Record<McpToolScope, readonly RegisteredTool[]>> = {
  run: RUN_SCOPE_TOOLS,
  'global-agent': GLOBAL_AGENT_SCOPE_TOOLS,
  design: DESIGN_SCOPE_TOOLS,
};

export function toolsForScope(scope: McpToolScope): readonly RegisteredTool[] {
  return TOOLS_BY_SCOPE[scope];
}

/** The ListTools reply for a scope — derived, never hand-written. */
export function declarationsForScope(scope: McpToolScope): ToolDeclaration[] {
  return toolsForScope(scope).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/** The CallTool dispatch lookup. Undefined = not advertised in this scope. */
export function findTool(scope: McpToolScope, name: string): RegisteredTool | undefined {
  return toolsForScope(scope).find((tool) => tool.name === name);
}
