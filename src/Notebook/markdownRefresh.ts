/** Text edits in existing Markdown cells can change headings and references
 * in *other* cells, even though no cell was inserted or removed. */
export function changedMarkupRequiresRefresh(
  changes: readonly { cell: { kind: number }; document?: unknown }[]
): boolean {
  // vscode.NotebookCellKind.Markup is 1.
  return changes.some((change) =>
    change.cell.kind === 1 && change.document !== undefined
  );
}
