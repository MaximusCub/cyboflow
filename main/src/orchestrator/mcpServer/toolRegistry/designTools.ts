/**
 * Design-session tool family (Design Mode v0) — the ONLY tools advertised and
 * reachable when CYBOFLOW_MCP_SCOPE=design.
 *
 * Deliberately minimal (design-mode.md "Session plumbing"): read the linked
 * idea, persist the design-spec draft, acknowledge a delivered feedback batch
 * (Design Mode v1's outbox ack), report the prototype, and mint a single
 * follow-up backlog TASK (the style-kit consent gate's "Add a task to the
 * backlog" option).
 *
 * `cyboflow_report_artifact` and `cyboflow_create_task` are the SAME tools the
 * run scope advertises, NARROWED here — report_artifact to the two prototype
 * atypes, create_task to a minimal arg set whose task_type and category are
 * pinned by `toEnvelope` rather than taken from the caller. That narrowing is
 * why the scopes are separate tables keyed by (scope, name) rather than one
 * table keyed by name.
 */
import { z } from 'zod';
import { defineTool, type RegisteredTool } from './defineTool';

/** `'P0' | 'P1' | ...` — the phrasing the design scope's arm used. */
const PRIORITY_EXPECTED = "priority: 'P0'..'P6' (optional)";

export const DESIGN_SCOPE_TOOLS: readonly RegisteredTool[] = [
  defineTool({
    name: 'cyboflow_design_get_idea',
    description:
      "READ-ONLY: return THIS design session's linked idea — its ref, title, full markdown body, and version. No arguments (the idea is resolved from the session's design_idea_id, re-validated every call). Read it first, every session, before grounding a design. If the idea link is broken (the idea was deleted or decomposed mid-session) this errors with 'idea_link_broken' — tell the user and stop writing.",
    input: z.object({}),
    envelope: 'mcp-design-get-idea',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_design_update_draft',
    description:
      "Persist the current design-spec draft for THIS session (standalone markdown, '### '-level subsections; the host owns the wrapping '## Design spec' H2). Each call mints a new monotonic draft_revision bound to the session's CURRENT ui-prototype artifact revision, so Approve can CAS-reject a draft written against an older prototype. Returns { draftRevision, boundArtifactRevision } (boundArtifactRevision is null when no prototype exists yet). Refresh the draft right after every prototype re-report so the pair stays in lockstep.",
    input: z.object({
      spec_markdown: z
        .string()
        .min(1)
        .describe(
          "The full current design-spec markdown (required). Begin at '### ' subsection level (e.g. '### Baseline', '### Design', '### Implementation notes') — do NOT emit the wrapping '## Design spec' H2 yourself.",
        ),
    }),
    envelope: 'mcp-design-update-draft',
    toEnvelope: (args) => ({ specMarkdown: args.spec_markdown }),
  }),

  defineTool({
    name: 'cyboflow_design_ack_feedback',
    description:
      "Acknowledge a batch of design feedback AFTER you have applied it and re-reported the prototype. The host sends the feedback as a revision turn carrying a batch id and an attempt id — echo both back here VERBATIM, together with the prototype artifact revision that now contains the change (the `boundArtifactRevision` cyboflow_design_update_draft returns after your re-report). This is what moves the batch to 'applied' and marks the user's comments addressed: WITHOUT it the feedback stays open no matter what you changed. First ack wins — a duplicate or late ack for the same batch is acknowledged-and-discarded (returns { applied: false }), never an error, so acknowledging a batch you suspect was already handled is always safe.",
    input: z.object({
      batch_id: z.string().min(1).describe('The feedback batch id from the revision turn, verbatim (required).'),
      attempt_id: z.string().min(1).describe('The delivery attempt id from the revision turn, verbatim (required).'),
      prototype_revision: z
        .number()
        .int()
        .describe(
          'The prototype artifact revision that now contains the applied feedback (required) — the `boundArtifactRevision` returned by cyboflow_design_update_draft after your re-report.',
        ),
    }),
    envelope: 'mcp-design-ack-feedback',
    expected: { prototype_revision: 'prototype_revision: integer' },
    toEnvelope: (args) => ({
      batchId: args.batch_id,
      attemptId: args.attempt_id,
      prototypeRevision: args.prototype_revision,
    }),
  }),

  defineTool({
    name: 'cyboflow_report_artifact',
    description:
      'Create or update THIS design session\'s single prototype mockup. Only **`ui-prototype`** (static HTML+CSS, no JS) or **`interactive-prototype`** (JS-enabled canvas) are reportable in a design session — no other artifact type. Write a self-contained index.html to $CYBOFLOW_RUN_ARTIFACTS_DIR/prototype/index.html and pass payload_json {"fileName":"prototype/index.html"} — an inline "html" key is rejected. There is ONE prototype per session: re-reporting ENRICHES it in place (and advances its revision). Returns { artifactId }.',
    input: z.object({
      atype: z
        .enum(['ui-prototype', 'interactive-prototype'])
        .describe("Artifact type (required) — 'ui-prototype' or 'interactive-prototype' in a design session."),
      label: z.string().min(1).describe('Short tab/card label for the prototype (required)'),
      payload_json: z
        .string()
        .describe(
          'Optional JSON payload: {"fileName":"prototype/index.html"} pointing at the static HTML+CSS mockup you already wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR (a top-level "html" key is rejected — write the file, don\'t inline it).',
        )
        .optional(),
    }),
    envelope: 'mcp-report-artifact',
    expected: {
      atype: 'atype: ui-prototype | interactive-prototype (design sessions report only a prototype)',
    },
    toEnvelope: (args) => ({ atype: args.atype, label: args.label, payloadJson: args.payload_json }),
  }),

  defineTool({
    name: 'cyboflow_create_task',
    description:
      'Create ONE backlog TASK for follow-up work surfaced during this design session — canonically the style-kit consent gate\'s "Add a task to the backlog" option (a task to create the project\'s design system later). NARROWED in design scope: always creates a task_type=\'task\' entity (category \'chore\'); ideas, epics, and every other backlog write are unavailable here. Returns { task_id, ref }.',
    input: z.object({
      title: z.string().min(1).describe('Task title (required)'),
      body: z
        .string()
        .describe(
          'Optional markdown body — what to build and any decisions already made (e.g. the intended style-kit location).',
        )
        .optional(),
      priority: z
        .enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'])
        .describe("Optional priority (P0-P6); defaults to 'P2'.")
        .optional(),
    }),
    envelope: 'mcp-create-task',
    expected: { priority: PRIORITY_EXPECTED },
    // taskType/category are pinned here, never taken from the caller: a design
    // session mints follow-up TASKS only.
    toEnvelope: (args) => ({
      title: args.title,
      taskType: 'task' as const,
      category: 'chore' as const,
      body: args.body,
      priority: args.priority,
    }),
  }),
];
