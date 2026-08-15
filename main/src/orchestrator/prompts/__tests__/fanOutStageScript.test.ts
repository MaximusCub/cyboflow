/**
 * Unit tests for the fan-out STAGE script renderer.
 *
 * The important ones are the safety tests: the emitted file is JavaScript that a
 * separate runtime executes, and its name is joined into a filesystem path, so
 * free-form workflow/step/agent ids must not be able to escape either. Note that
 * `parseScriptMeta` (the tracker's reader) is a deliberately fail-soft REGEX
 * scanner — it will happily accept syntactically invalid source — so real syntax
 * validation here goes through the JS parser, not through that.
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import {
  fanOutStageLogicalName,
  fanOutStageWorkflowName,
  isHostOwnedInnerStep,
  renderFanOutStageScript,
  renderFanOutStageScripts,
  slugSegment,
} from '../fanOutStageScript';
import { parseScriptMeta } from '../../dynamicWorkflows/scriptMeta';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import type { FanOutInnerStep, FanOutSpec, WorkflowStep } from '../../../../../shared/types/workflows';

const INNER: FanOutInnerStep[] = [
  { id: 'implement', agent: 'implement', name: 'Implement' },
  { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
  { id: 'visual-verify', agent: 'visual-verify', name: 'Visual verify', optional: true },
];

const FAN_OUT: FanOutSpec = { over: 'tasks', inner: INNER, maxConcurrency: 5 };

const STEP: WorkflowStep = {
  id: 'execute',
  name: 'Execute',
  agent: 'orchestrator',
  mcps: [],
  retries: 0,
  fanOut: FAN_OUT,
};

/**
 * Syntax-check the emitted source the way the workflow runtime consumes it: the
 * `export const meta` declaration is lifted off, and the remaining body runs
 * inside an async function (which is what legalizes its top-level `await` and
 * top-level `return`). Compiling that shape with `vm.Script` is a real parse —
 * unlike `parseScriptMeta`, which is a fail-soft regex scanner and would accept
 * broken source. `vm.SourceTextModule` is deliberately not used: it needs
 * --experimental-vm-modules, and it would reject the top-level return anyway.
 */
function assertParses(source: string): void {
  const body = source.replace(/^export\s+const\s+meta\s*=/m, 'const meta =');
  const wrapped = `(async (args, agent, parallel, pipeline, log, phase, workflow, budget) => {\n${body}\n})`;
  expect(() => new vm.Script(wrapped, { filename: 'stage.js' })).not.toThrow();
}

