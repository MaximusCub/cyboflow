/**
 * zod -> MCP inputSchema, and zod issue -> the `invalid_arguments` `expected`
 * string. The two derivations a registry entry gets for free from its schema.
 *
 * The MCP SDK advertises tools as JSON Schema, so a registry that holds zod
 * schemas has to emit JSON Schema for the ListTools reply. Rather than pull in
 * a converter, this walks the handful of zod nodes the tool surface actually
 * uses and emits the exact dialect the hand-written declarations used before
 * the registry existed:
 *
 *   tool   { name, description, inputSchema }
 *   schema { type: 'object', properties, required }
 *   prop   { type, description?, enum?, minItems?, maxItems?, items?,
 *            properties?, required? }
 *
 * Two rules in here are load-bearing rather than stylistic, because tests and
 * agents read the output:
 *   - the TOP-LEVEL object always emits `required`, even empty (the no-argument
 *     tools advertise `required: []`, and cyboflowMcpServer.test.ts asserts it);
 *   - a NESTED object emits `required` only when non-empty (matching what the
 *     hand-written literals did — e.g. report_finding's `impact`, whose members
 *     are all optional, has no `required` key at all).
 *
 * A zod node this does not understand THROWS at module load rather than
 * emitting a lossy schema. That is deliberate: the whole point of deriving the
 * declaration is that it cannot quietly disagree with the validator, and a
 * silently-dropped constraint would reintroduce exactly that.
 */
import { z } from 'zod';

export type JsonSchemaScalarType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface JsonSchemaNode {
  type?: JsonSchemaScalarType | [JsonSchemaScalarType, 'null'];
  description?: string;
  enum?: (string | null)[];
  minItems?: number;
  maxItems?: number;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

export interface JsonSchemaObject extends JsonSchemaNode {
  type: 'object';
  properties: Record<string, JsonSchemaNode>;
  required: string[];
}

/**
 * Schemas whose ADVERTISED shape is richer than what they validate.
 *
 * A few tool arguments are declared in detail for the model's benefit but
 * deliberately forwarded unvalidated, because the main-process handler narrows
 * them and DROPS malformed members rather than failing the call
 * (`buildFindingExtras` / `parseFindingLocations` / `parseFindingImpact` /
 * `parseViewports` / `parseVerificationTaskV1` in mcpQueryHandler.ts). Encoding
 * that as a strict zod object would turn an agent's typo into a rejected write,
 * which is the behaviour those narrowers exist to avoid.
 *
 * {@link declareAs} attaches the advertised JSON Schema to a permissive schema
 * so the declaration stays rich while validation stays loose, and the pairing
 * lives at the field rather than in a second hand-maintained table.
 */
const declaredSchemas = new WeakMap<z.ZodTypeAny, JsonSchemaNode>();

/**
 * Advertise `json` for `schema` instead of deriving it. Use ONLY where the
 * handler re-narrows the value — see {@link declaredSchemas}.
 */
export function declareAs<S extends z.ZodTypeAny>(schema: S, json: JsonSchemaNode): S {
  declaredSchemas.set(schema, json);
  return schema;
}

/** Strip the wrappers that do not change the advertised shape. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; nullable: boolean } {
  let inner = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (inner instanceof z.ZodOptional) {
      optional = true;
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodNullable) {
      nullable = true;
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner.removeDefault() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner.innerType() as z.ZodTypeAny;
    } else {
      return { inner, optional, nullable };
    }
  }
}

function isIntegerSchema(schema: z.ZodNumber): boolean {
  return schema._def.checks.some((check) => check.kind === 'int');
}

function nodeFor(schema: z.ZodTypeAny, path: string): JsonSchemaNode {
  const declared = declaredSchemas.get(schema);
  if (declared !== undefined) return { ...declared };

  const { inner, nullable } = unwrap(schema);
  const declaredInner = declaredSchemas.get(inner);
  const node: JsonSchemaNode = declaredInner !== undefined ? { ...declaredInner } : baseNodeFor(inner, path);

  if (nullable) {
    // `{ type: ['string', 'null'] }`, and a nullable enum carries null as a
    // member — the shape cyboflow_update_variant's model / execution_model /
    // agent_overrides_json advertised before the registry.
    if (typeof node.type === 'string') node.type = [node.type, 'null'];
    if (node.enum !== undefined) node.enum = [...node.enum, null];
  }

  const description = schema.description ?? inner.description;
  if (description !== undefined) node.description = description;
  return node;
}

function baseNodeFor(inner: z.ZodTypeAny, path: string): JsonSchemaNode {
  if (inner instanceof z.ZodString) return { type: 'string' };
  if (inner instanceof z.ZodBoolean) return { type: 'boolean' };
  if (inner instanceof z.ZodNumber) return { type: isIntegerSchema(inner) ? 'integer' : 'number' };
  if (inner instanceof z.ZodEnum) return { type: 'string', enum: [...(inner.options as string[])] };
  if (inner instanceof z.ZodLiteral) {
    const value = inner.value;
    if (typeof value !== 'string') throw new Error(`toInputSchema: non-string literal at ${path}`);
    return { type: 'string', enum: [value] };
  }
  if (inner instanceof z.ZodArray) {
    const node: JsonSchemaNode = { type: 'array' };
    const min = inner._def.minLength?.value;
    const max = inner._def.maxLength?.value;
    if (min !== undefined) node.minItems = min;
    if (max !== undefined) node.maxItems = max;
    node.items = nodeFor(inner.element as z.ZodTypeAny, `${path}[]`);
    return node;
  }
  if (inner instanceof z.ZodObject) return objectNode(inner as z.ZodObject<z.ZodRawShape>, path, false);
  if (inner instanceof z.ZodRecord || inner instanceof z.ZodUnknown) return { type: 'object' };
  throw new Error(`toInputSchema: unsupported zod node at ${path || '<root>'}`);
}

function objectNode(schema: z.ZodObject<z.ZodRawShape>, path: string, topLevel: boolean): JsonSchemaObject {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    const fieldSchema = field as z.ZodTypeAny;
    properties[key] = nodeFor(fieldSchema, path ? `${path}.${key}` : key);
    if (!unwrap(fieldSchema).optional) required.push(key);
  }
  const node: JsonSchemaObject = { type: 'object', properties, required };
  // A nested all-optional object advertised no `required` key at all; only the
  // top level always carries one. See the module docstring.
  if (!topLevel && required.length === 0) delete (node as JsonSchemaNode).required;
  return node;
}

/** Derive the MCP `inputSchema` a tool advertises from its zod schema. */
export function toInputSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  const { inner } = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) throw new Error('toInputSchema: tool input must be a zod object');
  return objectNode(inner as z.ZodObject<z.ZodRawShape>, '', true);
}

