import { AGENT_PROVIDERS, type AgentProvider } from './agentRuntime';

export const CLAUDE_MODEL_ALIASES = [
  'fable',
  'opus',
  'opus-250k',
  'sonnet',
  'sonnet-250k',
  'haiku',
] as const;

export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** Renderer-safe projection of one entry returned by Codex `model/list`. */
export interface CodexModelOption {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface CodexModelCatalog {
  models: CodexModelOption[];
  defaultModel: string | null;
}

/**
 * Renderer-safe projection of one Agent-SDK `ModelInfo` row — the DYNAMIC Claude
 * catalog fetched via the bundled SDK's `supportedModels()` control request
 * (authenticated by the user's own Claude Code login, no API key). These populate
 * the "Other models" section BELOW the four curated/pinned families in the picker.
 */
export interface ClaudeModelOption {
  /** Model id to persist/spawn (`ModelInfo.value`). */
  id: string;
  /** Canonical wire id this row resolves to (`ModelInfo.resolvedModel`) — used to
   * de-dupe a dynamic row against the pinned families (e.g. `claude-opus-5`). */
  resolvedModel?: string;
  /** Human-readable label (`ModelInfo.displayName`). */
  label: string;
  /** Capability tagline (`ModelInfo.description`). */
  description: string;
}

export interface ClaudeModelCatalog {
  models: ClaudeModelOption[];
  defaultModel: string | null;
}

const CLAUDE_MODEL_ALIAS_SET = new Set<string>(CLAUDE_MODEL_ALIASES);

export function isClaudeModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return CLAUDE_MODEL_ALIAS_SET.has(key) || key.startsWith('claude-');
}

export function isCodexModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return key.startsWith('gpt-') || key.startsWith('codex-') || /^o[1-9](?:-|$)/.test(key);
}

export function isCodexModelSelection(model: string): boolean {
  const key = model.toLowerCase().trim();
  return key === 'auto' || key === 'default' || isCodexModelFamily(key);
}

/**
 * The Codex-family model to fall back to when a Claude-family value would
 * otherwise be paired with a Codex runtime. `'auto'` lets Codex pick, so it is
 * safe wherever a concrete model is not required.
 *
 * Declared here rather than in the renderer's ModelSelector (which re-exports
 * it) so the non-UI launch seams can reach it without a hook importing from a
 * component.
 */
export const DEFAULT_CODEX_MODEL = 'auto';

/**
 * Which provider owns a model id, one predicate per provider. Adding a provider
 * is one entry here (the Record is exhaustive over `AgentProvider`, so the
 * compiler demands it) rather than another arm in a cross-provider if/else.
 *
 * Predicates take the already-lowercased, already-trimmed id; each is
 * independently idempotent under lowercasing so they stay callable directly.
 */
export const AGENT_MODEL_FAMILY_PREDICATES: Readonly<
  Record<AgentProvider, (key: string) => boolean>
> = {
  claude: isClaudeModelFamily,
  codex: isCodexModelFamily,
};

/**
 * Normalize a persisted picker value against the provider that owns it.
 *
 * This preserves valid user-facing aliases such as `opus`, `sonnet`, and `gpt-*`
 * while dropping stale cross-provider values that can remain after changing a
 * session/workflow runtime. `default` is treated as no explicit selection; `auto`
 * is preserved because existing UI/read-model paths may display it even though
 * spawn seams omit the model flag for it.
 *
 * The rule is "drop a value another provider's family claims", not "keep only
 * what this provider's family claims" — an id no predicate recognizes (a raw
 * catalogue id, `auto`) belongs to whoever is asking and is preserved.
 */
export function normalizeAgentModelSelection(
  provider: AgentProvider,
  model?: string | null,
): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;

  const key = value.toLowerCase();
  if (key === 'default') return undefined;

  for (const other of AGENT_PROVIDERS) {
    if (other === provider) continue;
    if (AGENT_MODEL_FAMILY_PREDICATES[other](key)) return undefined;
  }
  return value;
}
