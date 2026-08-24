/**
 * Pins the hermetic SDK option shape of the VLM judge's vision query.
 *
 * The judge runs with `maxTurns: 1`, so a single speculative tool_use spends the
 * only agentic turn and ends the run as `error_max_turns` with no structured
 * output. `allowedTools: []` does NOT prevent that — it governs auto-approval
 * only, leaving the full toolset plus every user-configured MCP server in the
 * model's context. `tools: []` is the lever that actually removes them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
vi.mock('../../panels/claude/claudeExecutablePath', () => ({
  resolveClaudeExecutablePath: () => '/fake/claude',
}));

import { makeSdkVisionQuery } from '../vlmJudge';

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

describe('makeSdkVisionQuery SDK options', () => {
  it('disables every tool and strips MCP + filesystem settings', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { status: 'pass' } })]));

    // The judge's prompt seam is a streaming-input iterable (images ride inline
    // as content blocks), so hand it an empty one — this test only inspects the
    // options object, never the prompt.
    const emptyPrompt = (async function* (): AsyncGenerator<SDKUserMessage> {})();

    await makeSdkVisionQuery()({
      prompt: emptyPrompt,
      schema: { type: 'object' },
      model: 'claude-opus-4-8',
      signal: new AbortController().signal,
    });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.maxTurns).toBe(1);
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.disallowedTools).toEqual(['mcp__*']);
    expect(opts.settingSources).toEqual([]);
    expect(opts.strictMcpConfig).toBe(true);
    expect(opts.mcpServers).toEqual({});
  });
});
