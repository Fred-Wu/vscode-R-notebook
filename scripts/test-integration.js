// Run against an installed VS Code and its R dependencies in a temporary profile.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');

async function main() {
  const executable = process.env.VSCODE_EXECUTABLE;
  if (!executable) throw new Error('Set VSCODE_EXECUTABLE to the VS Code executable (Code.exe on Windows).');
  const extensionRoot = process.env.VSCODE_EXTENSIONS_DIR || path.join(os.homedir(), '.vscode', 'extensions');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'r-notebook-integration-'));
  console.log(`Integration profile: ${root}`);
  const extensions = path.join(root, 'extensions');
  const profile = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  try {
    await Promise.all([fs.mkdir(extensions), fs.mkdir(workspace),
      fs.mkdir(path.join(profile, 'User'), { recursive: true })]);
    const installed = JSON.parse(await fs.readFile(path.join(extensionRoot, 'extensions.json'), 'utf8'));
    const required = new Set(require('../package.json').extensionDependencies.map(id => id.toLowerCase()));
    for (const id of required) {
      const entry = installed.find(item => item.identifier.id.toLowerCase() === id);
      if (!entry) throw new Error(`Install ${id} in ${extensionRoot} before running integration tests.`);
      const source = entry.relativeLocation ? path.join(extensionRoot, entry.relativeLocation) : entry.location.path;
      const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
      for (const dependency of manifest.extensionDependencies ?? []) required.add(dependency.toLowerCase());
      await fs.symlink(source, path.join(extensions, path.basename(source)), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'r.sessionWatcher': false,
      'r.notebook.rExtensionIntegration': false,
      'r.lsp.enabled': true,
      'r.lsp.multiServer': process.env.R_LSP_MULTI_SERVER === 'true',
      'extensions.autoUpdate': false,
      ...(process.env.R_EXECUTABLE ? { 'r.executablePath': process.env.R_EXECUTABLE } : {})
    }));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const log = createWriteStream(path.join(root, 'vscode.log'));
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--new-window', '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--disable-gpu', `--user-data-dir=${profile}`,
        `--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${path.resolve(__dirname, '..')}`,
        `--extensionTestsPath=${path.resolve(__dirname, '../test/integration/languageService.cjs')}`, workspace],
      { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once('error', reject);
      child.once('exit', code => log.end(() => resolve(code)));
    });
    if (code !== 0) throw new Error(`VS Code integration tests exited with ${code}. Logs: ${profile}`);
    const results = (await fs.readFile(path.join(root, 'vscode.log'), 'utf8')).split(/\r?\n/)
      .filter(line => /^(rmd:|qmd:|R \(Notebook\)|Ordinary R|Notebook language server|Notebook language service integration)/.test(line));
    for (const result of results) console.log(result);
    console.log('Notebook language-service integration passed.');
    // Only remove this invocation's generated temporary directory after success.
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('r-notebook-integration-')) throw new Error('Invalid test cleanup path.');
    await fs.rm(root, { recursive: true, force: true });
  } catch (error) {
    console.error(`Integration artifacts retained at ${root}`);
    throw error;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
