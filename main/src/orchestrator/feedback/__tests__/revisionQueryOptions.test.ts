/**
 * Pins the hermetic SDK option shape of the revision query.
 *
 * `allowedTools` governs AUTO-APPROVAL ONLY (SDK contract, `Options.allowedTools`:
 * "To restrict which tools are available, use the `tools` option instead"). Listing
 * the read-only set there alone left Write/Edit/Bash — and every user-configured MCP
 * server — in the model's context. `tools` is the lever that makes the restriction
 * real; these assertions exist so it cannot silently regress to auto-approval-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeFakeQuery,
  sdkResultSuccess,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('../../../services/panels/claude/claudeExecutablePath', () => ({
  resolveClaudeExecutablePath: () => '/fake/claude',
}));

import { makeRevisionQuery } from '../revisionQuery';

let lastOptions: unknown;

function install(fn: FakeQueryFn): void {
  queryMock.mockImplementation((params: FakeQueryParams) => {
    lastOptions = params.options;
    return fn(params);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
});

describe('makeRevisionQuery SDK options', () => {
  it('pins tools to the read-only set and strips MCP + filesystem settings', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { ok: true } })]));

    await makeRevisionQuery()({ prompt: 'p', schema: { type: 'object' } });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.disallowedTools).toEqual(['mcp__*']);
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
  });
});
