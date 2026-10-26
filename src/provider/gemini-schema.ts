/**
 * Google's function calling validates every tool schema against its own Schema
 * subset before inference, and that subset is stricter than JSON Schema:
 *
 * - `required` and `properties` are accepted only on OBJECT nodes, and every
 *   required name must be declared in that same node's `properties`.
 * - A node carrying `anyOf`/`oneOf` must carry nothing else — no `type`,
 *   `description` or `nullable` beside it.
 * - `type: [X, 'null']` arrays are re-emitted by the AI SDK's converter as
 *   `anyOf` plus sibling keywords, which trips the rule above.
 *
 * One violating declaration fails the whole request before the model runs, and
 * third-party MCP schemas arrive exactly as their server announced them, so
 * Google targets normalize every tool schema on the way out. The scope is
 * deliberate: every other provider receives the schema as its tool declared it.
 */

type JsonSchema = Record<string, unknown>;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isSchema(value)) return value;
  return sanitizeNode(value);
}

function sanitizeNode(node: JsonSchema): JsonSchema {
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    switch (key) {
      case 'properties':
      case '$defs':
      case 'definitions':
        result[key] = isSchema(value)
          ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, sanitizeValue(child)]))
          : sanitizeValue(value);
        break;
      case 'items':
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        result[key] = sanitizeValue(value);
        break;
      default:
        result[key] = value;
    }
  }
  return normalizeNode(result);
}

function normalizeNode(node: JsonSchema): JsonSchema {
  const hasUnion = node.anyOf !== undefined || node.oneOf !== undefined;
  if (!hasUnion && Array.isArray(node.type)) {
    const nonNull = node.type.filter((entry) => entry !== 'null');
    if (nonNull.length === 1) {
      // A nullable scalar becomes its plain type. The nullability hint is dropped
      // on purpose: kept as an array, the AI SDK's converter turns it into anyOf
      // with sibling keywords and Google rejects the whole request for it.
      node.type = nonNull[0];
    } else if (nonNull.length > 1) {
      delete node.type;
      node.anyOf = nonNull.map((entry) => ({ type: entry }));
    }
  }
  // anyOf/oneOf must be the only field on their node, so the siblings go.
  // Branches were normalized before this node.
  const union = node.anyOf !== undefined ? 'anyOf' : node.oneOf !== undefined ? 'oneOf' : undefined;
  if (union !== undefined) return { [union]: node[union] };
  // `required`/`properties` without a type describe an object under JSON Schema
  // semantics; Google needs `type: object` stated before it accepts the keywords.
  // A required name on an object node without properties survives: that shape is
  // what mastra's recorded Gemini test pins after type-stamping.
  if (node.type === undefined && (node.properties !== undefined || node.required !== undefined)) node.type = 'object';
  if (node.type !== undefined && node.type !== 'object') {
    delete node.properties;
    delete node.required;
  }
  return node;
}

/** Rebuilds one tool schema for Google's function schema subset. Never mutates the input. */
export function sanitizeGeminiToolSchema(schema: JsonSchema): JsonSchema {
  return sanitizeNode(schema);
}

/**
 * The sanitizer for a model whose requests Google validates, or undefined for every
 * other target. Google reaches us through its own provider packages and through
 * gateways that carry a Gemini model id. `model` may be the SDK's model object or a
 * bare model id, because `LanguageModel` accepts both.
 */
export function geminiToolSchemaSanitizer(model: unknown): ((schema: JsonSchema) => JsonSchema) | undefined {
  const record = typeof model === 'object' && model !== null ? (model as Record<string, unknown>) : undefined;
  const provider = typeof record?.provider === 'string' ? record.provider.toLowerCase() : '';
  const modelId = typeof record?.modelId === 'string' ? record.modelId.toLowerCase() : typeof model === 'string' ? model.toLowerCase() : '';
  const google = provider.includes('google') || provider.includes('vertex') || modelId.includes('gemini');
  return google ? sanitizeGeminiToolSchema : undefined;
}
