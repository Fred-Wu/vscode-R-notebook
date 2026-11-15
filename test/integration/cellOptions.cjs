const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async ({ until, inspect }) => {
  for (const extension of ['Rmd', 'qmd']) {
    for (const eol of ['\n', '\r\n']) {
      const name = `${extension} (${eol === '\n' ? 'LF' : 'CRLF'})`;
      const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,
        `cell-options-${eol === '\n' ? 'lf' : 'crlf'}.${extension}`);
      await fs.writeFile(filename, [
        '```{r}',
        'cat("cell-options-result")',
        'plot(1:3)',
        'knitr::kable(data.frame(value = 42), format = "html")',
        '```', '',
      ].join(eol));
      const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
      await vscode.window.showNotebookDocument(notebook, { preview: false });
      await vscode.commands.executeCommand('notebook.cell.execute', {
        ranges: [{ start: 0, end: 1 }], document: notebook.uri,
      });
      await until(() => typeof notebook.cellAt(0).executionSummary?.success === 'boolean',
        `${name}: output fixture did not execute`);

      const hasForm = () => notebook.cellAt(0).outputs.some(output => output.metadata?.rNotebookCellOptions);
      const snapshot = () => {
        const cell = notebook.cellAt(0);
        return structuredClone({
          text: cell.document.getText(),
          metadata: cell.metadata,
          executionSummary: cell.executionSummary,
          outputs: cell.outputs.filter(output => !output.metadata?.rNotebookCellOptions).map(output => ({
            metadata: output.metadata,
            items: output.items.map(item => ({ mime: item.mime, data: Buffer.from(item.data).toString('base64') })),
          })),
        });
      };
      const before = snapshot();
      assert.equal(before.executionSummary.success, true, JSON.stringify(before));
      const resultsVisible = async () => (await inspect(`
        // Contents can still have dimensions inside a zero-height output container.
        const visible = element => element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
          && element.closest('.output_container')?.getBoundingClientRect().height > 0;
        return all('img').some(img => img.complete && img.naturalWidth > 0 && visible(img))
          && all('table').some(table => table.textContent.includes('42') && visible(table))
          && all('pre').some(pre => pre.textContent.includes('cell-options-result') && visible(pre));
      `, false)).some(Boolean);
      const staleVisible = async () => (await inspect(`
        return document.body.innerText.includes('Output is from older codes');
      `, false)).some(Boolean);
      const preservedResults = async (action) => {
        const current = snapshot();
        assert.deepEqual(current.outputs, before.outputs, `${name}: ${action} changed output data`);
        assert.deepEqual(current.executionSummary, before.executionSummary, `${name}: ${action} changed execution state`);
        assert.equal(current.metadata.rNotebookOutputSourceHash, before.metadata.rNotebookOutputSourceHash,
          `${name}: ${action} changed the recorded source hash`);
        assert.equal(current.metadata.rNotebookOutputCodeHash, before.metadata.rNotebookOutputCodeHash,
          `${name}: ${action} changed the recorded code hash`);
        await until(resultsVisible, `${name}: ${action} hid results`);
      };
      const open = async () => {
        await vscode.commands.executeCommand('r-notebook.editCellOptions', notebook.cellAt(0));
        await until(async () => (await inspect(`
          return all('.r-options-card').some(form => form.getBoundingClientRect().height > 0);
        `, false)).some(Boolean), `${name}: options form did not appear`);
        await preservedResults('opening options');
      };
      const submit = async (change) => {
        const clicked = await inspect(`
          const form = all('.r-options-card')[0];
          if (!form) return false;
          if (${change}) {
            form.querySelector('[aria-label="Chunk label"]').value = 'edited';
            const header = form.querySelector('[aria-label="R Markdown options"]');
            if (header) header.value = 'eval=FALSE, fig.width=10, fig.height=8';
            form.querySelector('textarea').value = 'eval: false\\nfig-width: 10\\nfig-height: 8';
          }
          form.querySelector('[type="submit"]').click();
          return true;
        `, false);
        assert.ok(clicked.some(Boolean), `${name}: could not submit options`);
        await until(() => !hasForm(), `${name}: applying options did not close the form`);
        await preservedResults('applying options');
      };

      await until(resultsVisible, `${name}: initial results were not visible`);
      await open();
      assert.deepEqual(snapshot(), before, `${name}: opening options changed the cell`);
      assert.equal(await staleVisible(), false, `${name}: opening options marked results stale`);
      await vscode.commands.executeCommand('r-notebook.editCellOptions', notebook.cellAt(0));
      await preservedResults('closing options');
      assert.deepEqual(snapshot(), before);

      await open();
      await submit(false);
      assert.deepEqual(snapshot(), before, `${name}: applying unchanged options changed the cell`);
      assert.equal(await staleVisible(), false);
      await open();
      await submit(true);
      assert.equal(await staleVisible(), false, `${name}: edited options marked results stale`);

      const cell = notebook.cellAt(0);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(cell.document.uri, new vscode.Position(0, 0), `# edited${eol}`);
      assert.ok(await vscode.workspace.applyEdit(edit));
      const edited = snapshot();
      await open();
      const cancelled = await inspect(`
        const close = all('.r-options-close')[0];
        if (!close) return false;
        close.click();
        return true;
      `, false);
      assert.ok(cancelled.some(Boolean));
      await until(() => !hasForm(), `${name}: cancelling options did not close the form`);
      await preservedResults('cancelling options after editing code');
      assert.deepEqual(snapshot(), edited);
      await until(staleVisible, `${name}: opening options cleared the stale marker`);
      console.log(`Notebook rendering: ${name} preserves visible results when opening, closing and applying cell options.`);
      await vscode.commands.executeCommand('r-notebook.closeSessionAndNotebook');
    }
  }
};
