export interface OptionCompletion {
  name: string;
  values?: string[];
}

export interface CellOptionCompletions {
  rMarkdown: OptionCompletion[];
  quarto: OptionCompletion[];
}

interface KnitrDocumentedOptionValues {
  header: readonly string[];
  pipe: readonly string[];
}

const KNITR_DOCUMENTED_OPTION_VALUES: Readonly<
  Record<string, KnitrDocumentedOptionValues>
> = {
  results: {
    header: ["'markup'", "'asis'", "'hold'", "'hide'", "FALSE"],
    pipe: ["markup", "asis", "hold", "hide", "false"],
  },
  tidy: {
    header: ["FALSE", "TRUE", "'formatR'", "'styler'"],
    pipe: ["false", "true", "formatR", "styler"],
  },
  warning: {
    header: ["TRUE", "FALSE", "NA"],
    pipe: ["true", "false"],
  },
  message: {
    header: ["TRUE", "FALSE", "NA"],
    pipe: ["true", "false"],
  },
  error: {
    header: ["FALSE", "TRUE", "0", "1", "2"],
    pipe: ["false", "true", "0", "1", "2"],
  },
  "fig.keep": {
    header: ["'high'", "'none'", "'all'", "'first'", "'last'"],
    pipe: ["high", "none", "all", "first", "last"],
  },
  "fig.show": {
    header: ["'asis'", "'hold'", "'animate'", "'hide'"],
    pipe: ["asis", "hold", "animate", "hide"],
  },
  "fig.align": {
    header: ["'default'", "'left'", "'right'", "'center'"],
    pipe: ["default", "left", "right", "center"],
  },
};

export function knitrOptionCompletions(output: string): CellOptionCompletions {
  const headerOptions = new Map<string, OptionCompletion>();
  const pipeNames = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [kind, name, type, pipeName] = line.split("\t", 4);
    if (kind !== "option" || !name) {
      continue;
    }
    const documented = KNITR_DOCUMENTED_OPTION_VALUES[name];
    headerOptions.set(name, documented
      ? { name, values: [...documented.header] }
      : type === "logical"
        ? { name, values: ["TRUE", "FALSE"] }
        : { name });
    if (pipeName) {
      pipeNames.set(name, pipeName);
    }
  }
  const rMarkdown = [...headerOptions.values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  const quarto = rMarkdown.map((completion) => {
    const documented = KNITR_DOCUMENTED_OPTION_VALUES[completion.name];
    return {
      name: pipeNames.get(completion.name) ?? completion.name,
      ...(documented
        ? { values: [...documented.pipe] }
        : completion.values
          ? {
            values: completion.values.map((value) =>
              value === "TRUE" ? "true" : value === "FALSE" ? "false" : value
            ),
          }
          : {}),
    };
  });
  return { rMarkdown, quarto };
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
