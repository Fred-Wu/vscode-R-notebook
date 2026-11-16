const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async ({ until, inspect }) => {
  const executionIdle = async () => {
    const states = (await inspect(`return {present:!!document.querySelector('.notebook-editor'),spinners:all('.notebook-editor .codicon-notebook-state-executing.codicon-modifier-spin').length};`, false))
      .filter(state => state.present);
    return states.length > 0 && states.every(state => state.spinners === 0);
  };
  for (const extension of ['Rmd', 'qmd']) {
    const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `rich-outputs.${extension}`);
    await fs.writeFile(filename, [
      '```{r}', '1 + 1', '```', '',
      '```{r}', 'plotly::plot_ly(x = 1:3, y = c(1, 4, 2), type = "scatter", mode = "markers")', '```', '',
    ].join('\n'));
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filename), 'r-notebook');
    const notebook = vscode.workspace.notebookDocuments.find(document => document.uri.fsPath === filename);
    assert.ok(notebook);
    for (const cell of notebook.getCells().filter(cell => cell.kind === vscode.NotebookCellKind.Code)) {
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index, end: cell.index + 1 }], document: notebook.uri });
      await until(() => typeof cell.executionSummary?.success === 'boolean', `${extension}: execution did not finish`);
      assert.equal(cell.executionSummary.success, true, cell.outputs.flatMap(output => output.items.map(item => Buffer.from(item.data).toString())).join('\n').slice(0, 1000));
      await until(executionIdle,
        `${extension}: completed cell still displays an execution spinner`);
    }
    await until(async () => (await inspect(`return all('.js-plotly-plot').some(el => el.querySelector('.scatterlayer .point') && el.getBoundingClientRect().height > 0);`, false)).some(Boolean),
      `${extension}: Plotly did not render visible data points`);
    console.log(`Notebook rendering: ${extension} Plotly displays visible data points.`);
    // Fast reruns must clear their execution indicator too (VS Code keeps it
    // visible for at least 500 ms, even after the execution has completed).
    for (let rerun = 0; rerun < 3; rerun++) {
      const previousOrder = notebook.cellAt(0).executionSummary.executionOrder;
      await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: notebook.uri });
      await until(() => notebook.cellAt(0).executionSummary?.success === true && notebook.cellAt(0).executionSummary.executionOrder > previousOrder,
        `${extension}: rerun did not complete`);
      await until(executionIdle,
        `${extension}: rerun left its execution spinner visible`);
    }
    console.log(`Notebook rendering: ${extension} execution indicators clear after simple and Plotly cells, including fast reruns.`);
    await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
  }
};
