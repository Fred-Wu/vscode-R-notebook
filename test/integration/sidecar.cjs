const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const vscode = require('vscode');

exports.run = async ({ until, inspect }) => {
  await vscode.workspace.getConfiguration('notebook').update('globalToolbarShowLabel', 'never', vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const buttons = () => inspect(`return all('.notebook-toolbar-container .codicon-notebook-clear').filter(el => el.offsetWidth > 0).map(el => ({ disabled: el.getAttribute('aria-disabled'), classes: el.className }));`, false);
  async function clearOutputs(notebook) {
    await until(async () => (await buttons()).flat().some(button => button.disabled !== 'true' && !button.classes.includes('disabled')),
      'Native Clear All Outputs is disabled despite existing outputs');
    const clickId = JSON.stringify(randomUUID());
    await inspect(`for (const el of all('.notebook-toolbar-container .codicon-notebook-clear')) {
      if (el.offsetWidth > 0 && el.getAttribute('aria-disabled') !== 'true' && el.dataset.testClickId !== ${clickId}) {
        el.dataset.testClickId = ${clickId}; el.click();
      }
    } return true;`, false);
    await until(() => notebook.getCells().every(cell => cell.outputs.length === 0), 'Clear All Outputs did not clear results');
    await until(async () => {
      const visible = (await buttons()).flat();
      return visible.length > 0 && visible.every(button => button.disabled === 'true' || button.classes.includes('disabled'));
    }, 'Native Clear All Outputs stayed enabled after clearing outputs');
  }
  for (const extension of ['rmd', 'qmd']) {
    const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `restored-outputs.${extension}`);
    const source = '```{r}\nstop("Restoring outputs must not run this cell")\n```\n';
    const hash = value => createHash('sha256').update(value).digest('hex');
    const summary = { executionOrder: 7, success: true, timing: { startTime: 1000, endTime: 2000 } };
    await fs.writeFile(filename, source);
    await fs.writeFile(`${filename}.r-notebook`, gzipSync(JSON.stringify({
      version: 1, sourceHash: hash(source), cells: [{ kind: 'code', sourceHash: hash(source) }],
      cellOutputs: [{ cell: 0, sourceHash: hash(source), executionSummary: summary,
        outputs: [{ items: [{ mime: 'text/plain', data: Buffer.from('Saved output').toString('base64') }] }] }],
    })));
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filename), 'r-notebook', { preview: false });
    const notebook = vscode.workspace.notebookDocuments.find(document => document.uri.fsPath === filename);
    assert.ok(notebook);
    await until(() => notebook.cellAt(0).outputs.length > 0, 'Sidecar outputs were not restored');
    assert.deepEqual(notebook.cellAt(0).executionSummary, summary);
    await until(async () => (await inspect(`return all('.notebook-toolbar-container').some(el => el.offsetWidth > 0);`, false)).some(Boolean), 'Notebook toolbar was not visible');
    await until(async () => (await buttons()).flat().some(button => button.disabled !== 'true' && !button.classes.includes('disabled')),
      'Native Clear All Outputs is disabled after restoring outputs');
    assert.deepEqual(notebook.cellAt(0).executionSummary, summary, 'Restoration must not fabricate a new execution');
    await clearOutputs(notebook);
    await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
    await until(async () => JSON.parse(gunzipSync(await fs.readFile(`${filename}.r-notebook`))).cellOutputs.length === 0,
      'Cleared results were not saved to the sidecar');
    assert.equal(await fs.readFile(filename, 'utf8'), source);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filename), 'r-notebook', { preview: false });
    const reopened = vscode.workspace.notebookDocuments.find(document => document.uri.fsPath === filename);
    assert.ok(reopened);
    assert.equal(reopened.cellAt(0).outputs.length, 0);
    await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
    console.log(`Notebook rendering: ${extension} saved outputs clear and stay cleared without executing cells.`);

    const freshFilename = path.join(path.dirname(filename), `fresh-outputs.${extension}`);
    await fs.writeFile(freshFilename, '```{r}\n1 + 1\n```\n');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(freshFilename), 'r-notebook', { preview: false });
    const fresh = vscode.workspace.notebookDocuments.find(document => document.uri.fsPath === freshFilename);
    assert.ok(fresh);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: fresh.uri });
    await until(() => fresh.cellAt(0).executionSummary?.success === true && fresh.cellAt(0).outputs.length > 0,
      'New code cell did not produce outputs');
    await clearOutputs(fresh);
    await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
    console.log(`Notebook rendering: ${extension} newly executed outputs clear using the same native button.`);
  }
};
