/**
 * Unit tests for ompGateConfigBuilder.
 *
 * The interesting assertions are the two translations that would fail SILENTLY
 * in production: a tool name that maps to something OMP never emits simply never
 * matches (a deny that does not deny, an allowlist that does not allow), and a
 * cyboflow MCP tool name that drifts out of the hardcoded list falls back to the
 * spoofable prefix heuristic. So the MCP list is re-derived from
 * `cyboflowMcpServer.ts` here rather than restated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCEPT_EDITS_AUTO_APPROVE_TOOLS } from '../../../../orchestrator/permissionModeMapper';
import { ACCEPT_EDITS_SAFE_READONLY_TOOLS } from '../../../../orchestrator/safeCommandClassifier';
import { decideToolCall } from '../gate/ompGateExtension';
import {
  buildOmpGateConfig,
  composeOmpMcpToolName,
  CYBOFLOW_MCP_TOOL_NAMES,
  cyboflowOmpMcpToolNames,
  OMP_AUTO_ALLOW_TOOLS,
  OMP_EDIT_TOOLS,
  toOmpToolName,
} from '../ompGateConfigBuilder';

const MCP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../../../orchestrator/mcpServer/cyboflowMcpServer.ts',
);

describe('toOmpToolName', () => {
  it("maps Claude's mcp__server__tool form onto OMP's single-underscore form", () => {
    // The one name the programmatic step runner actually denies
    // (spawnStepRunner.ts:63). OMP strips the redundant `cyboflow_` prefix.
    expect(toOmpToolName('mcp__cyboflow__cyboflow_request_verification')).toBe(
      'mcp__cyboflow_request_verification',
    );
  });

  it('sanitizes a server name the way OMP does', () => {
    // `[^a-z_]+` collapses to `_` (mcp/tool-bridge.ts:335-343).
    expect(toOmpToolName('mcp__Cyboflow-Extra__do_thing')).toBe('mcp__cyboflow_extra_do_thing');
    expect(toOmpToolName('mcp__cyboflow')).toBe('mcp__cyboflow');
  });

  it('lowercases a builtin and maps the names that genuinely differ', () => {
    expect(toOmpToolName('Bash')).toBe('bash');
    expect(toOmpToolName('Write')).toBe('write');
    expect(toOmpToolName('TodoWrite')).toBe('todo');
    expect(toOmpToolName('WebSearch')).toBe('web_search');
    expect(toOmpToolName('LS')).toBe('glob');
  });
});

describe('the cyboflow MCP tool list', () => {
  it('matches every tool cyboflowMcpServer declares (tripwire on drift)', () => {
    const source = fs.readFileSync(MCP_SERVER_SOURCE, 'utf8');
    const declared = new Set(
      [...source.matchAll(/name: '(cyboflow_[a-z_]+)'/g)].map((match) => match[1]),
    );
    expect(declared.size).toBeGreaterThan(40);
    expect([...declared].sort()).toEqual([...CYBOFLOW_MCP_TOOL_NAMES].sort());
  });

  it('composes each name the way OMP presents it to the hook', () => {
    expect(composeOmpMcpToolName('cyboflow', 'cyboflow_report_finding')).toBe(
      'mcp__cyboflow_report_finding',
    );
    expect(cyboflowOmpMcpToolNames()).toContain('mcp__cyboflow_report_finding');
    expect(cyboflowOmpMcpToolNames()).toHaveLength(CYBOFLOW_MCP_TOOL_NAMES.length);
  });
});

describe('the allowlists mirror cyboflow, not OMP', () => {
  it('covers every cyboflow read-safe tool that has an OMP counterpart', () => {
    // Read/Glob/Grep/LS/NotebookRead/TodoWrite. NotebookRead has no OMP tool at
    // all; everything else must land inside the auto-allow set.
    const mapped = [...ACCEPT_EDITS_SAFE_READONLY_TOOLS]
      .map(toOmpToolName)
      .filter((name) => name !== 'notebookread');
    for (const name of mapped) {
      expect(OMP_AUTO_ALLOW_TOOLS).toContain(name);
    }
  });

  it('covers every cyboflow edit tool that has an OMP counterpart', () => {
    // Edit/Write/MultiEdit — MultiEdit has no OMP counterpart.
    const mapped = ACCEPT_EDITS_AUTO_APPROVE_TOOLS.map(toOmpToolName).filter(
      (name) => name !== 'multiedit',
    );
    for (const name of mapped) {
      expect(OMP_EDIT_TOOLS).toContain(name);
    }
  });

  it('keeps network- and state-mutating OMP read-tier tools out of the auto-allow set', () => {
    for (const name of ['web_search', 'memory_edit', 'retain', 'checkpoint', 'rewind', 'bash']) {
      expect(OMP_AUTO_ALLOW_TOOLS).not.toContain(name);
    }
  });
});

describe('buildOmpGateConfig', () => {
  const base = { permissionMode: 'default' as const, cyboflowMcpAvailable: true };

  it('translates the deny list and always denies the subagent tool', () => {
    const config = buildOmpGateConfig({
      ...base,
      disallowedTools: ['mcp__cyboflow__cyboflow_request_verification', 'Bash', 'Bash'],
    });

    expect(config.disallowedTools).toEqual(['mcp__cyboflow_request_verification', 'bash']);
    expect(config.denyTaskTool).toBe(true);
  });

  it('omits the cyboflow MCP names for an in-place session that gets no MCP', () => {
    expect(buildOmpGateConfig({ ...base, cyboflowMcpAvailable: false }).cyboflowMcpToolNames).toEqual(
      [],
    );
    expect(buildOmpGateConfig(base).cyboflowMcpToolNames).toContain('mcp__cyboflow_report_finding');
  });

  it('carries permission rules through verbatim for the gate to parse', () => {
    const config = buildOmpGateConfig({ ...base, allowRules: ['Bash(git status:*)', 'Read'] });
    expect(config.allowRules).toEqual(['Bash(git status:*)', 'Read']);
  });

  /**
   * End-to-end against the real gate predicate: the config this builder emits
   * has to produce the decisions the mode table promises (proposal §5.3), which a
   * per-field assertion alone would not prove.
   */
  it('drives the gate to the decisions the mode table promises', () => {
    const disallowed = ['mcp__cyboflow__cyboflow_request_verification'];

    const strict = buildOmpGateConfig({ ...base, disallowedTools: disallowed });
    expect(decideToolCall({ toolName: 'read', input: {} }, strict)).toEqual({
      kind: 'allow',
      rule: 'auto-allow-tool',
    });
    expect(decideToolCall({ toolName: 'write', input: {} }, strict)).toEqual({ kind: 'ask' });
    expect(decideToolCall({ toolName: 'task', input: {} }, strict).kind).toBe('block');
    expect(decideToolCall({ toolName: 'mcp__cyboflow_report_finding', input: {} }, strict)).toEqual({
      kind: 'allow',
      rule: 'cyboflow-mcp',
    });
    // Denied even though it is one of OUR MCP tools: rule 1 runs first.
    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_request_verification', input: {} }, strict).kind,
    ).toBe('block');

    const acceptEdits = buildOmpGateConfig({ ...base, permissionMode: 'acceptEdits' });
    expect(decideToolCall({ toolName: 'write', input: {} }, acceptEdits)).toEqual({
      kind: 'allow',
      rule: 'edit-tool',
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'ls' } }, acceptEdits)).toEqual({
      kind: 'ask',
    });

    const auto = buildOmpGateConfig({
      ...base,
      permissionMode: 'auto',
      allowRules: ['Bash(git status:*)'],
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'git status' } }, auto)).toEqual({
      kind: 'allow',
      rule: 'allow-rule',
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, auto)).toEqual({
      kind: 'ask',
    });

    // dontAsk is log-only for ordinary tools, but disallowedTools and the
    // subagent denial still bite.
    const dontAsk = buildOmpGateConfig({
      ...base,
      permissionMode: 'dontAsk',
      disallowedTools: disallowed,
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, dontAsk)).toEqual({
      kind: 'allow',
      rule: 'dont-ask',
    });
    expect(decideToolCall({ toolName: 'task', input: {} }, dontAsk).kind).toBe('block');
    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_request_verification', input: {} }, dontAsk).kind,
    ).toBe('block');
  });
});
