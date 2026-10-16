const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const executeCommand = async (command, ...args) => {
  let timer;
  try { return await Promise.race([
    vscode.commands.executeCommand(command, ...args),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out')), 45000); }),
  ]); }
  catch (error) { throw new Error(`${command}: ${String(error)}`); }
  finally { clearTimeout(timer); }
};

async function until(check, description) {
  const deadline = Date.now() + 45000;
  do {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail(description);
}

async function replace(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0),
    document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

async function complete(document, line, character, expected) {
  const deadline = Date.now() + 45000;
  do {
    const result = await executeCommand(
      'vscode.executeCompletionItemProvider', document.uri,
      new vscode.Position(line, character)
    );
    const labels = (result?.items ?? []).map(item =>
      typeof item.label === 'string' ? item.label : item.label.label);
    if (labels.includes(expected)) return;
    // The actual vscode-R language server starts asynchronously.
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert.fail(`Missing ${expected} completion in ${document.uri}`);
}

exports.run = async () => {
  await vscode.extensions.getExtension('RConsole.vsc-r-notebook').activate();
  const directory = vscode.workspace.workspaceFolders[0].uri.fsPath;
  for (const extension of ['rmd', 'qmd']) {
    const filename = path.join(directory, `completion [100% café].${extension}`);
    const name = `notebook_${extension}_function`;
    const prefix = `notebook_${extension}_`;
    await fs.writeFile(filename,
      '```{r}\n' + name + ' <- function(value) value\n' + prefix + '\n```\n');
    const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
    const document = notebook.cellAt(0).document;
    await vscode.window.showNotebookDocument(notebook, { preview: false, selections: [new vscode.NotebookRange(0, 1)] });
    await executeCommand('notebook.cell.edit');
    await until(() => vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString(),
      `Cell editor did not become active for ${extension}`);
    assert.equal(document.languageId, 'r-notebook-r');
    // Regression: notebookType makes scheme apply to the notebook URI.
    assert.equal(vscode.languages.match({ notebookType: 'r-notebook',
      language: 'r', scheme: 'vscode-notebook-cell' }, document), 0);
    await complete(document, 1, prefix.length, name);

    await replace(document, `${name}_edited <- function(value) value\n${prefix}`);
    await complete(document, 1, prefix.length, `${name}_edited`);

    await replace(document, `${name} <- function(notebook_argument) {\n  notebook_argument + 1\n}\n${name}(1)\n`);
    const position = new vscode.Position(3, 5);
    await until(async () => (await executeCommand('vscode.executeHoverProvider', document.uri, position))?.length,
      `No hover for ${extension}`);
    await until(async () => (await executeCommand('vscode.executeSignatureHelpProvider', document.uri,
      new vscode.Position(3, name.length + 1), '('))?.signatures.some(signature => signature.label.includes('notebook_argument')),
    `No signature help for ${extension}`);
    const definitions = await until(async () => {
      const items = await executeCommand('vscode.executeDefinitionProvider', document.uri, position);
      return items?.length ? items : undefined;
    }, `No definition for ${extension}`);
    for (const definition of definitions) {
      assert.equal((definition.targetUri ?? definition.uri).toString(), document.uri.toString());
      assert.equal((definition.targetSelectionRange ?? definition.range).start.line, 0);
    }
    const references = await until(async () => {
      const items = await executeCommand('vscode.executeReferenceProvider', document.uri, position);
      return items?.length ? items : undefined;
    }, `No references for ${extension}`);
    assert.ok(references.every(reference => reference.uri.toString() === document.uri.toString()));
    const rename = await executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, `${name}_renamed`);
    assert.ok(rename?.get(document.uri).length >= 2, `Rename edits did not map to ${extension} cell`);
    assert.ok(rename.entries().every(([uri]) => uri.toString() === document.uri.toString()));
    const symbols = await executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    assert.ok(symbols?.some(symbol => symbol.name === name), `No symbols for ${extension}`);
    const highlights = await executeCommand('vscode.executeDocumentHighlights', document.uri, position);
    assert.ok(highlights?.length >= 2, `No document highlights for ${extension}`);
    const selections = await executeCommand('vscode.executeSelectionRangeProvider', document.uri, [position]);
    assert.ok(selections?.[0]?.parent, `No selection ranges for ${extension}`);
    const hierarchy = await executeCommand('vscode.prepareCallHierarchy', document.uri, new vscode.Position(0, 5));
    assert.ok(hierarchy?.some(item => item.uri.toString() === document.uri.toString()),
      `Call hierarchy did not map to ${extension} cell: ${JSON.stringify(hierarchy)}`);
    const incoming = await executeCommand('vscode.provideIncomingCalls', hierarchy[0]);
    assert.ok(incoming?.some(call => call.from.uri.toString() === document.uri.toString()),
      `Incoming calls did not map to ${extension} cell`);
    const actions = await until(async () => {
      const items = await executeCommand('vscode.executeCodeActionProvider', document.uri,
        new vscode.Range(1, 2, 1, 23), 'refactor.extract');
      return items?.some(item => item.edit) ? items : undefined;
    }, `No extract refactoring for ${extension}`);
    assert.ok(actions.filter(action => action.edit).every(action =>
      action.edit.entries().every(([uri]) => uri.toString() === document.uri.toString())),
    `Refactoring edits did not map to ${extension} cell`);
    const semantic = await executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
    assert.ok(semantic?.data.length > 0, `No semantic tokens for ${extension}`);
    const folding = await executeCommand('vscode.executeFoldingRangeProvider', document.uri);
    assert.ok(folding?.length > 0, `No folding ranges for ${extension}`);
    const insert = new vscode.WorkspaceEdit();
    insert.set(notebook.uri, [vscode.NotebookEdit.insertCells(1,
      [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, `${name}(2)`, 'r')])]);
    assert.equal(await vscode.workspace.applyEdit(insert), true);
    const second = notebook.cellAt(1).document;
    await until(() => second.languageId === 'r-notebook-r', 'New R cell did not acquire notebook language mode');
    await until(async () => {
      const items = await executeCommand('vscode.executeDefinitionProvider', second.uri, new vscode.Position(0, 5));
      return items?.some(item => (item.targetUri ?? item.uri).toString() === document.uri.toString());
    }, `No definition across cells for ${extension}`);
    await replace(document, 'format_me<-c(1,2)\n');
    const formatting = await executeCommand('vscode.executeFormatDocumentProvider', document.uri, { tabSize: 2, insertSpaces: true });
    assert.ok(formatting?.length > 0, `No formatting edits for ${extension}`);
    const formatEdit = new vscode.WorkspaceEdit();
    formatEdit.set(document.uri, formatting);
    assert.equal(await vscode.workspace.applyEdit(formatEdit), true);
    assert.ok(document.getText().includes('format_me <- c(1, 2)'), `Formatting did not edit the ${extension} cell`);
    await replace(document, 'broken <- )\n');
    await until(() => vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error),
      `No syntax diagnostic mapped to ${extension} cell`);
    await replace(document, `${name} <- 1\n`);
    await until(() => !vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error),
      `Stale syntax diagnostic in ${extension} cell`);
    console.log(`${extension}: completion, edits, hover, signature, definitions across cells, references, rename, symbols, highlights, selection, call hierarchy, refactoring, semantic tokens, folding, formatting and diagnostics passed.`);
  }
  // Verify the dedicated editor language remains executable by our controller.
  const executionFile = path.join(directory, 'execution.rmd');
  await fs.writeFile(executionFile, '```{r}\n1 + 1\n```\n');
  const executionNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(executionFile));
  await vscode.window.showNotebookDocument(executionNotebook, { preview: false });
  await executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: executionNotebook.uri });
  await until(() => executionNotebook.cellAt(0).executionSummary?.success === true,
    'R (Notebook) cell did not execute');
  assert.ok(executionNotebook.cellAt(0).outputs.some(output => output.items.some(item =>
    ['text/plain', 'text/html'].includes(item.mime) && Buffer.from(item.data).toString().includes('2'))));
  console.log('R (Notebook) cell execution passed.');
  // The notebook adapter must not recurse into or break regular R documents.
  const plain = await vscode.workspace.openTextDocument({ language: 'r',
    content: 'plain_r_function <- function(value) value\nplain_r_' });
  await vscode.window.showTextDocument(plain);
  await complete(plain, 1, 8, 'plain_r_function');
  console.log('Ordinary R completion passed.');
  const notebooks = vscode.workspace.notebookDocuments.filter(notebook => notebook.notebookType === 'r-notebook');
  const document = notebooks[0].cellAt(0).document;
  await replace(document, 'restart_probe <- function(value) value\nrestart_');
  await vscode.workspace.getConfiguration('r').update('lsp.enabled', false, vscode.ConfigurationTarget.Global);
  console.log('Disabling LSP:', vscode.workspace.getConfiguration('r').get('lsp.enabled'));
  await until(async () => {
    const tokens = await executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
    return !tokens?.data.length;
  }, 'Notebook language server did not disable');
  await vscode.workspace.getConfiguration('r').update('lsp.enabled', true, vscode.ConfigurationTarget.Global);
  await complete(document, 1, 8, 'restart_probe');
  console.log('Notebook language server disable and restart passed.');
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
    .filter(tab => tab.input instanceof vscode.TabInputNotebook && tab.input.notebookType === 'r-notebook');
  const cellUris = notebooks.flatMap(notebook => notebook.getCells().map(cell => cell.document.uri));
  for (const notebook of notebooks) {
    console.log('Saving', notebook.uri.toString());
    assert.equal(await notebook.save(), true);
    const saved = await fs.readFile(notebook.uri.fsPath, 'utf8');
    assert.ok(!saved.includes('{r-notebook-r}'), 'Editor language mode leaked into saved chunks');
  }
  await vscode.window.tabGroups.close(tabs, true);
  console.log('Notebook tabs closed.');
  assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputNotebook && tab.input.notebookType === 'r-notebook')),
  'Notebook tabs did not close');
  await until(() => cellUris.every(uri => !vscode.languages.getDiagnostics(uri).length), 'Notebook diagnostics survived close');
  await until(async () => !(await executeCommand('vscode.provideDocumentSemanticTokens', document.uri))?.data.length,
    'Notebook language server survived closing its last tab');
  console.log('Notebook language service integration: Rmd, Qmd and ordinary R passed.');
};
