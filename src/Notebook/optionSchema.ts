export interface OptionCompletion {
  name: string;
  values?: string[];
}

export interface CellOptionCompletions {
  rMarkdown: OptionCompletion[];
  quarto: OptionCompletion[];
}

interface SchemaNode {
  type?: unknown;
  $ref?: unknown;
  completions?: unknown;
  enum?: unknown;
  anyOf?: unknown;
  properties?: unknown;
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((candidate): candidate is string | number | boolean =>
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    )
    .map(String);
}

function schemaValues(
  node: unknown,
  definitions: Record<string, unknown>,
  visited: Set<string> = new Set()
): string[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  const schema = node as SchemaNode;
  const values = [
    ...stringValues(schema.completions),
    ...stringValues(schema.enum),
  ];
  if (schema.type === "boolean") {
    values.push("true", "false");
  }
  if (typeof schema.$ref === "string" && !visited.has(schema.$ref)) {
    visited.add(schema.$ref);
    values.push(...schemaValues(definitions[schema.$ref], definitions, visited));
  }
  if (Array.isArray(schema.anyOf)) {
    for (const choice of schema.anyOf) {
      values.push(...schemaValues(choice, definitions, new Set(visited)));
    }
  }
  return [...new Set(values)];
}

export function quartoOptionCompletions(
  definitions: unknown
): OptionCompletion[] {
  if (!definitions || typeof definitions !== "object") {
    return [];
  }
  const schemas = definitions as Record<string, unknown>;
  const engine = schemas["engine-knitr"] as SchemaNode | undefined;
  if (!engine?.properties || typeof engine.properties !== "object") {
    return [];
  }
  return Object.entries(engine.properties as Record<string, unknown>)
    .map(([name, schema]) => {
      const values = schemaValues(schema, schemas);
      return values.length > 0 ? { name, values } : { name };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
