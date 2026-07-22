import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { codeCellSource, parseDocument } from "./document";
import { codeCellLabel } from "./options";

interface StoredOutputItem {
  mime: string;
  data: string;
}

interface StoredOutput {
  items: StoredOutputItem[];
  metadata?: Record<string, unknown>;
}

export interface StoredCellOutput {
  cell: number;
  outputs: StoredOutput[];
  sourceHash: string;
  executionSummary?: {
    executionOrder?: number;
    success?: boolean;
    timing?: { startTime: number; endTime: number };
  };
}

interface StoredCell {
  kind: "markup" | "code";
  sourceHash: string;
  label?: string;
}

export interface NotebookState {
  version: 1;
  sourceHash: string;
  cells: StoredCell[];
  cellOutputs: StoredCellOutput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotebookState(value: unknown): value is NotebookState {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.version !== 1 ||
    typeof value.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
    !Array.isArray(value.cellOutputs)
  ) {
    return false;
  }
  if (
    !Array.isArray(value.cells) ||
    !value.cells.every((cell) =>
      isRecord(cell) &&
      (cell.kind === "markup" || cell.kind === "code") &&
      typeof cell.sourceHash === "string" &&
      /^[a-f0-9]{64}$/.test(cell.sourceHash) &&
      (cell.label === undefined || typeof cell.label === "string")
    )
  ) {
    return false;
  }
  return value.cellOutputs.every((cellOutput) => {
    if (
      !isRecord(cellOutput) ||
      !Number.isInteger(cellOutput.cell) ||
      (cellOutput.cell as number) < 0 ||
      !Array.isArray(cellOutput.outputs) ||
      typeof cellOutput.sourceHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(cellOutput.sourceHash)
    ) {
      return false;
    }
    const summary = cellOutput.executionSummary;
    if (summary !== undefined) {
      if (!isRecord(summary)) {
        return false;
      }
      if (
        (summary.executionOrder !== undefined && typeof summary.executionOrder !== "number") ||
        (summary.success !== undefined && typeof summary.success !== "boolean")
      ) {
        return false;
      }
      if (summary.timing !== undefined && (
        !isRecord(summary.timing) ||
        typeof summary.timing.startTime !== "number" ||
        typeof summary.timing.endTime !== "number"
      )) {
        return false;
      }
    }
    return cellOutput.outputs.every((output) =>
      isRecord(output) &&
      Array.isArray(output.items) &&
      output.items.every((item) =>
        isRecord(item) &&
        typeof item.mime === "string" &&
        typeof item.data === "string"
      ) &&
      (output.metadata === undefined || isRecord(output.metadata))
    );
  });
}

export function notebookSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function storedCells(source: string): StoredCell[] {
  const parsed = parseDocument(source);
  return parsed.cells.map((cell) => {
    const stored: StoredCell = {
      kind: cell.kind,
      sourceHash: notebookSourceHash(
        cell.kind === "code" ? codeCellSource(cell, parsed.eol) : cell.value
      ),
    };
    if (cell.kind === "code" && cell.chunk) {
      const label = codeCellLabel(cell.value, cell.chunk);
      if (label) {
        stored.label = label;
      }
    }
    return stored;
  });
}

export function reconcileNotebookState(
  source: string,
  state: NotebookState
): NotebookState {
  const sourceHash = notebookSourceHash(source);
  const cells = storedCells(source);
  if (
    state.sourceHash === sourceHash &&
    state.cells.length === cells.length &&
    state.cells.every((cell, index) => {
      const current = cells[index];
      return current?.kind === cell.kind &&
        current.sourceHash === cell.sourceHash &&
        current.label === cell.label;
    })
  ) {
    return state;
  }

  const oldCode = state.cells
    .map((cell, index) => ({ ...cell, index }))
    .filter((cell) => cell.kind === "code");
  const newCode = cells
    .map((cell, index) => ({ ...cell, index }))
    .filter((cell) => cell.kind === "code");
  const mapped = new Map<number, number>();
  const usedNew = new Set<number>();

  const matchUnique = (key: "label" | "sourceHash"): void => {
    const oldCounts = new Map<string, number>();
    const newCounts = new Map<string, number>();
    for (const cell of oldCode) {
      const value = cell[key];
      if (value && !mapped.has(cell.index)) {
        oldCounts.set(value, (oldCounts.get(value) ?? 0) + 1);
      }
    }
    for (const cell of newCode) {
      const value = cell[key];
      if (value && !usedNew.has(cell.index)) {
        newCounts.set(value, (newCounts.get(value) ?? 0) + 1);
      }
    }
    for (const oldCell of oldCode) {
      const value = oldCell[key];
      if (
        !value ||
        mapped.has(oldCell.index) ||
        oldCounts.get(value) !== 1 ||
        newCounts.get(value) !== 1
      ) {
        continue;
      }
      const newCell = newCode.find(
        (candidate) => !usedNew.has(candidate.index) && candidate[key] === value
      );
      if (newCell) {
        mapped.set(oldCell.index, newCell.index);
        usedNew.add(newCell.index);
      }
    }
  };

  matchUnique("label");
  matchUnique("sourceHash");
  const remainingOld = oldCode.filter((cell) => !mapped.has(cell.index));
  const remainingNew = newCode.filter((cell) => !usedNew.has(cell.index));
  if (remainingOld.length === remainingNew.length) {
    remainingOld.forEach((cell, index) => {
      const replacement = remainingNew[index];
      if (replacement) {
        mapped.set(cell.index, replacement.index);
      }
    });
  }

  const cellOutputs = state.cellOutputs.flatMap((output) => {
    const nextCell = mapped.get(output.cell);
    if (nextCell === undefined) {
      return [];
    }
    return [{
      ...output,
      cell: nextCell,
    }];
  });
  return {
    version: 1,
    sourceHash,
    cells,
    cellOutputs,
  };
}

function decodeNotebookState(content: Uint8Array): NotebookState | undefined {
  try {
    const parsed: unknown = JSON.parse(gunzipSync(content, {
      maxOutputLength: 512 * 1024 * 1024,
    }).toString("utf8"));
    if (!isNotebookState(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function readNotebookStateFile(
  documentPath: string
): Promise<NotebookState | undefined> {
  try {
    const content = await fsPromises.readFile(`${documentPath}.r-notebook`);
    return decodeNotebookState(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeNotebookStateFile(
  documentPath: string,
  state: NotebookState
): Promise<void> {
  await fsPromises.writeFile(
    `${documentPath}.r-notebook`,
    gzipSync(JSON.stringify(state), { level: 9 })
  );
}
