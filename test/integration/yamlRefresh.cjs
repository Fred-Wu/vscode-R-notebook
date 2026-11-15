const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async ({ until, inspect }) => {
  const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'yaml-refresh.Rmd');
  await fs.writeFile(filename, [
    '---', 'title: Initial title', 'author: Initial author',
    'output:', '  html_document:', '    toc: false', '---', '',
    '# Introduction', '', 'A paragraph.', '',
    '```{r}', 'cat("yaml-session-responsive")', '```', '',
    '# Results', '', 'Another paragraph.', '',
  ].join('\n'));
  const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
  await vscode.window.showNotebookDocument(notebook, { preview: false });
  const rendered = async (toc, title, author) => (await inspect(`
    const header = all('[data-r-notebook-document-header]')[0];
    return header?.querySelector('.title')?.textContent.trim() === ${JSON.stringify(title)}
      && header.textContent.includes(${JSON.stringify(author)})
      && Boolean(header.querySelector('[data-r-notebook-toc] a')) === ${toc};
  `, false)).some(Boolean);
  await until(() => rendered(false, 'Initial title', 'Initial author'), 'Initial YAML header did not render');
  console.log('Notebook rendering: initial YAML header rendered.');
  for (const [index, toc] of [true, false, true].entries()) {
    const cell = notebook.cellAt(0);
    const text = cell.document.getText();
    const next = text.replace(/toc: (true|false)/, `toc: ${toc}`)
      .replace(/title: .*/, `title: Updated title ${index}`)
      .replace(/author: .*/, `author: Updated author ${index}`);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell.document.uri, new vscode.Range(cell.document.positionAt(0), cell.document.positionAt(text.length)), next);
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => rendered(toc, `Updated title ${index}`, `Updated author ${index}`), `YAML edit ${index} did not refresh header (toc=${toc})`);
    console.log(`Notebook rendering: YAML edit ${index} rendered.`);
  }
  for (let index = 0; index < 8; index++) {
    const cell = notebook.cellAt(0);
    const text = cell.document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell.document.uri, new vscode.Range(cell.document.positionAt(0), cell.document.positionAt(text.length)),
      text.replace(/toc: (true|false)/, `toc: ${index % 2 === 1}`)
        .replace(/title: .*/, `title: Rapid title ${index}`));
    assert.ok(await vscode.workspace.applyEdit(edit));
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // Execute before the last preview settles: the controller gives code priority,
  // but must request the cancelled preview again after that execution finishes.
  const code = notebook.getCells().find(cell => cell.kind === vscode.NotebookCellKind.Code);
  await vscode.commands.executeCommand('notebook.cell.execute', {
    ranges: [{ start: code.index, end: code.index + 1 }], document: notebook.uri,
  });
  await until(() => code.executionSummary?.success === true, 'YAML changes left cell execution stuck');
  await until(() => rendered(true, 'Rapid title 7', 'Updated author 2'), 'Rapid YAML edits did not recover');
  console.log('Notebook rendering: YAML title, author and TOC edits refresh; subsequent R execution completes.');
  await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
};
