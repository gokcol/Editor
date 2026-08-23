export type JsonDocumentSummary = {
  valid: boolean;
  value?: unknown;
  message: string;
  line?: number;
  column?: number;
};

type JsonSchema = Record<string, unknown>;

const MAX_SCHEMA_DEPTH = 7;
const MAX_SCHEMA_PROPERTIES = 72;
const MAX_SCHEMA_ARRAY_SAMPLES = 20;

function describeValue(value: unknown) {
  if (Array.isArray(value)) return `Top-level array · ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') {
    const count = Object.keys(value as Record<string, unknown>).length;
    return `Top-level object · ${count} key${count === 1 ? '' : 's'}`;
  }
  return `Top-level ${value === null ? 'null' : typeof value}`;
}

function positionAt(source: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, safeOffset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

function positionFromJsonError(source: string, message: string) {
  const offsetMatch = /position\s+(\d+)/i.exec(message);
  if (offsetMatch) return positionAt(source, Number(offsetMatch[1]));
  const lineColumnMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(message);
  if (lineColumnMatch) return { line: Number(lineColumnMatch[1]), column: Number(lineColumnMatch[2]) };
  return undefined;
}

function nextNonWhitespace(source: string, start: number) {
  for (let index = start; index < source.length; index += 1) {
    if (!/\s/.test(source[index])) return index;
  }
  return -1;
}

/**
 * Reflow JSON while copying every literal lexeme verbatim. Using
 * JSON.stringify(JSON.parse(source)) would round an otherwise-valid integer
 * such as 9007199254740993, which is unacceptable for a source editor.
 */
function prettyJsonSource(source: string) {
  let output = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (/\s/.test(character)) continue;

    if (character === '{' || character === '[') {
      const close = character === '{' ? '}' : ']';
      const next = nextNonWhitespace(source, index + 1);
      if (next >= 0 && source[next] === close) {
        output += `${character}${close}`;
        index = next;
      } else {
        output += `${character}\n`;
        depth += 1;
        output += '  '.repeat(depth);
      }
      continue;
    }

    if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1);
      output = output.replace(/[ \t]*$/, '');
      output += `\n${'  '.repeat(depth)}${character}`;
      continue;
    }

    if (character === ',') {
      output += `,\n${'  '.repeat(depth)}`;
      continue;
    }
    if (character === ':') {
      output += ': ';
      continue;
    }
    output += character;
  }

  return `${output.trimEnd()}\n`;
}

/** Remove whitespace outside string tokens without ever reserializing JSON. */
function minifyJsonSource(source: string) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const character of source) {
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (!/\s/.test(character)) output += character;
  }

  return `${output}\n`;
}

/**
 * Parse JSON once and retain a compact, UI-ready result. This intentionally
 * uses the browser JSON parser, so the editor and preview agree on validity.
 */
export function inspectJson(source: string): JsonDocumentSummary {
  if (!source.trim()) {
    return { valid: false, message: 'JSON document is empty.', line: 1, column: 1 };
  }

  try {
    const value = JSON.parse(source) as unknown;
    return { valid: true, value, message: `Valid JSON · ${describeValue(value)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The document is not valid JSON.';
    const position = positionFromJsonError(source, message);
    return { valid: false, message: `Invalid JSON · ${message}`, ...position };
  }
}

export function formatJson(source: string) {
  const result = inspectJson(source);
  return result.valid ? prettyJsonSource(source) : undefined;
}

export function minifyJson(source: string) {
  const result = inspectJson(source);
  return result.valid ? minifyJsonSource(source) : undefined;
}

function schemaFor(value: unknown, depth: number): JsonSchema {
  if (depth >= MAX_SCHEMA_DEPTH) return {};
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const samples = value.slice(0, MAX_SCHEMA_ARRAY_SAMPLES);
    if (!samples.length) return { type: 'array', items: {} };
    const variants = new Map<string, JsonSchema>();
    for (const item of samples) {
      const schema = schemaFor(item, depth + 1);
      variants.set(JSON.stringify(schema), schema);
    }
    const schemas = [...variants.values()];
    return {
      type: 'array',
      items: schemas.length === 1 ? schemas[0] : { anyOf: schemas },
    };
  }
  if (typeof value === 'object') {
    const properties: Record<string, JsonSchema> = Object.create(null);
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SCHEMA_PROPERTIES)) {
      properties[key] = schemaFor(child, depth + 1);
    }
    return {
      type: 'object',
      properties,
      // A single source file is an example, not proof that unseen keys are
      // invalid. Keep the generated schema permissive by default.
      additionalProperties: true,
    };
  }
  return { type: typeof value };
}

/**
 * Produce a deliberately permissive JSON Schema draft from observed values.
 * It is an editable starting point, never a claim that missing keys are
 * prohibited or that all items in a data set share an identical shape.
 */
export function inferJsonSchema(source: string): { schema?: JsonSchema; error?: JsonDocumentSummary } {
  const result = inspectJson(source);
  if (!result.valid) return { error: result };
  return {
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Inferred JSON schema',
      ...schemaFor(result.value, 0),
    },
  };
}
