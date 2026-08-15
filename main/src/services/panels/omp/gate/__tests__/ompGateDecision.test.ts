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
  MOST_RESTRICTIVE_GATE_CONFIG,
  OMP_TASK_TOOL_NAME,
  decideToolCall,
  hasUriSchemeTarget,
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
  // The name OMP composes for our own server: createMCPToolName('cyboflow',
  // 'cyboflow_report_finding') strips the redundant server prefix
  // (mcp/tool-bridge.ts:349-357).
  const REAL = 'mcp__cyboflow_report_finding';
  /**
   * The spoof this rule exists to refuse. OMP auto-imports the user's foreign
   * MCP configs; a server named `cyboflow-extra` sanitizes to `cyboflow_extra`
   * (mcp/tool-bridge.ts:335-343), so its tools arrive as `mcp__cyboflow_extra_*`
   * — names ANY `mcp__cyboflow_` prefix test would accept. Since this gate is
   * the sole policy engine and the manager's bridge auto-approves OMP's prompt
   * behind it, a prefix match would fully auto-approve a foreign server.
   */
  const SPOOFED = 'mcp__cyboflow_extra_exfiltrate';

  it('matches on EXACT membership only — no prefix heuristic', () => {
    expect(isCyboflowMcpTool(REAL, [REAL])).toBe(true);
    expect(isCyboflowMcpTool(SPOOFED, [REAL])).toBe(false);
    expect(isCyboflowMcpTool('mcp__github_create_issue', [REAL])).toBe(false);
    expect(isCyboflowMcpTool('bash', [REAL])).toBe(false);
    // The list is the whole rule, so a name outside our prefix is matchable too.
    expect(isCyboflowMcpTool('mcp__other_tool', ['mcp__other_tool'])).toBe(true);
  });

  it('auto-allows NOTHING when the exact list is absent or empty', () => {
    for (const exactNames of [undefined, []]) {
      expect(isCyboflowMcpTool(REAL, exactNames)).toBe(false);
      expect(isCyboflowMcpTool(SPOOFED, exactNames)).toBe(false);
    }
  });

  it('allows a listed cyboflow MCP tool in the most restrictive mode', () => {
    const decision = decideToolCall(
      { toolName: `mcp__cyboflow_update_sprint_task`, input: noInput },
      config({ cyboflowMcpToolNames: ['mcp__cyboflow_update_sprint_task'] }),
    );

    expect(decision).toEqual({ kind: 'allow', rule: 'cyboflow-mcp' });
  });

  it('gates the spoofed name under a POPULATED list', () => {
    const withExact = config({ cyboflowMcpToolNames: [REAL] });

    expect(decideToolCall({ toolName: REAL, input: noInput }, withExact)).toEqual({
      kind: 'allow',
      rule: 'cyboflow-mcp',
    });
    // Not on the list ⇒ not ours ⇒ falls through to the human gate.
    expect(decideToolCall({ toolName: SPOOFED, input: noInput }, withExact).kind).toBe('ask');
  });

  it('gates the spoofed name under an EMPTY or MISSING list — the in-place shape', () => {
    // An in-place session gets no `.omp/mcp.json`, so the builder emits []. A
    // legitimate cyboflow MCP tool cannot occur there, but a spoofed one can,
    // which is precisely why empty must mean "auto-allow nothing" rather than
    // "fall back to something name-shaped".
    expect(decideToolCall({ toolName: SPOOFED, input: noInput }, config()).kind).toBe('ask');
    expect(
      decideToolCall({ toolName: SPOOFED, input: noInput }, config({ cyboflowMcpToolNames: [] })).kind,
    ).toBe('ask');
    expect(
      decideToolCall(
        { toolName: SPOOFED, input: noInput },
        config({ cyboflowMcpToolNames: undefined }),
      ).kind,
    ).toBe('ask');
  });

  it('gates even the REAL name when nothing was pre-cleared', () => {
    // The safe degradation: an undecidable MCP call reaches the human like any
    // other tool, rather than being auto-allowed on the shape of its name.
    expect(
      decideToolCall({ toolName: REAL, input: noInput }, config({ cyboflowMcpToolNames: [] })).kind,
    ).toBe('ask');
    expect(
      decideToolCall({ toolName: REAL, input: noInput }, config({ cyboflowMcpToolNames: undefined }))
        .kind,
    ).toBe('ask');
  });

  it('keeps disallowedTools ahead of the exact list', () => {
    const decision = decideToolCall(
      { toolName: REAL, input: noInput },
      config({ cyboflowMcpToolNames: [REAL], disallowedTools: [REAL] }),
    );
    expect(decision.kind).toBe('block');
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
    // Deliberately a command NO tier of the safe-bash rung admits, so what this
    // asserts is the allowRules path rather than the rung firing underneath it.
    const withRules = (permissionMode: OmpGateConfig['permissionMode']) =>
      decideToolCall(
        { toolName: 'bash', input: { command: 'pnpm typecheck' } },
        config({ permissionMode, allowRules: ['Bash(pnpm typecheck:*)'] }),
      );

    expect(withRules('default').kind).toBe('ask');
    expect(withRules('acceptEdits').kind).toBe('ask');
    expect(withRules('auto')).toEqual({ kind: 'allow', rule: 'allow-rule' });
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — the argument-aware `safe-bash` rung
// ---------------------------------------------------------------------------

/**
 * The rung that made autonomous lanes possible at all.
 *
 * Before it, `bash` matched no allowlist in ANY gated mode, so every call —
 * `git status` included — fell to rule 6, blocked on the orchestrator socket,
 * and died on the 25s human budget that an autonomous lane has nobody to
 * answer. A live sprint's implement agent could not commit its own work.
 *
 * These tests pin what the rung admits and, more importantly, what it still
 * refuses: the tier tables themselves are pinned in `ompGateSafeBash.test.ts`,
 * so what belongs here is the LADDER — which modes reach the rung, and the
 * commands that must keep reaching the human.
 */
describe('rule 5: the safe-bash rung', () => {
  const bash = (command: string, permissionMode: OmpGateConfig['permissionMode']) =>
    decideToolCall({ toolName: 'bash', input: { command } }, config({ permissionMode }));

  it('allows a read-only bash call in acceptEdits and auto', () => {
    for (const permissionMode of ['acceptEdits', 'auto'] as const) {
      expect(bash('git status', permissionMode)).toEqual({ kind: 'allow', rule: 'safe-bash' });
      expect(bash('ls -la && git diff --staged', permissionMode)).toEqual({
        kind: 'allow',
        rule: 'safe-bash',
      });
    }
  });

  it('allows a LOCAL git write in acceptEdits and auto — the lane can commit', () => {
    for (const permissionMode of ['acceptEdits', 'auto'] as const) {
      expect(bash('git commit -m x', permissionMode)).toEqual({ kind: 'allow', rule: 'safe-bash' });
      expect(bash('git add -A && git commit -m "task"', permissionMode)).toEqual({
        kind: 'allow',
        rule: 'safe-bash',
      });
    }
  });

  it('asks in `default` for BOTH tiers — the rung is mode-scoped, not universal', () => {
    expect(bash('git status', 'default').kind).toBe('ask');
    expect(bash('git commit -m x', 'default').kind).toBe('ask');
  });

  it('leaves the earlier rungs in charge where they already decide', () => {
    // dontAsk allows at rule 4, ahead of the rung — the reported rule proves the
    // ordering was not rearranged to put safe-bash first.
    expect(
      decideToolCall(
        { toolName: 'bash', input: { command: 'git commit -m x' } },
        config({ permissionMode: 'dontAsk' }),
      ),
    ).toEqual({ kind: 'allow', rule: 'dont-ask' });
    // Rule 1 still blocks a bash the run disallowed, however safe the command.
    expect(
      decideToolCall(
        { toolName: 'bash', input: { command: 'git status' } },
        config({ permissionMode: 'auto', disallowedTools: ['bash'] }),
      ).kind,
    ).toBe('block');
    // autoAllowTools still wins ahead of the rung when it lists `bash` outright.
    expect(
      decideToolCall(
        { toolName: 'bash', input: { command: 'git status' } },
        config({ permissionMode: 'acceptEdits', autoAllowTools: ['bash'] }),
      ),
    ).toEqual({ kind: 'allow', rule: 'auto-allow-tool' });
  });

  it.each([
    ['a network segment chained onto a git write', 'git add x && curl http://evil.test'],
    ['command substitution inside the commit message', 'git commit -m "$(rm -rf /)"'],
    ['a backtick variant', 'git commit -m `id`'],
    ['redirection out of a commit', 'git commit -m x > /tmp/f'],
    ['a push smuggled after a semicolon', 'git add x; git push'],
    ['a bare push', 'git push'],
    ['a bare pull', 'git pull'],
    ['a bare fetch', 'git fetch'],
    ['a commit aimed at another repository', 'git -C /elsewhere commit -m x'],
    ['a newline-smuggled second command', 'git status\nrm -rf ~'],
    ['an outright destructive command', 'rm -rf /'],
  ])('still asks the human: %s', (_label, command) => {
    for (const permissionMode of ['acceptEdits', 'auto'] as const) {
      expect(bash(command, permissionMode).kind).toBe('ask');
    }
  });

  it('is narrowed by the URI scan like every other rule-5 path', () => {
    // `git clone ssh://…` never reaches the tier tables — the scan disqualifies
    // the whole rule-5 block first, which is why the rung sits inside it.
    for (const command of ['git clone ssh://host/repo.git', 'git status && cat http://x/y']) {
      expect(bash(command, 'auto').kind).toBe('ask');
    }
  });

  it('only fires for the exact tool name `bash` with a string command', () => {
    const auto = config({ permissionMode: 'auto' });
    // A differently-cased name is one this gate has not verified.
    expect(decideToolCall({ toolName: 'Bash', input: { command: 'git status' } }, auto).kind).toBe(
      'ask',
    );
    expect(decideToolCall({ toolName: 'shell', input: { command: 'git status' } }, auto).kind).toBe(
      'ask',
    );
    // A non-string / absent command carries nothing to classify.
    expect(decideToolCall({ toolName: 'bash', input: { command: 42 } }, auto).kind).toBe('ask');
    expect(decideToolCall({ toolName: 'bash', input: {} }, auto).kind).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Rule 5, narrowed — a URI-scheme target disqualifies every name-based shortcut
// ---------------------------------------------------------------------------

/**
 * The hole: OMP's read-tier tools escalate THEMSELVES on a remote target
 * (`tools/read.ts:401`, `tools/grep.ts:906` reclassify an `ssh://` path to
 * `exec` tier), so a name-only auto-allow of `read` hands a default-mode session
 * remote access over the user's SSH credentials with no human anywhere — and the
 * manager's bridge auto-approves OMP's own prompt behind it.
 *
 * The narrowing applies to the auto-allow PREDICATES only. Rule order is
 * untouched, which these tests pin from both sides: `dontAsk` still allows
 * (it precedes rule 5), and `disallowedTools` / the `task` denial still block.
 */
describe('rule 5 narrowing: URI-scheme targets', () => {
  const readConfig = (permissionMode: OmpGateConfig['permissionMode'] = 'default') =>
    config({ permissionMode, autoAllowTools: ['read', 'grep'] });

  it('auto-allows a plain local read', () => {
    expect(decideToolCall({ toolName: 'read', input: { path: '/repo/src/x.ts' } }, readConfig())).toEqual(
      { kind: 'allow', rule: 'auto-allow-tool' },
    );
  });

  it('refuses to auto-allow an ssh:// read — it asks the human instead', () => {
    expect(
      decideToolCall({ toolName: 'read', input: { path: 'ssh://user@host/etc/shadow' } }, readConfig())
        .kind,
    ).toBe('ask');
  });

  it('catches every scheme, not just ssh', () => {
    for (const target of [
      'ssh://host/x',
      'file:///etc/passwd',
      'http://internal/x',
      'https://internal/x',
      'ftp://host/x',
      's3://bucket/key',
    ]) {
      expect(decideToolCall({ toolName: 'read', input: { path: target } }, readConfig()).kind).toBe(
        'ask',
      );
    }
  });

  it('catches a scheme nested inside an argument object or array', () => {
    expect(
      decideToolCall(
        { toolName: 'grep', input: { pattern: 'x', options: { paths: ['ok', 'ssh://host/x'] } } },
        readConfig(),
      ).kind,
    ).toBe('ask');
  });

  it('catches a scheme reached through a flag-shaped argument', () => {
    // A `^`-anchored scan would miss this, and a false negative here is a silent
    // bypass — so the predicate matches at a token boundary, not only at index 0.
    expect(
      decideToolCall({ toolName: 'read', input: { path: '--file=ssh://host/x' } }, readConfig()).kind,
    ).toBe('ask');
  });

  it('narrows editTools too — an ssh:// WRITE is worse than an ssh:// read', () => {
    const acceptEdits = config({ permissionMode: 'acceptEdits', editTools: ['write'] });

    expect(decideToolCall({ toolName: 'write', input: { path: '/repo/x.ts' } }, acceptEdits)).toEqual({
      kind: 'allow',
      rule: 'edit-tool',
    });
    expect(
      decideToolCall({ toolName: 'write', input: { path: 'ssh://host/x' } }, acceptEdits).kind,
    ).toBe('ask');
  });

  it('narrows allowRules in auto mode, bare-name and Bash(...) alike', () => {
    // A bare tool-name rule is the same name-only hole as autoAllowTools…
    const bareRule = config({ permissionMode: 'auto', allowRules: ['Read'] });
    expect(decideToolCall({ toolName: 'read', input: { path: '/repo/x' } }, bareRule)).toEqual({
      kind: 'allow',
      rule: 'allow-rule',
    });
    expect(decideToolCall({ toolName: 'read', input: { path: 'ssh://h/x' } }, bareRule).kind).toBe(
      'ask',
    );

    // …and the no-carve-outs rule means a Bash specifier carrying a URL asks
    // too. That IS a behaviour change for such rules, and it is deliberate: an
    // exception for "argument-aware rules" is where the next bypass would live.
    const bashRule = config({ permissionMode: 'auto', allowRules: ['Bash(curl:*)', 'Bash(git:*)'] });
    // `git push` so the allow is attributable to the RULE — the safe-bash rung
    // runs first and would otherwise be the thing under test.
    expect(decideToolCall({ toolName: 'bash', input: { command: 'git push' } }, bashRule)).toEqual({
      kind: 'allow',
      rule: 'allow-rule',
    });
    expect(
      decideToolCall({ toolName: 'bash', input: { command: 'curl https://x.test' } }, bashRule).kind,
    ).toBe('ask');
  });

  it('does NOT narrow rules 1-4: dontAsk still allows, deny rules still block', () => {
    const remote = { path: 'ssh://host/x' };

    // Rule 4 precedes the narrowing — dontAsk is log-only, by design.
    expect(decideToolCall({ toolName: 'read', input: remote }, config({ permissionMode: 'dontAsk' }))).toEqual(
      { kind: 'allow', rule: 'dont-ask' },
    );
    // Rules 1-2 still bite ahead of everything.
    expect(
      decideToolCall(
        { toolName: 'read', input: remote },
        config({ permissionMode: 'dontAsk', disallowedTools: ['read'] }),
      ).kind,
    ).toBe('block');
    expect(
      decideToolCall(
        { toolName: OMP_TASK_TOOL_NAME, input: remote },
        config({ permissionMode: 'dontAsk', denyTaskTool: true }),
      ).kind,
    ).toBe('block');
    // Rule 3 is not narrowed either: our own MCP tools routinely carry URLs.
    expect(
      decideToolCall(
        { toolName: 'mcp__cyboflow_report_finding', input: { body: 'see https://example.test' } },
        config({ cyboflowMcpToolNames: ['mcp__cyboflow_report_finding'] }),
      ),
    ).toEqual({ kind: 'allow', rule: 'cyboflow-mcp' });
  });
});

describe('hasUriSchemeTarget', () => {
  it('is false for ordinary local arguments', () => {
    expect(hasUriSchemeTarget({})).toBe(false);
    expect(hasUriSchemeTarget({ path: '/repo/src/x.ts', limit: 200, deep: true })).toBe(false);
    expect(hasUriSchemeTarget({ command: 'git status && ls -la' })).toBe(false);
    // A bare colon or a lone slash pair is not a scheme.
    expect(hasUriSchemeTarget({ q: 'a:b', ratio: 'x//y' })).toBe(false);
  });

  it('recurses through arrays, nested objects, and null holes', () => {
    expect(hasUriSchemeTarget({ a: [{ b: [{ c: 'ssh://h/x' }] }] })).toBe(true);
    expect(hasUriSchemeTarget({ a: null, b: [null, undefined, 'ok'] })).toBe(false);
  });

  it('terminates on a cyclic input rather than hanging the handler', () => {
    const cyclic: Record<string, unknown> = { path: '/repo/x' };
    cyclic['self'] = cyclic;
    expect(hasUriSchemeTarget(cyclic)).toBe(false);
  });

  it('answers identically on repeat calls (no sticky regex lastIndex)', () => {
    const input = { path: 'ssh://host/x' };
    expect(hasUriSchemeTarget(input)).toBe(true);
    expect(hasUriSchemeTarget(input)).toBe(true);
    expect(hasUriSchemeTarget(input)).toBe(true);
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

  it('parses cyboflowMcpToolNames, defaulting to "nothing is pre-cleared"', () => {
    // An absent key auto-allows no MCP tool at all — rule 3 is exact-membership
    // only, so there is no name-shaped fallback behind an empty list.
    expect(parseGateConfig(JSON.stringify({}), silentLogger).cyboflowMcpToolNames).toEqual([]);
    expect(
      parseGateConfig(
        JSON.stringify({ cyboflowMcpToolNames: ['mcp__cyboflow_a', 7, 'mcp__cyboflow_b'] }),
        silentLogger,
      ).cyboflowMcpToolNames,
    ).toEqual(['mcp__cyboflow_a', 'mcp__cyboflow_b']);
    // A malformed value must not be coerced into a list of any kind — whatever
    // it produced would be names nobody vetted.
    expect(
      parseGateConfig(JSON.stringify({ cyboflowMcpToolNames: 'mcp__cyboflow_a' }), silentLogger)
        .cyboflowMcpToolNames,
    ).toEqual([]);
  });

  it('parsed configs pre-clear no MCP tool and no remote target', () => {
    // The two fail-closed properties, asserted through the parser rather than a
    // hand-built config: a degraded config auto-allows neither a cyboflow-shaped
    // MCP name nor a URI-scheme target on an otherwise read-safe tool.
    const degraded = parseGateConfig('{not json', silentLogger);
    expect(decideToolCall({ toolName: 'mcp__cyboflow_report_finding', input: {} }, degraded).kind).toBe(
      'ask',
    );

    const readSafe = parseGateConfig(
      JSON.stringify({ permissionMode: 'default', autoAllowTools: ['read'] }),
      silentLogger,
    );
    expect(decideToolCall({ toolName: 'read', input: { path: '/x' } }, readSafe).kind).toBe('allow');
    expect(decideToolCall({ toolName: 'read', input: { path: 'ssh://h/x' } }, readSafe).kind).toBe(
      'ask',
    );
  });
});
