import { execFile } from "node:child_process";
import { load as loadYaml } from "js-yaml";

export interface QuartoFormats {
  document: string[];
  project: string[];
}

export interface QuartoFormatInspection extends QuartoFormats {
  extensionFormats: Record<string, string[]>;
}

export interface QuartoFrontMatterFormats {
  specified: boolean;
  formats: string[];
}

export interface QuartoCompletionDocumentationCandidate {
  type?: "key" | "value";
  value: string;
  description?: string;
  schema?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function quartoCompletionDocumentation(
  candidate: QuartoCompletionDocumentationCandidate,
  schemas: Record<string, unknown>
): string | undefined {
  let schema = record(candidate.schema);
  if (candidate.type === "key") {
    const key = /^([^:\r\n]+):/.exec(candidate.value)?.[1]?.trim();
    const properties = record(schema?.properties);
    schema = key ? record(properties?.[key]) ?? schema : schema;
  }
  for (let depth = 0; schema && depth < 10; depth += 1) {
    const identifier = typeof schema.$ref === "string"
      ? schema.$ref
      : typeof schema.$id === "string"
        ? schema.$id
        : undefined;
    const resolved = identifier ? record(schemas[identifier]) : undefined;
    if (!resolved || resolved === schema) {
      break;
    }
    schema = resolved;
  }
  const tags = record(schema?.tags);
  const tagged = tags?.description;
  if (typeof tagged === "string") {
    return tagged;
  }
  const taggedRecord = record(tagged);
  if (typeof taggedRecord?.long === "string") {
    return taggedRecord.long;
  }
  if (typeof taggedRecord?.short === "string") {
    return taggedRecord.short;
  }
  if (typeof schema?.documentation === "string") {
    return schema.documentation;
  }
  if (typeof schema?.description === "string") {
    return schema.description;
  }
  return schema ? undefined : candidate.description;
}

export function quartoFormatApplies(
  restrictedFormats: readonly unknown[],
  formats: QuartoFormats
): boolean {
  const restrictions = restrictedFormats.filter(
    (format): format is string => typeof format === "string"
  );
  if (restrictions.length === 0) {
    return true;
  }
  const active = new Set([...formats.document, ...formats.project]);
  return restrictions.some((format) => active.has(format));
}

export function quartoFormatNames(value: unknown): string[] {
  const names = new Set<string>();
  const add = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.trim()) {
      names.add(candidate.trim());
    } else if (Array.isArray(candidate)) {
      candidate.forEach(add);
    } else if (candidate && typeof candidate === "object") {
      Object.keys(candidate).forEach((name) => {
        if (name.trim()) {
          names.add(name.trim());
        }
      });
    }
  };
  add(value);
  return [...names];
}

export function quartoFrontMatterFormatContext(
  source: string
): QuartoFrontMatterFormats {
  const opening = /^---[ \t]*(?:\r\n|\n|\r)/.exec(source);
  if (!opening) {
    return { specified: false, formats: [] };
  }
  const rest = source.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/m.exec(rest);
  const yaml = closing ? rest.slice(0, closing.index) : rest;
  const formatKey = /^[ \t]*(?:"format"|'format'|format)[ \t]*:/m.test(yaml);
  try {
    const parsed = record(loadYaml(yaml));
    return {
      specified: Boolean(
        parsed &&
        Object.prototype.hasOwnProperty.call(parsed, "format")
      ),
      formats: quartoFormatNames(parsed?.format),
    };
  } catch {
    return { specified: formatKey, formats: [] };
  }
}

export function parseQuartoInspectionFormats(
  inspection: unknown
): QuartoFormatInspection {
  const inspected = record(inspection);
  const document = new Set<string>();
  const formats = record(inspected?.formats);
  for (const [name, value] of Object.entries(formats ?? {})) {
    document.add(name);
    const identifier = record(record(value)?.identifier);
    for (const field of ["target-format", "base-format"]) {
      const format = identifier?.[field];
      if (typeof format === "string" && format) {
        document.add(format);
      }
    }
  }
  const projectInfo = record(inspected?.project);
  const project = record(projectInfo?.config);
  const extensionFormats: Record<string, string[]> = {};
  if (Array.isArray(projectInfo?.extensions)) {
    for (const candidate of projectInfo.extensions) {
      const extension = record(candidate);
      const id = record(extension?.id);
      const name = id?.name;
      const organization = id?.organization;
      const contributed = record(record(extension?.contributes)?.formats);
      if (typeof name !== "string" || !contributed) {
        continue;
      }
      const extensionNames = typeof organization === "string"
        ? [name, `${organization}/${name}`]
        : [name];
      for (const baseFormat of Object.keys(contributed)) {
        if (baseFormat !== "common") {
          for (const extensionName of extensionNames) {
            extensionFormats[`${extensionName}-${baseFormat}`] = [baseFormat];
          }
        }
      }
    }
  }
  return {
    document: [...document],
    project: quartoFormatNames(project?.format),
    extensionFormats,
  };
}

export function mergeQuartoFormats(
  frontMatter: QuartoFrontMatterFormats,
  savedFrontMatter: QuartoFrontMatterFormats,
  inspected: QuartoFormatInspection
): QuartoFormats {
  const expand = (formats: readonly string[]): string[] => [
    ...new Set(formats.flatMap((format) => [
      format,
      ...(inspected.extensionFormats[format] ?? []),
    ])),
  ];
  const unchanged = frontMatter.specified === savedFrontMatter.specified &&
    frontMatter.formats.length === savedFrontMatter.formats.length &&
    frontMatter.formats.every((format) =>
      savedFrontMatter.formats.includes(format)
    );
  if (unchanged) {
    return {
      document: inspected.document,
      project: expand(inspected.project),
    };
  }
  return {
    document: frontMatter.specified
      ? expand(frontMatter.formats)
      : (
        inspected.project.length > 0
          ? expand(inspected.project)
          : ["html"]
      ),
    project: expand(inspected.project),
  };
}

export function inspectQuartoFormats(
  executable: string,
  notebookPath: string
): Promise<QuartoFormatInspection> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["inspect", notebookPath, "--quiet"],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseQuartoInspectionFormats(JSON.parse(stdout)));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}