describe('slugSegment', () => {
  it('reduces free-form input to a filename-safe segment', () => {
    expect(slugSegment('Sprint Flow')).toBe('sprint-flow');
    expect(slugSegment('write_tests')).toBe('write-tests');
    expect(slugSegment('  --Weird--  ')).toBe('weird');
  });

  it('neutralizes path traversal and separators', () => {
    expect(slugSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(slugSegment('a/b')).toBe('a-b');
    expect(slugSegment('..')).toBe('');
    expect(slugSegment('/')).toBe('');
  });

  it('returns empty for input with no usable characters', () => {
    expect(slugSegment('***')).toBe('');
    expect(slugSegment('')).toBe('');
  });

  it('caps segment length', () => {
    expect(slugSegment('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('naming', () => {
  it('pairs the logical name with the invocable name (writer adds the prefix exactly once)', () => {
    expect(fanOutStageLogicalName('sprint', 'execute', 'implement')).toBe('sprint-execute-implement');
    expect(fanOutStageWorkflowName('sprint', 'execute', 'implement')).toBe('cyboflow-sprint-execute-implement');
  });

  it('does not double the cyboflow- prefix when the flow is already named that way', () => {
    const invocable = fanOutStageWorkflowName('cyboflow', 'execute', 'implement');
    expect(invocable).toBe('cyboflow-cyboflow-execute-implement');
    // The LOGICAL name is what the writer prefixes — assert the writer's output
    // basename would carry exactly one leading namespace segment beyond the flow.
    expect(`cyboflow-${fanOutStageLogicalName('cyboflow', 'execute', 'implement')}`).toBe(invocable);
  });

  it('is null when any segment cannot be slugged', () => {
    expect(fanOutStageLogicalName('***', 'execute', 'implement')).toBeNull();
    expect(fanOutStageWorkflowName('sprint', '', 'implement')).toBeNull();
  });
});

describe('host-owned stages', () => {
  it('recognizes visual-verify by id and by agent', () => {
    expect(isHostOwnedInnerStep({ id: 'visual-verify', agent: 'x' })).toBe(true);
    expect(isHostOwnedInnerStep({ id: 'renamed', agent: 'visual-verify' })).toBe(true);
    expect(isHostOwnedInnerStep({ id: 'implement', agent: 'implement' })).toBe(false);
  });

  it('never renders a script for the visual merge-gate', () => {
    expect(renderFanOutStageScript('sprint', STEP, FAN_OUT, INNER[2])).toBeNull();
  });
});

describe('renderFanOutStageScript', () => {
  const source = renderFanOutStageScript('sprint', STEP, FAN_OUT, INNER[0]) as string;

  it('emits parseable JavaScript', () => {
    expect(source).not.toBeNull();
    assertParses(source);
  });

  it('emits a meta literal the tracker can read back', () => {
    const meta = parseScriptMeta(source);
    expect(meta.name).toBe('cyboflow-sprint-execute-implement');
    expect(meta.phases.map((p) => p.title)).toEqual(['Implement']);
  });

  it('binds the stage to its cyboflow- agent definition', () => {
    expect(source).toContain('"cyboflow-implement"');
    expect(source).toContain('agentType: AGENT_TYPE');
  });

  it('never emits worktree isolation (lanes share one worktree)', () => {
    expect(source).not.toContain('isolation');
  });

  it('never emits constructs that throw inside a script body', () => {
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/Math\.random\(\)/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });

  it('carries a domain-outcome schema rather than keying on promise rejection', () => {
    expect(source).toContain("'blocked'");
    expect(source).toContain("required: ['outcome', 'summary']");
    // A null agent slot becomes a failed item, never a silently dropped one.
    expect(source).toContain("outcome: 'failed'");
  });

  it('returns an empty result set for an empty wave', () => {
    expect(source).toContain('return { stage: STAGE_ID, results: [] }');
  });

  it('is null when the spec has no inner steps', () => {
    const empty: FanOutSpec = { over: 'tasks', inner: [] };
    expect(renderFanOutStageScript('sprint', STEP, empty, INNER[0])).toBeNull();
  });
});

describe('injection safety', () => {
  const hostile = [
    'quote"break',
    "apos'break",
    'back`tick',
    'dollar${expr}',
    'new\nline',
    'back\\slash',
    'unicode- -sep',
  ];

  for (const raw of hostile) {
    it(`survives a hostile agent id: ${JSON.stringify(raw)}`, () => {
      const inner: FanOutInnerStep = { id: 'implement', agent: raw, name: raw };
      const spec: FanOutSpec = { over: 'tasks', inner: [inner] };
      const source = renderFanOutStageScript('sprint', STEP, spec, inner);
      expect(source).not.toBeNull();
      assertParses(source as string);
    });
  }

  it('survives a hostile workflow name in the description without breaking the source', () => {
    const inner: FanOutInnerStep = { id: 'implement', agent: 'implement' };
    const spec: FanOutSpec = { over: 'tasks', inner: [inner] };
    const step: WorkflowStep = { ...STEP, id: 'exec"ute\n' };
    const source = renderFanOutStageScript('sprint', step, spec, inner);
    // The id still slugs to something usable, and the source stays valid.
    expect(source).not.toBeNull();
    assertParses(source as string);
  });
});

describe('renderFanOutStageScripts over the real sprint definition', () => {
  const def = resolveWorkflowDefinition('sprint', '{}');
  const steps = def === null ? [] : def.phases.flatMap((p) => p.steps);
  const scripts = renderFanOutStageScripts('sprint', steps);

  it('renders one script per scriptable inner stage and skips the visual gate', () => {
    expect(scripts.length).toBeGreaterThan(0);
    const names = scripts.map((s) => s.name);
    expect(names.some((n) => n.endsWith('-implement'))).toBe(true);
    expect(names.some((n) => n.endsWith('-visual-verify'))).toBe(false);
  });

  it('every rendered script parses and round-trips its meta', () => {
    for (const script of scripts) {
      assertParses(script.content);
      expect(parseScriptMeta(script.content).name).toBe(`cyboflow-${script.name}`);
    }
  });

  it('produces unique names', () => {
    const names = scripts.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
