const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

async function until(check, description) {
  for (let i = 0; i < 90; i++) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail(description);
}

// Inspect the actual popup in the workbench, independently of provider API tests.
async function inspector() {
  const port = (await fs.readFile(path.join(process.env.R_NOTEBOOK_TEST_PROFILE, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  assert.ok(page, 'Workbench target missing');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const callbacks = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    callbacks.get(response.id)?.(response);
  });
  return {
    close: () => socket.close(),
    popup: () => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { callbacks.delete(id); reject(new Error('Popup inspection timed out')); }, 10000);
      callbacks.set(id, response => {
        clearTimeout(timer);
        callbacks.delete(id);
        resolve(response.result?.result?.value ?? '');
      });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        returnByValue: true,
        expression: `Array.from(document.querySelectorAll('.suggest-widget.visible')).map(element => element.innerText).join('\\n')`
      } }));
    })
  };
}

exports.run = async () => {
  await vscode.extensions.getExtension('RConsole.vsc-r-notebook').activate();
  const ui = await inspector();
  try {
    for (const [index, extension] of ['rmd', 'Rmd', 'RMD'].entries()) {
      const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, `completion-${index}.${extension}`);
      await fs.writeFile(file, '---\ntitle: Test\noutput: html_document\n---\n\nText.\n');
      const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
      await vscode.window.showNotebookDocument(notebook, { preview: false, selections: [new vscode.NotebookRange(0, 1)] });
      await vscode.commands.executeCommand('notebook.cell.edit');
      const document = notebook.cellAt(0).document;
      const editor = await until(() => vscode.window.activeTextEditor?.document === document && vscode.window.activeTextEditor, 'YAML cell editor missing');
      async function replace(marked) {
        await vscode.commands.executeCommand('hideSuggestWidget');
        const offset = marked.indexOf('@');
        const text = marked.replace('@', '');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
        assert.ok(await vscode.workspace.applyEdit(edit));
        const position = document.positionAt(offset);
        editor.selection = new vscode.Selection(position, position);
        return position;
      }
      async function completion(marked, expected) {
        const position = await replace(marked);
        return until(async () => {
          const result = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
          return result?.items.find(item => (typeof item.label === 'string' ? item.label : item.label.label) === expected);
        }, `${extension}: missing ${expected}`);
      }
      await completion('---\nti@\n---', 'title');
      await completion('---\nau@\n---', 'author');
      await completion('---\noutput: h@\n---', 'html_document');
      await completion('---\noutput:\n  html_document:\n    to@\n---', 'toc');
      await completion('---\noutput:\n  html_document:\n    toc: f@\n---', 'false');
      await completion('---\noutput:\n  html_document:\n    code_folding: h@\n---', 'hide');
      await completion('---\noutput:\n  word_document:\n    ref@\n---', 'reference_docx');
      await replace('---\r\ntitle: "This is a test"\r\nauthor: "Fred Wu"\r\n@\r\noutput:\r\n    word_document:\r\n        reference_docx: template.docx\r\n    html_document:\r\n        css: "style.css"\r\n---');
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      await until(async () => (await ui.popup()).includes('date'), `${extension}: manual suggestions on blank header line missing`);
      await replace('---\ntitle: "This is a test"\noutput:\n    word_document:\n        reference_docx: template.docx\n    html_document:\n        @\n---');
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      await until(async () => (await ui.popup()).includes('toc'), `${extension}: manual suggestions on blank output option line missing`);
      // Generic Markdown quick suggestions are disabled in this isolated profile.
      await replace('---\n@\n---');
      await vscode.commands.executeCommand('type', { text: 't' });
      await until(async () => (await ui.popup()).includes('title'), `${extension}: automatic title popup missing`);
      await vscode.commands.executeCommand('acceptSelectedSuggestion');
      assert.match(document.getText(), /\ntitle: /);
      await replace('---\noutput:\n  html_document:\n    toc: @\n---');
      await vscode.commands.executeCommand('type', { text: 'f' });
      await until(async () => (await ui.popup()).includes('false'), `${extension}: automatic value popup missing`);
      await vscode.commands.executeCommand('acceptSelectedSuggestion');
      assert.match(document.getText(), /toc: false/);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      console.log(`rmd: ${extension} YAML keys, installed format options, values and automatic popups passed.`);
    }
  } finally {
    ui.close();
  }
};
