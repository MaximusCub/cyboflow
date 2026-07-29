/**
 * Parity test for flows that ship COPIED subagents instead of authoring their own.
 *
 * Ship = Planner's plan/refine set ⊕ Sprint's execute/verify set, shipped as
 * VERBATIM copies under `ship/agents/` (the bundle resolver is path-based, so
 * ship cannot reference the planner/sprint files directly). Launch reuses the
 * SAME plan/refine set under `launch/agents/` (its super-planner phases mirror
 * planner's), plus one flow-owned agent — `interview.md` — that has no source
 * to copy from; it originates in Launch itself. Copies drift: the sprint
 * dependency-analyzer once gained a stale-state-file hardening paragraph that
 * ship's copy silently missed. This test locks every copied agent to its
 * planner/sprint source file so any future edit to one side fails the suite
 * until the copy is re-synced (or the divergence is declared intentional
 * below), and locks every OWNED agent to never silently collide with a
 * planner/sprint filename (which would make the "is this a copy or original?"
 * question ambiguous for a future reader).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';

const workflowsDir = path.join(__dirname, '..');

/** One flow whose `agents/` bundle is (mostly) copied from planner/sprint sources. */
interface FlowParitySpec {
  /** Flow name — used for describe() labels and to resolve `<flow>/agents`. */
  flow: string;
  /** Flow names whose `agents/` dir may be a copy's source (existence + collision checks). */
  sourceFlows: readonly string[];
  /**
   * Basenames that ORIGINATE in this flow's own `agents/` dir — never parity-
   * checked against a source, but asserted to exist and to never collide with
   * a same-named file in any `sourceFlows` dir.
   */
  ownedFiles: ReadonlySet<string>;
  /**
   * Copied filenames allowed to diverge from their source. Empty today for both
   * flows — add a filename here ONLY for a deliberate, reviewed divergence, with
   * a comment saying why the copy needs different prose.
   */
  intentionalDivergence: ReadonlySet<string>;
}

const FLOWS: readonly FlowParitySpec[] = [
  {
    flow: 'ship',
    sourceFlows: ['planner', 'sprint'],
    ownedFiles: new Set(),
    intentionalDivergence: new Set(),
  },
  {
    flow: 'launch',
    sourceFlows: ['planner', 'sprint'],
    ownedFiles: new Set(['interview.md']),
    intentionalDivergence: new Set(),
  },
];

for (const spec of FLOWS) {
  const copyAgentsDir = path.join(workflowsDir, spec.flow, 'agents');
  const sourceDirs = spec.sourceFlows.map((flow) => path.join(workflowsDir, flow, 'agents'));
  /** First sourceDir containing `file`, or `undefined` if none does. */
  const findSource = (file: string): string | undefined =>
    sourceDirs.find((dir) => {
      try {
        readFileSync(path.join(dir, file));
        return true;
      } catch {
        return false;
      }
    });

  describe(`${spec.flow} agent parity`, () => {
    const copiedAgents = readdirSync(copyAgentsDir)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !spec.ownedFiles.has(f));

    it(`${spec.flow} ships only agents that exist in ${spec.sourceFlows.join('/')} or are declared owned`, () => {
      for (const file of copiedAgents) {
        expect(findSource(file), `${file} has no ${spec.sourceFlows.join('/')} source`).toBeDefined();
      }
    });

    for (const file of copiedAgents) {
      if (spec.intentionalDivergence.has(file)) continue;
      it(`${file} matches its ${spec.sourceFlows.join('/')} source verbatim`, () => {
        const sourceDir = findSource(file);
        if (!sourceDir) return; // covered by the existence test above
        const source = readFileSync(path.join(sourceDir, file), 'utf8');
        const copy = readFileSync(path.join(copyAgentsDir, file), 'utf8');
        expect(copy, `${file} drifted from ${path.basename(sourceDir)} source`).toBe(source);
      });
    }

    for (const file of spec.ownedFiles) {
      it(`${file} is ${spec.flow}-owned: exists, and no ${spec.sourceFlows.join('/')} file shares its name`, () => {
        expect(() => readFileSync(path.join(copyAgentsDir, file), 'utf8')).not.toThrow();
        expect(
          findSource(file),
          `${file} is declared ${spec.flow}-owned but also exists in ${spec.sourceFlows.join('/')} — ` +
            `resolve the collision (rename one side) before this can stay owned`,
        ).toBeUndefined();
      });
    }
  });
}
