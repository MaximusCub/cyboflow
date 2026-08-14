/**
 * Decision-matrix + config-parsing tests for the OMP gating extension.
 *
 * `decideToolCall` is the whole policy engine (docs/proposals/omp-provider-
 * integration.md §5.3): OMP's own tool tiers are never the trust boundary, so
 * every widening or narrowing of the boundary has to show up here.
 *
 * The invariant these tests exist to protect: NOTHING fails open. A missing or
 * malformed config, an unknown mode, an unrecognized rule kind — each lands on
 * the most restrictive behaviour, and rules 1-2 (disallowedTools, the `task`
 * subagent tool) hold even in `dontAsk`.
 */
import { describe, it, expect } from 'vitest';
import {
  CYBOFLOW_MCP_TOOL_PREFIX,
  MOST_RESTRICTIVE_GATE_CONFIG,
  OMP_TASK_TOOL_NAME,
  decideToolCall,
  isCyboflowMcpTool,
  matchesAllowRules,
  parseGateConfig,
  parsePermissionRule,
  splitShellSegments,
  type OmpGateLogger,
} from '../ompGateExtension';
import type { OmpGateConfig } from '../ompGateTypes';

const silentLogger: OmpGateLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function config(overrides: Partial<OmpGateConfig> = {}): OmpGateConfig {
  return { ...MOST_RESTRICTIVE_GATE_CONFIG, ...overrides };
}

const noInput: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Rule 1 — disallowedTools
// ---------------------------------------------------------------------------

