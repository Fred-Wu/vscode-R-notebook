const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let next = 0;
  const pending = new Map();
  const contexts = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') {
      contexts.set(message.params.context.id, message.params.context);
    }
    if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(message.params.executionContextId);
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return { send, contexts, close: () => socket.close() };
}

exports.run = async () => {
  await vscode.extensions.getExtension('RConsole.vsc-r-notebook').activate();
  const port = (await fs.readFile(path.join(process.env.R_NOTEBOOK_TEST_PROFILE, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const connections = new Map();
  let currentMarkupId;
  async function inspect(expression, notebookOnly = true) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of targets.filter(target => ['page', 'iframe'].includes(target.type))) {
      if (!connections.has(target.id)) connections.set(target.id, await connect(target.webSocketDebuggerUrl));
    }
    for (const [id, connection] of connections) {
      if (!targets.some(target => target.id === id)) { connection.close(); connections.delete(id); }
    }
    const snapshots = [];
    for (const connection of connections.values()) {
      for (const context of connection.contexts.values()) {
        try {
          const result = await connection.send('Runtime.evaluate', {
            contextId: context.id, returnByValue: true,
            expression: `(() => {
              const roots = [document];
              for (let i = 0; i < roots.length; i++) {
                for (const element of roots[i].querySelectorAll('*')) {
                  if (element.shadowRoot) roots.push(element.shadowRoot);
                }
              }
              const all = selector => roots.flatMap(root => Array.from(root.querySelectorAll(selector)));
              if (${notebookOnly} && !all('[data-r-notebook-markup-id="' + ${JSON.stringify(currentMarkupId)} + '"]').length) return null;
              ${expression}
            })()`
          });
          if (result.result?.value) snapshots.push(result.result.value);
        } catch {
          // A notebook webview may be disposed while targets are being inspected.
        }
      }
    }
    return snapshots;
  }
  async function until(check, description) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await check()) return;
      await pause(1000);
    }
    const snapshots = await inspect(`return all('[data-r-notebook-markup-id]').map(cell => cell.outerHTML);`);
    await fs.writeFile(path.join(process.env.R_NOTEBOOK_TEST_PROFILE, 'rendering-dom.json'), JSON.stringify(snapshots, null, 2));
    assert.fail(description);
  }
  try {
    if (process.env.R_NOTEBOOK_RENDER_FIXTURE) {
      // Copy only the document. Rendering text must not run its R code cells.
      const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,
        path.basename(process.env.R_NOTEBOOK_RENDER_FIXTURE));
      await fs.copyFile(process.env.R_NOTEBOOK_RENDER_FIXTURE, filename);
      const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
      currentMarkupId = encodeURIComponent(notebook.cellAt(0).metadata.rNotebookMarkdown.id);
      await vscode.window.showNotebookDocument(notebook, { preview: false });
      await until(async () => (await inspect(`
        return all('[data-r-notebook-toc] a').some(link => link.getBoundingClientRect().height > 0);
      `)).some(Boolean), 'Supplied document: no visible TOC links');
      assert.ok(notebook.getCells().every(cell => cell.executionSummary?.success === undefined), 'Text preview executed an R code cell');
      console.log('Notebook rendering: supplied document has visible TOC links; no R code cells executed.');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
    for (const [index, extension] of ['rmd', 'Rmd', 'RMD', 'qmd', 'QMD'].entries()) {
      const filename = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `rendering-${index}.${extension}`);
      const source = require('./nativeFixtures.cjs').fixtureSource(extension);
      // The target must be outside the initially visible cells, exercising host navigation.
      const distant = Array.from({ length: 16 }, () => '\n```{r}\n1 + 1\n```\n\nSome text.\n').join('') + '\n# Distant heading\n\nReached the distant section.\n';
      await fs.writeFile(filename, source + distant);
      const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(filename));
      currentMarkupId = encodeURIComponent(notebook.cellAt(0).metadata.rNotebookMarkdown.id);
      const editor = await vscode.window.showNotebookDocument(notebook, { preview: false });
      await until(async () => (await inspect(`
        return all('[data-r-notebook-toc]').some(toc => toc.getBoundingClientRect().height > 0 &&
          toc.innerText.includes('Introduction') && toc.innerText.includes('Distant heading'));
      `)).some(Boolean), `${extension}: no visible TOC in the live notebook`);
      assert.ok((await inspect(`return all('.r-notebook-markdown-cell').every(cell =>
        getComputedStyle(cell).backgroundColor === 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(cell).padding === '0px');`)).some(Boolean), `${extension}: page styling replaced notebook styling`);
      await inspect(`
        globalThis.headerRefresh = { pending: false, missing: false };
        const observer = new MutationObserver(() => {
          const cell = all('[data-r-notebook-markup-id="' + ${JSON.stringify(currentMarkupId)} + '"]')[0];
          if (cell?.hasAttribute('data-r-notebook-text-request')) {
            headerRefresh.pending = true;
            if (!cell.querySelector('.title') || !cell.querySelector('[data-r-notebook-toc]')) headerRefresh.missing = true;
          }
        });
        for (const root of roots) observer.observe(root, { childList: true, subtree: true, attributes: true });
        globalThis.headerObserver = observer;
      `);
      const metadataEdit = new vscode.WorkspaceEdit();
      metadataEdit.set(notebook.uri, [vscode.NotebookEdit.updateCellMetadata(0, {
        ...notebook.cellAt(0).metadata, renderingTest: true,
      })]);
      assert.equal(await vscode.workspace.applyEdit(metadataEdit), true);
      await until(async () => (await inspect('return globalThis.headerRefresh?.pending;')).some(Boolean), `${extension}: metadata refresh did not rerender the cell`);
      assert.ok(!(await inspect('return globalThis.headerRefresh?.missing;')).some(Boolean), `${extension}: title or TOC disappeared during refresh`);
      await inspect('globalThis.headerObserver?.disconnect();');
      const target = notebook.getCells().find(cell => cell.document.getText().includes('# Distant heading'));
      assert.ok(target);
      assert.ok(!editor.visibleRanges.some(range => range.start <= target.index && target.index < range.end), 'Navigation fixture is already visible');
      await until(async () => (await inspect(`
        const link = all('[data-r-notebook-toc] a[href="#distant-heading"]')[0];
        if (link) { link.click(); return true; } return false;
      `)).some(Boolean), `${extension}: TOC link is missing`);
      await until(() => editor.visibleRanges.some(range => range.start <= target.index && target.index < range.end), `${extension}: TOC did not reveal the distant cell`);
      await until(async () => (await inspect(`return all('#distant-heading').some(heading => heading.getBoundingClientRect().height > 0);`)).some(Boolean), `${extension}: distant heading did not render`);
      console.log(`Notebook rendering: ${extension} TOC visible, notebook theme retained, header stable during refresh; links reveal distant cells.`);
      const reopen = vscode.commands.executeCommand('workbench.action.reopenWithEditor');
      await until(async () => (await inspect(`
        const picker = document.querySelector('.quick-input-widget');
        if (!picker || !picker.getBoundingClientRect().height) return false;
        const labels = [picker.innerText, ...Array.from(picker.querySelectorAll('[title], [aria-label]'),
          element => (element.getAttribute('title') || '') + (element.getAttribute('aria-label') || ''))].join(' ');
        return labels.toLowerCase().includes("configure default editor for '*.${extension.toLowerCase()}'") &&
          !/\\[[rRqQmMdD]+\\]/.test(labels);
      `, false)).some(Boolean), `${extension}: readable Set Default action was not shown`);
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await reopen;
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  } finally {
    for (const connection of connections.values()) connection.close();
  }
};