// ---------------------------------------------------------------------------
// zod issue -> `expected` string
// ---------------------------------------------------------------------------

/**
 * Render the offending field's shape the way the hand-written arms did:
 * `label: string`, `note: string (optional)`, `weight: integer >= 0 (optional)`,
 * `severity: 'info' | 'warning' | 'error' (optional)`.
 *
 * No test pins these strings (the assertions are all on the `invalid_arguments`
 * code), but agents read them, so they are worth reproducing rather than
 * replacing with a zod issue dump. A field whose phrasing this cannot reach —
 * a cross-field rule, or a hint like `intent: string (or task.summary)` —
 * overrides it via the entry's `expected` map instead.
 */
function renderType(schema: z.ZodTypeAny): string {
  const { inner, nullable } = unwrap(schema);
  const base = ((): string => {
    if (inner instanceof z.ZodString) return 'string';
    if (inner instanceof z.ZodBoolean) return 'boolean';
    if (inner instanceof z.ZodNumber) {
      if (!isIntegerSchema(inner)) return 'number';
      const min = inner.minValue;
      return min === null ? 'integer' : `integer >= ${min}`;
    }
    if (inner instanceof z.ZodEnum) return (inner.options as string[]).map((v) => `'${v}'`).join(' | ');
    if (inner instanceof z.ZodLiteral) return `'${String(inner.value)}'`;
    if (inner instanceof z.ZodArray) return `${renderType(inner.element as z.ZodTypeAny)}[]`;
    return 'object';
  })();
  return nullable ? `${base} | null` : base;
}

/** The field at `path` within `schema`, or undefined when the path is unknown. */
function fieldAt(schema: z.ZodTypeAny, path: PropertyKey[]): z.ZodTypeAny | undefined {
  let current = unwrap(schema).inner;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!(current instanceof z.ZodArray)) return undefined;
      current = unwrap(current.element as z.ZodTypeAny).inner;
      continue;
    }
    if (!(current instanceof z.ZodObject)) return undefined;
    const next = (current.shape as z.ZodRawShape)[String(segment)];
    if (next === undefined) return undefined;
    current = unwrap(next as z.ZodTypeAny).inner;
  }
  return current;
}

/** Build the `expected` string for the first issue in a failed parse. */
export function describeIssue(schema: z.ZodTypeAny, issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.custom) return issue.message;
  if (issue.path.length === 0) return issue.message;

  const name = issue.path.map((segment) => String(segment)).join('.');
  // Re-walk from the root so the OPTIONAL wrapper is visible: fieldAt strips it.
  const parentPath = issue.path.slice(0, -1);
  const parent = parentPath.length === 0 ? unwrap(schema).inner : fieldAt(schema, parentPath);
  const last = issue.path[issue.path.length - 1];
  const declared = parent instanceof z.ZodObject
    ? ((parent.shape as z.ZodRawShape)[String(last)] as z.ZodTypeAny | undefined)
    : undefined;
  if (declared === undefined) return `${name}: ${issue.message}`;

  const optional = unwrap(declared).optional;
  return `${name}: ${renderType(declared)}${optional ? ' (optional)' : ''}`;
}
