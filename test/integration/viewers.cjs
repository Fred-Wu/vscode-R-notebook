const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

// Use the sess build bundled with the installed vscode-R on R's library path
// (set R_LIBS if needed) to run unattended in the runner's fresh profile.

async function until(check, description) {
  const deadline = Date.now() + 60000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail(description);
}

function viewerTabs(name) {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
    tab.input instanceof vscode.TabInputWebview &&
    tab.input.viewType.endsWith('dataview') && tab.label === name);
}

exports.run = async () => {
  await vscode.extensions.getExtension('RConsole.vsc-r-notebook').activate();
  const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'viewers.rmd');
  const table = 'table with "quotes"';
  const list = 'list with spaces';
  await fs.writeFile(filename, [
    '```{r}',
    'stopifnot(!"tools:vscode" %in% search())',
    `assign(${JSON.stringify(table)}, data.frame(value = 1:3, label = c("a", "b", "c")), envir = .GlobalEnv)`,
    `assign(${JSON.stringify(list)}, list(table = get(${JSON.stringify(table)}), nested = list(value = 42)), envir = .GlobalEnv)`,
    'View <- function(...) stop("The notebook must use the sess-installed utils::View")',
    '```',
    '',
  ].join('\n'));
  const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
  await vscode.window.showNotebookDocument(notebook, { preview: false });
  await vscode.commands.executeCommand('notebook.cell.execute', {
    ranges: [{ start: 0, end: 1 }], document: notebook.uri,
  });
  await until(() => typeof notebook.cellAt(0).executionSummary?.success === 'boolean', 'Notebook fixture did not execute');
  assert.equal(notebook.cellAt(0).executionSummary.success, true,
    `Viewer fixture failed in R: ${notebook.cellAt(0).outputs.flatMap(output =>
      output.items.map(item => Buffer.from(item.data).toString())).join('\n')}`);

  for (const name of [table, list]) {
    await vscode.commands.executeCommand('r-notebook.viewWorkspaceObject', { label: name });
    await until(() => viewerTabs(name).length === 1, `vscode-R did not open the viewer for ${name}`);
    // Repeated requests should reuse the viewer owned by this notebook session.
    await vscode.commands.executeCommand('r-notebook.viewWorkspaceObject', { label: name });
    assert.equal(viewerTabs(name).length, 1, `Duplicate viewer for ${name}`);
  }
  console.log('Notebook viewers: data frame and nested list opened through the real sess attachment; quoted names, masked global View and viewer reuse passed.');
};