describe('rule 1: disallowedTools', () => {
  it('blocks a disallowed tool and names both the tool and disallowedTools', () => {
    const decision = decideToolCall(
      { toolName: 'bash', input: noInput },
      config({ disallowedTools: ['bash'] }),
    );

    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;
    expect(decision.reason).toContain('bash');
    expect(decision.reason).toContain('disallowedTools');
  });

  it.each(['default', 'acceptEdits', 'auto', 'dontAsk'] as const)(
    'blocks in %s mode even when every other allowlist would permit it',
    (permissionMode) => {
      const decision = decideToolCall(
        { toolName: 'write', input: noInput },
        config({
          permissionMode,
          disallowedTools: ['write'],
          autoAllowTools: ['write'],
          editTools: ['write'],
          allowRules: ['write'],
        }),
      );

      expect(decision.kind).toBe('block');
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — OMP's `task` subagent tool
// ---------------------------------------------------------------------------

describe('rule 2: the task subagent tool', () => {
  it('blocks `task` when denyTaskTool is set, citing unverified subagent scope', () => {
    const decision = decideToolCall(
      { toolName: OMP_TASK_TOOL_NAME, input: noInput },
      config({ denyTaskTool: true }),
    );

    expect(decision.kind).toBe('block');
    if (decision.kind !== 'block') return;
    expect(decision.reason).toContain('subagent');
  });

  it('blocks `task` even in dontAsk mode', () => {
    const decision = decideToolCall(
      { toolName: OMP_TASK_TOOL_NAME, input: noInput },
      config({ permissionMode: 'dontAsk', denyTaskTool: true }),
    );

    expect(decision.kind).toBe('block');
  });

  it('falls through to the normal gate when denyTaskTool is false', () => {
    const decision = decideToolCall(
      { toolName: OMP_TASK_TOOL_NAME, input: noInput },
      config({ denyTaskTool: false }),
    );

    expect(decision.kind).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — cyboflow's own MCP tools
// ---------------------------------------------------------------------------

describe('rule 3: cyboflow MCP tools', () => {
  it('recognizes the name OMP composes for the cyboflow server', () => {
    // createMCPToolName('cyboflow', 'cyboflow_report_finding') strips the
    // redundant server prefix (mcp/tool-bridge.ts:349-357).
    expect(isCyboflowMcpTool('mcp__cyboflow_report_finding')).toBe(true);
    expect(isCyboflowMcpTool('mcp__github_create_issue')).toBe(false);
    expect(isCyboflowMcpTool('bash')).toBe(false);
  });

  it('allows a cyboflow MCP tool in the most restrictive mode', () => {
    const decision = decideToolCall(
      { toolName: `${CYBOFLOW_MCP_TOOL_PREFIX}update_sprint_task`, input: noInput },
      config(),
    );

    expect(decision).toEqual({ kind: 'allow', rule: 'cyboflow-mcp' });
  });

  it('still blocks a cyboflow MCP tool that is explicitly disallowed', () => {
    const toolName = `${CYBOFLOW_MCP_TOOL_PREFIX}report_finding`;
    const decision = decideToolCall(
      { toolName, input: noInput },
      config({ disallowedTools: [toolName] }),
    );

    expect(decision.kind).toBe('block');
  });

  describe('exact names close the prefix-spoofing hole', () => {
    // OMP auto-imports foreign MCP configs. A server named `cyboflow-extra`
    // sanitizes to `cyboflow_extra` (mcp/tool-bridge.ts:335-343), so its tools
    // are named `mcp__cyboflow_extra_*` — which the prefix heuristic accepts.
    const SPOOFED = 'mcp__cyboflow_extra_exfiltrate';
    const REAL = 'mcp__cyboflow_report_finding';

    it('the prefix heuristic ALLOWS the spoofed name (the hole being closed)', () => {
      expect(isCyboflowMcpTool(SPOOFED)).toBe(true);
      expect(decideToolCall({ toolName: SPOOFED, input: noInput }, config()).kind).toBe('allow');
    });

    it('an exact list blocks the spoofed name while still allowing the real one', () => {
      const withExact = config({ cyboflowMcpToolNames: [REAL] });

      expect(decideToolCall({ toolName: REAL, input: noInput }, withExact)).toEqual({
        kind: 'allow',
        rule: 'cyboflow-mcp',
      });
      // Not on the list ⇒ not ours ⇒ falls through to the human gate.
      expect(decideToolCall({ toolName: SPOOFED, input: noInput }, withExact).kind).toBe('ask');
    });

    it('consults ONLY the exact list when one is supplied', () => {
      expect(isCyboflowMcpTool(REAL, [REAL])).toBe(true);
      expect(isCyboflowMcpTool(SPOOFED, [REAL])).toBe(false);
      // A name outside the prefix entirely is still matchable by exact list.
      expect(isCyboflowMcpTool('mcp__other_tool', ['mcp__other_tool'])).toBe(true);
    });

    it('falls back to the prefix when the list is absent or empty', () => {
      expect(isCyboflowMcpTool(SPOOFED, undefined)).toBe(true);
      expect(isCyboflowMcpTool(SPOOFED, [])).toBe(true);
      expect(decideToolCall({ toolName: REAL, input: noInput }, config({ cyboflowMcpToolNames: [] }))).toEqual(
        { kind: 'allow', rule: 'cyboflow-mcp' },
      );
    });

    it('keeps disallowedTools ahead of the exact list', () => {
      const decision = decideToolCall(
        { toolName: REAL, input: noInput },
        config({ cyboflowMcpToolNames: [REAL], disallowedTools: [REAL] }),
      );
      expect(decision.kind).toBe('block');
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — dontAsk
// ---------------------------------------------------------------------------

describe('rule 4: dontAsk', () => {
  it('allows an otherwise-gated tool', () => {
    const decision = decideToolCall(
      { toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
      config({ permissionMode: 'dontAsk' }),
    );

    expect(decision).toEqual({ kind: 'allow', rule: 'dont-ask' });
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — the mode-scoped allowlists
// ---------------------------------------------------------------------------

describe('rule 5: mode-scoped allowlists', () => {
  it('auto-allows a read-safe tool in every gated mode', () => {
    for (const permissionMode of ['default', 'acceptEdits', 'auto'] as const) {
      const decision = decideToolCall(
        { toolName: 'read', input: noInput },
        config({ permissionMode, autoAllowTools: ['read'] }),
      );
      expect(decision).toEqual({ kind: 'allow', rule: 'auto-allow-tool' });
    }
  });

  it('honors editTools ONLY in acceptEdits and auto', () => {
    const withEdits = (permissionMode: OmpGateConfig['permissionMode']) =>
      decideToolCall(
        { toolName: 'write', input: noInput },
        config({ permissionMode, editTools: ['write', 'edit'] }),
      );

    expect(withEdits('default').kind).toBe('ask');
    expect(withEdits('acceptEdits')).toEqual({ kind: 'allow', rule: 'edit-tool' });
    expect(withEdits('auto')).toEqual({ kind: 'allow', rule: 'edit-tool' });
  });

  it('honors allowRules ONLY in auto', () => {
    const withRules = (permissionMode: OmpGateConfig['permissionMode']) =>
      decideToolCall(
        { toolName: 'bash', input: { command: 'git status' } },
        config({ permissionMode, allowRules: ['Bash(git status:*)'] }),
      );

    expect(withRules('default').kind).toBe('ask');
    expect(withRules('acceptEdits').kind).toBe('ask');
    expect(withRules('auto')).toEqual({ kind: 'allow', rule: 'allow-rule' });
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — the default
// ---------------------------------------------------------------------------

describe('rule 6: undecidable calls', () => {
  it('asks the human for anything no rule covers', () => {
    expect(decideToolCall({ toolName: 'browser', input: noInput }, config()).kind).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Allow-rule matching — the honored subset
// ---------------------------------------------------------------------------

describe('allow-rule matching', () => {
  it('parses bare and specifier rules like permissionRules.ts does', () => {
    expect(parsePermissionRule('WebSearch')).toEqual({ toolName: 'WebSearch' });
    expect(parsePermissionRule('Bash(git add:*)')).toEqual({
      toolName: 'Bash',
      content: 'git add:*',
    });
    expect(parsePermissionRule('Bash(')).toBeNull();
    expect(parsePermissionRule('   ')).toBeNull();
  });

  it('matches tool names case-insensitively so Claude-cased rules reach OMP tools', () => {
    // The deliberate divergence: cyboflow's rules say `Bash`, OMP's tool is `bash`.
    expect(matchesAllowRules('bash', { command: 'ls' }, ['Bash(ls:*)'])).toBe(true);
    expect(matchesAllowRules('grep', {}, ['Grep'])).toBe(true);
  });

  it('grants the whole tool for a bare tool-name rule', () => {
    expect(matchesAllowRules('web_search', { q: 'x' }, ['web_search'])).toBe(true);
  });

  it('requires EVERY segment of a compound command to match', () => {
    const rules = ['Bash(git status:*)'];
    expect(matchesAllowRules('bash', { command: 'git status && rm -rf /' }, rules)).toBe(false);
    expect(matchesAllowRules('bash', { command: 'git status && git status -s' }, rules)).toBe(true);
  });

  it('refuses any segment containing command substitution', () => {
    expect(matchesAllowRules('bash', { command: 'git status $(whoami)' }, ['Bash(git status:*)'])).toBe(
      false,
    );
  });

  it('splits on unquoted separators only', () => {
    expect(splitShellSegments("echo 'a && b' && ls")).toEqual(["echo 'a && b'", 'ls']);
  });

  it('does not honor path-glob or domain specifiers (conservative default)', () => {
    expect(matchesAllowRules('read', { path: '/etc/passwd' }, ['Read(/etc/**)'])).toBe(false);
    expect(matchesAllowRules('fetch', { url: 'https://example.com' }, ['fetch(domain:example.com)'])).toBe(
      false,
    );
  });

  it('never matches when no rule targets the tool', () => {
    expect(matchesAllowRules('bash', { command: 'ls' }, ['Read'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config parsing — never fails open
// ---------------------------------------------------------------------------

describe('parseGateConfig', () => {
  it('falls back to the most restrictive policy when the env var is missing', () => {
    expect(parseGateConfig(undefined, silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
    expect(parseGateConfig('   ', silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
  });

  it('falls back to the most restrictive policy on unparseable JSON', () => {
    expect(parseGateConfig('{not json', silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
  });

  it('falls back to the most restrictive policy for a non-object payload', () => {
    expect(parseGateConfig('"a string"', silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
    expect(parseGateConfig('[1,2,3]', silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
    expect(parseGateConfig('null', silentLogger)).toEqual(MOST_RESTRICTIVE_GATE_CONFIG);
  });

  it('narrows an unknown permissionMode to `default`', () => {
    const parsed = parseGateConfig(JSON.stringify({ permissionMode: 'yolo' }), silentLogger);
    expect(parsed.permissionMode).toBe('default');
  });

  it('drops non-string list members instead of trusting them', () => {
    const parsed = parseGateConfig(
      JSON.stringify({ permissionMode: 'auto', autoAllowTools: ['read', 42, null, 'grep'] }),
      silentLogger,
    );
    expect(parsed.autoAllowTools).toEqual(['read', 'grep']);
  });

  it('treats a malformed list as empty rather than inheriting anything', () => {
    const parsed = parseGateConfig(
      JSON.stringify({ permissionMode: 'auto', editTools: 'write' }),
      silentLogger,
    );
    expect(parsed.editTools).toEqual([]);
  });

  it('denies the task tool unless denyTaskTool is EXPLICITLY false', () => {
    expect(parseGateConfig(JSON.stringify({}), silentLogger).denyTaskTool).toBe(true);
    expect(
      parseGateConfig(JSON.stringify({ denyTaskTool: 'no' }), silentLogger).denyTaskTool,
    ).toBe(true);
    expect(parseGateConfig(JSON.stringify({ denyTaskTool: false }), silentLogger).denyTaskTool).toBe(
      false,
    );
  });

  it('round-trips a well-formed config', () => {
    const source: OmpGateConfig = {
      permissionMode: 'acceptEdits',
      disallowedTools: ['task'],
      autoAllowTools: ['read', 'grep', 'glob'],
      editTools: ['write', 'edit'],
      allowRules: ['Bash(git status:*)'],
      denyTaskTool: false,
      cyboflowMcpToolNames: ['mcp__cyboflow_report_finding'],
    };
    expect(parseGateConfig(JSON.stringify(source), silentLogger)).toEqual(source);
  });

  it('parses cyboflowMcpToolNames, defaulting to the empty prefix-fallback', () => {
    expect(parseGateConfig(JSON.stringify({}), silentLogger).cyboflowMcpToolNames).toEqual([]);
    expect(
      parseGateConfig(
        JSON.stringify({ cyboflowMcpToolNames: ['mcp__cyboflow_a', 7, 'mcp__cyboflow_b'] }),
        silentLogger,
      ).cyboflowMcpToolNames,
    ).toEqual(['mcp__cyboflow_a', 'mcp__cyboflow_b']);
    // A malformed value must not become a one-entry list, which would silently
    // narrow rule 3 to nothing.
    expect(
      parseGateConfig(JSON.stringify({ cyboflowMcpToolNames: 'mcp__cyboflow_a' }), silentLogger)
        .cyboflowMcpToolNames,
    ).toEqual([]);
  });
});
