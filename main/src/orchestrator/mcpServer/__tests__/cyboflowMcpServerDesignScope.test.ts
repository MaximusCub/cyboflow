/**
 * Scope-gate tests for cyboflowMcpServer.ts's CYBOFLOW_MCP_SCOPE=design branch
 * (Design Mode v0 / docs/ideas/design-mode.md). The design scope surfaces ONLY
 * the four-tool design family (incl. the narrowed follow-up cyboflow_create_task)
 * and rejects every run-scoped / global-agent tool on DIRECT invocation — the design-mode.md acceptance is "out-of-scope MCP
 * tools are rejected on direct invocation, not merely unlisted".
 *
 * A SEPARATE file is required (not an extra describe block in the existing
 * files): CYBOFLOW_MCP_SCOPE is read ONCE at module-init time (IS_DESIGN_SCOPE
 * is a module-scope const), so it must be set BEFORE the dynamic
 * `await import('../cyboflowMcpServer')`. vitest gives each test FILE its own
 * fresh module registry, so this file re-evaluates the module against
 * CYBOFLOW_MCP_SCOPE=design. Mirrors cyboflowMcpServerGlobalAgentScope.test.ts.
 *
 * Mocking strategy mirrors that sibling exactly (Server double captures
 * ListTools/CallTool handlers; node:net returns a `destroyed: true` socket so a
 * dispatched call short-circuits with 'IPC client not connected' instead of
 * hitting the real 30s orchestrator timeout — proof the call reached the query
 * layer rather than being rejected as unknown/invalid).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type RequestHandler = (request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface CapturedHandlers {
  listTools?: RequestHandler;
  callTool?: RequestHandler;
}

const captured: CapturedHandlers = {};
let setRequestHandlerCallCount = 0;

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  return {
    Server: class {
      setRequestHandler(_schema: unknown, handler: RequestHandler): void {
        if (setRequestHandlerCallCount === 0) captured.listTools = handler;
        else captured.callTool = handler;
        setRequestHandlerCallCount += 1;
      }
      async connect(): Promise<void> {
        // no-op — never reaches a real stdio handshake in tests
      }
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('net', () => {
  return {
    createConnection: () => ({
      on: () => undefined,
      write: () => true,
      end: () => undefined,
      destroyed: true,
    }),
  };
});

const originalRunId = process.env.CYBOFLOW_RUN_ID;
const originalOrchSocket = process.env.CYBOFLOW_ORCH_SOCKET;
const originalMcpScope = process.env.CYBOFLOW_MCP_SCOPE;

beforeAll(async () => {
  process.env.CYBOFLOW_RUN_ID = 'run-design-test';
  process.env.CYBOFLOW_ORCH_SOCKET = '/tmp/cyboflow-design-test.sock';
  process.env.CYBOFLOW_MCP_SCOPE = 'design';
  await import('../cyboflowMcpServer');
});

afterAll(() => {
  if (originalRunId === undefined) delete process.env.CYBOFLOW_RUN_ID;
  else process.env.CYBOFLOW_RUN_ID = originalRunId;

  if (originalOrchSocket === undefined) delete process.env.CYBOFLOW_ORCH_SOCKET;
  else process.env.CYBOFLOW_ORCH_SOCKET = originalOrchSocket;

  if (originalMcpScope === undefined) delete process.env.CYBOFLOW_MCP_SCOPE;
  else process.env.CYBOFLOW_MCP_SCOPE = originalMcpScope;
});

interface ToolDecl {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type?: string; enum?: string[]; description?: string }>;
    required: string[];
  };
}

async function listTools(): Promise<ToolDecl[]> {
  if (!captured.listTools) throw new Error('ListTools handler was not captured');
  const result = (await captured.listTools({ params: { name: '__list__' } })) as unknown as { tools: ToolDecl[] };
  return result.tools;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!captured.callTool) throw new Error('CallTool handler was not captured');
  const result = await captured.callTool({ params: { name, arguments: args } });
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('cyboflowMcpServer ListTools (CYBOFLOW_MCP_SCOPE=design)', () => {
  it('advertises EXACTLY the four design tools — no run-scoped or global-agent tool leaks in', async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'cyboflow_design_get_idea',
        'cyboflow_design_update_draft',
        'cyboflow_report_artifact',
        'cyboflow_create_task',
      ].sort(),
    );
  });

  it("cyboflow_create_task's design-scope schema is the narrowed arg set (title/body/priority only)", async () => {
    const tools = await listTools();
    const createTask = tools.find((t) => t.name === 'cyboflow_create_task');
    expect(createTask).toBeDefined();
    expect(Object.keys(createTask!.inputSchema.properties).sort()).toEqual(['body', 'priority', 'title']);
    expect(createTask!.inputSchema.required).toEqual(['title']);
    // task_type is NOT an argument — the scope pins it server-side.
    expect(createTask!.inputSchema.properties['task_type']).toBeUndefined();
  });

  it('cyboflow_design_get_idea takes no arguments', async () => {
    const tools = await listTools();
    expect(tools.find((t) => t.name === 'cyboflow_design_get_idea')!.inputSchema.required).toEqual([]);
  });

  it('cyboflow_design_update_draft requires spec_markdown', async () => {
    const tools = await listTools();
    expect(tools.find((t) => t.name === 'cyboflow_design_update_draft')!.inputSchema.required).toEqual([
      'spec_markdown',
    ]);
  });

  it("cyboflow_report_artifact's atype enum is narrowed to ui-prototype only", async () => {
    const tools = await listTools();
    const report = tools.find((t) => t.name === 'cyboflow_report_artifact');
    expect(report).toBeDefined();
    expect(report!.inputSchema.properties['atype'].enum).toEqual(['ui-prototype']);
    expect(report!.inputSchema.required).toEqual(['atype', 'label']);
  });
});

describe('cyboflowMcpServer CallTool (CYBOFLOW_MCP_SCOPE=design)', () => {
  it('rejects a run-scoped tool name (cyboflow_get_run) as unknown on direct invocation', async () => {
    await expect(
      captured.callTool!({ params: { name: 'cyboflow_get_run', arguments: { run_id: 'x' } } }),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('rejects a global-agent tool name (cyboflow_db_query) as unknown on direct invocation', async () => {
    await expect(
      captured.callTool!({ params: { name: 'cyboflow_db_query', arguments: { sql: 'SELECT 1' } } }),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('rejects another run-scoped write (cyboflow_report_finding) as unknown on direct invocation', async () => {
    await expect(
      captured.callTool!({ params: { name: 'cyboflow_report_finding', arguments: { title: 'x', body: 'y' } } }),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('cyboflow_design_get_idea dispatches with no arguments (reaches the query layer, not a validation error)', async () => {
    const result = await callTool('cyboflow_design_get_idea', {});
    // destroyed:true short-circuits sendQuery — proves dispatch happened
    // (not 'unknown tool' / 'invalid_arguments').
    expect(result.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_design_update_draft rejects a missing spec_markdown without dispatching, and dispatches a valid call', async () => {
    expect(await callTool('cyboflow_design_update_draft', {})).toMatchObject({ error: 'invalid_arguments' });
    const valid = await callTool('cyboflow_design_update_draft', { spec_markdown: '### Design\n\ncontent' });
    expect(valid.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_report_artifact rejects atype "generic" in design scope (ui-prototype only)', async () => {
    expect(await callTool('cyboflow_report_artifact', { atype: 'generic', label: 'x' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('cyboflow_report_artifact rejects atype "idea-spec" in design scope (ui-prototype only)', async () => {
    expect(await callTool('cyboflow_report_artifact', { atype: 'idea-spec', label: 'x' })).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('cyboflow_report_artifact rejects a missing label without dispatching, and dispatches a valid ui-prototype call', async () => {
    expect(await callTool('cyboflow_report_artifact', { atype: 'ui-prototype' })).toMatchObject({
      error: 'invalid_arguments',
    });
    const valid = await callTool('cyboflow_report_artifact', {
      atype: 'ui-prototype',
      label: 'mockup',
      payload_json: JSON.stringify({ fileName: 'prototype/index.html' }),
    });
    expect(valid.error).toBe('[Cyboflow MCP] IPC client not connected');
  });

  it('cyboflow_create_task rejects a missing title and a bad priority without dispatching', async () => {
    expect(await callTool('cyboflow_create_task', {})).toMatchObject({ error: 'invalid_arguments' });
    expect(
      await callTool('cyboflow_create_task', { title: 'Create design style kit', priority: 'P9' }),
    ).toMatchObject({ error: 'invalid_arguments' });
  });

  it('cyboflow_create_task dispatches a valid call (narrowed args reach the query layer)', async () => {
    const valid = await callTool('cyboflow_create_task', {
      title: 'Create design style kit',
      body: 'Tokens + component sheet under docs/design-system/.',
      priority: 'P2',
    });
    expect(valid.error).toBe('[Cyboflow MCP] IPC client not connected');
  });
});
