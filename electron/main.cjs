const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme, clipboard, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

app.setName('Yedit');

let mainWindow;
let rendererReady = false;
let pendingRendererActions = [];
const projectWatchers = new Map();
// Standalone source files are granted to a renderer through opaque handles.
// The renderer never receives an arbitrary filesystem write capability.
const standaloneFileHandles = new Map();
let nextProjectWatcherId = 1;
const maxProjectWatchers = 12;
const maxProjectWatchDirectories = 256;
const maxProjectWatchEntries = 4000;
const projectWatchPollInterval = 450;
// Keep ordinary project hierarchies navigable without recursively walking an
// unbounded filesystem tree when a very large folder is opened.
const maxProjectTreeDepth = 32;

function isLiveWebContents(webContents) {
  try {
    return Boolean(webContents) && !webContents.isDestroyed();
  } catch {
    return false;
  }
}

function currentMainWebContents() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return undefined;
    const webContents = mainWindow.webContents;
    return isLiveWebContents(webContents) ? webContents : undefined;
  } catch {
    return undefined;
  }
}

function safelySend(webContents, channel, payload) {
  if (!isLiveWebContents(webContents)) return false;
  try {
    webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

// Keep ordinary LaTeX documents separate from focused TikZ sources.  `.tex`
// is intentionally LaTeX; `.tikz` is the explicit TikZ-only extension.
const sourceExtensions = new Set([
  '.tex', '.latex', '.ltx', '.tikz', '.mf', '.svg', '.mmd', '.mermaid', '.md', '.markdown', '.txt',
  '.yaml', '.yml', '.json',
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx',
  '.py', '.pyw', '.f', '.for', '.f90', '.f95', '.f03', '.f08', '.f18', '.sql', '.ddl',
  '.html', '.htm', '.xhtml', '.css',
]);
// PDF-producing LaTeX engines intentionally remain explicit.  The classic
// `latex` command produces DVI and is handled separately below.
const latexPdfEngines = Object.freeze({
  pdflatex: { compiler: 'pdflatex', label: 'pdfLaTeX' },
  xelatex: { compiler: 'xelatex', label: 'XeLaTeX' },
  lualatex: { compiler: 'lualatex', label: 'LuaLaTeX' },
});
const ignoredDirectories = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'build']);
const projectManifestNames = new Set(['.yedit.json', '.diagram-foundry.json']);
const sourceTypeIds = Object.freeze(['tikz', 'latex', 'metafont', 'svg', 'mermaid', 'markdown', 'text', 'yaml', 'json', 'javascript', 'typescript', 'python', 'fortran', 'sql', 'html', 'css']);
const defaultSettings = {
  appearance: 'system',
  uiScale: 110,
  editorFontFamily: 'SF Mono',
  editorFontSize: 14,
  editorBackgroundColor: 'theme',
  editorBackgroundPattern: 'none',
  enabledSourceTypes: [...sourceTypeIds],
  referenceFontSize: 10,
  explorerOpen: true,
  previewOpen: true,
  referenceOpen: true,
  explorerWidth: 245,
  inspectorWidth: 390,
  previewSplit: 54,
  autoSave: true,
  formatOnSave: false,
  previewAutoRender: true,
  editorWordWrap: true,
  editorMinimap: true,
  editorTabSize: 2,
};
const supportedFontFamilies = new Set(['SF Mono', 'Menlo', 'Monaco', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono']);
const defaultToolTimeoutMs = 120_000;
const defaultToolOutputLimitBytes = 8 * 1024 * 1024;
const metafontProofTimeoutMs = 45_000;
const metafontConversionTimeoutMs = 120_000;
const maxMetafontProofSvgBytes = 6 * 1024 * 1024;
// Python runs are deliberately much shorter and smaller than document
// compiles: their result is shown inline in the editor rather than saved as a
// build artifact. These are hard limits, not renderer-controlled defaults.
const defaultPythonRunTimeoutMs = 15_000;
const minPythonRunTimeoutMs = 1_000;
const maxPythonRunTimeoutMs = 30_000;
const maxPythonRunOutputBytes = 2 * 1024 * 1024;
const maxPythonSourceBytes = 2 * 1024 * 1024;
const pythonDiscoveryTimeoutMs = 4_000;
let discoveredPythonCommand;

function toolPath() {
  return [
    process.env.PATH || '',
    '/Library/TeX/texbin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean).join(':');
}

async function recordMainProcessFailure(kind, reason) {
  try {
    const directory = app.isReady() ? app.getPath('userData') : os.tmpdir();
    const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(path.join(directory, 'main-process-errors.log'), `[${new Date().toISOString()}] ${kind}\n${message}\n\n`, 'utf8');
  } catch {
    // Logging an unexpected fault must never create a second one.
  }
}

process.on('uncaughtException', (error) => {
  console.error('Yedit main-process exception:', error);
  void recordMainProcessFailure('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Yedit main-process rejection:', reason);
  void recordMainProcessFailure('unhandledRejection', reason);
});

function run(command, args, cwd, extraEnv = {}, options = {}) {
  const requestedTimeout = Number(options.timeoutMs);
  const requestedOutputLimit = Number(options.maxOutputBytes);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : defaultToolTimeoutMs;
  const maxOutputBytes = Number.isFinite(requestedOutputLimit) && requestedOutputLimit > 0 ? requestedOutputLimit : defaultToolOutputLimitBytes;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timeout;
    let forceKillTimeout;
    let terminatedFor;
    let settled = false;
    let child;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (error) reject(error);
      else resolve(result);
    };

    const commandError = (message, details = {}) => {
      const error = new Error(message);
      error.stdout = stdout;
      error.stderr = stderr;
      Object.assign(error, details);
      return error;
    };

    const terminate = (reason) => {
      if (settled || terminatedFor || !child) return;
      terminatedFor = reason;
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      forceKillTimeout = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }, 1_500);
    };

    const appendOutput = (field, chunk) => {
      const text = chunk.toString();
      const bytes = Buffer.byteLength(text, 'utf8');
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const safeText = bytes <= remaining ? text : Buffer.from(text).subarray(0, remaining).toString('utf8');
        if (field === 'stdout') stdout += safeText;
        else stderr += safeText;
      }
      outputBytes += bytes;
      if (outputBytes > maxOutputBytes) terminate('output limit');
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, PATH: toolPath(), ...extraEnv },
        windowsHide: true,
      });
    } catch (error) {
      finish(error);
      return;
    }

    child.stdout.on('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => appendOutput('stderr', chunk));
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (terminatedFor === 'timeout') {
        finish(commandError(`${command} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`, { code, signal, timedOut: true }));
      } else if (terminatedFor === 'output limit') {
        finish(commandError(`${command} produced more than ${Math.floor(maxOutputBytes / (1024 * 1024))} MB of output and was stopped.`, { code, signal, outputLimited: true }));
      } else if (code === 0) {
        finish(undefined, { stdout, stderr });
      } else {
        finish(commandError(`${command} exited with ${code ?? signal ?? 'an unknown status'}.`, { code, signal }));
      }
    });
    timeout = setTimeout(() => terminate('timeout'), timeoutMs);
  });
}

function pythonScratchFileName(suggestedName) {
  const rawBaseName = path.basename(typeof suggestedName === 'string' ? suggestedName : 'script.py')
    .replace(/\.pyw?$/i, '');
  let stem = rawBaseName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  if (!stem) stem = 'script';
  if (!/^[A-Za-z_]/.test(stem)) stem = `script_${stem}`;
  return `${stem}.py`;
}

function normalizePythonRunOptions(candidate) {
  const mode = candidate?.mode === undefined || candidate?.mode === null || candidate?.mode === ''
    ? 'run'
    : String(candidate.mode).toLowerCase();
  if (mode !== 'run' && mode !== 'test') throw new Error('Choose Run or Test for Python source.');

  const requestedTimeout = Number(candidate?.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(maxPythonRunTimeoutMs, Math.max(minPythonRunTimeoutMs, Math.round(requestedTimeout)))
    : defaultPythonRunTimeoutMs;
  return { mode, timeoutMs };
}

/**
 * Resolve an optional project context without trusting a renderer-provided
 * path. A project root is useful for normal local imports. A clean saved
 * project file may run in place; dirty buffers and scratchpads run from a
 * temporary file, so unsaved text is never written into the project.
 */
async function pythonProjectContext(candidate) {
  const requestedRoot = candidate?.projectRoot;
  if (requestedRoot === undefined || requestedRoot === null || requestedRoot === '') return undefined;
  if (typeof requestedRoot !== 'string') throw new Error('The Python project folder is invalid.');

  const workspace = await projectWorkspace(requestedRoot);
  let sourcePath;
  if (candidate?.relativePath !== undefined && candidate?.relativePath !== null && candidate.relativePath !== '') {
    const source = await projectFile(workspace, candidate.relativePath);
    if (typeForPath(source.target) !== 'python') throw new Error('The selected project file is not Python source.');
    sourcePath = source.target;
  }
  return { root: workspace.realRoot, sourcePath };
}

/**
 * Provide Python a narrow, predictable environment rather than inheriting
 * virtualenv activation, user site packages, or an existing PYTHONPATH. This
 * runner intentionally does not invoke a shell or any network service. The
 * user source is still arbitrary local Python and therefore runs with the
 * normal permissions of the desktop app.
 */
function pythonExecutionEnvironment(tempDirectory, projectRoot) {
  const locale = process.env.LC_CTYPE || process.env.LANG || 'en_US.UTF-8';
  const environment = {
    PATH: toolPath(),
    HOME: tempDirectory,
    TMPDIR: tempDirectory,
    TMP: tempDirectory,
    TEMP: tempDirectory,
    LANG: locale,
    LC_CTYPE: locale,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONSAFEPATH: '1',
    PIP_NO_INPUT: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INDEX: '1',
  };
  // Do not inherit PYTHONPATH from the GUI process. When a project was
  // deliberately supplied, make that validated root the first (and only)
  // import location beyond Python's normal standard/site packages.
  if (projectRoot) environment.PYTHONPATH = projectRoot;
  return environment;
}

async function discoverPython() {
  if (discoveredPythonCommand) return discoveredPythonCommand;
  const probeDirectory = app.getPath('temp');
  for (const command of ['python3', 'python']) {
    try {
      const result = await run(command, ['--version'], probeDirectory, {
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      }, {
        timeoutMs: pythonDiscoveryTimeoutMs,
        maxOutputBytes: 8 * 1024,
      });
      const version = `${result.stdout}\n${result.stderr}`;
      if (!/^Python\s+3(?:\.|\s|$)/mi.test(version)) continue;
      discoveredPythonCommand = command;
      return command;
    } catch {
      // Try the next conventional command name. The final user-facing message
      // deliberately avoids leaking platform-specific spawn errors.
    }
  }
  throw new Error('Python 3 is unavailable. Install Python 3 so `python3` or `python` is on PATH, then restart Yedit.');
}

function runPythonProcess(command, args, cwd, env, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timeout;
    let forceKillTimeout;
    let terminatedFor;
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      resolve(result);
    };

    const terminate = (reason) => {
      if (settled || terminatedFor || !child) return;
      terminatedFor = reason;
      const kill = (signal) => {
        try {
          // A detached POSIX child starts a separate process group, so a
          // timeout also stops subprocesses created by the Python script.
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
          return true;
        } catch {
          try { child.kill(signal); return true; } catch { return false; }
        }
      };
      kill('SIGTERM');
      forceKillTimeout = setTimeout(() => {
        if (!settled) kill('SIGKILL');
      }, 1_500);
    };

    const appendOutput = (field, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const safeText = buffer.subarray(0, remaining).toString('utf8');
        if (field === 'stdout') stdout += safeText;
        else stderr += safeText;
      }
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) terminate('output limit');
    };

    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        ok: false,
        output: stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout?.on('data', (chunk) => appendOutput('stdout', chunk));
    child.stderr?.on('data', (chunk) => appendOutput('stderr', chunk));
    child.on('error', (error) => {
      finish({
        ok: false,
        output: stdout,
        stderr,
        error: error?.code === 'ENOENT'
          ? 'Python 3 is unavailable. Install Python 3 so `python3` or `python` is on PATH, then restart Yedit.'
          : (error instanceof Error ? error.message : String(error)),
      });
    });
    child.on('close', (code, signal) => {
      const exitCode = typeof code === 'number' ? code : undefined;
      if (terminatedFor === 'timeout') {
        finish({
          ok: false,
          output: stdout,
          stderr,
          exitCode,
          timedOut: true,
          error: `Python stopped after ${Math.ceil(timeoutMs / 1000)} seconds.`,
        });
        return;
      }
      if (terminatedFor === 'output limit') {
        finish({
          ok: false,
          output: stdout,
          stderr,
          exitCode,
          error: `Python produced more than ${Math.floor(maxOutputBytes / (1024 * 1024))} MB of output and was stopped.`,
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true, output: stdout, stderr, exitCode: 0 });
        return;
      }
      finish({
        ok: false,
        output: stdout,
        stderr,
        exitCode,
        // Keep a traceback in one field so the output screen does not repeat
        // it below a second generic error line.
        error: stderr.trim() ? undefined : `Python exited with ${code ?? signal ?? 'an unknown status'}.`,
      });
    });
    timeout = setTimeout(() => terminate('timeout'), timeoutMs);
  });
}

async function runPythonSource(source, suggestedName, candidateOptions = {}) {
  if (typeof source !== 'string') {
    return { ok: false, output: '', error: 'Python source must be text.' };
  }
  if (Buffer.byteLength(source, 'utf8') > maxPythonSourceBytes) {
    return { ok: false, output: '', error: `Python source is limited to ${Math.floor(maxPythonSourceBytes / (1024 * 1024))} MB per run.` };
  }

  let directory;
  let command;
  let scratchFileName;
  let normalized;
  try {
    normalized = normalizePythonRunOptions(candidateOptions);
    const project = await pythonProjectContext(candidateOptions);
    command = await discoverPython();
    scratchFileName = pythonScratchFileName(suggestedName);
    directory = await makeRenderDirectory('python-run');
    let sourcePath;
    // A clean project file may run in place, preserving __file__ and adjacent
    // resource paths. Dirty buffers and scratchpads always run from the
    // private temporary directory; this never writes editor text to disk.
    if (project?.sourcePath) {
      const savedSource = await fs.readFile(project.sourcePath, 'utf8');
      if (savedSource === source) sourcePath = project.sourcePath;
    }
    if (!sourcePath) {
      sourcePath = path.join(directory, scratchFileName);
      await fs.writeFile(sourcePath, source, { encoding: 'utf8', mode: 0o600 });
    }

    const args = normalized.mode === 'test'
      ? ['-u', '-B', '-s', '-m', 'unittest', 'discover', '-s', path.dirname(sourcePath), '-p', path.basename(sourcePath)]
      : ['-u', '-B', '-s', sourcePath];
    const displayCommand = normalized.mode === 'test'
      ? `${path.basename(command)} -u -B -s -m unittest discover -p ${path.basename(sourcePath)}`
      : `${path.basename(command)} -u -B -s ${path.basename(sourcePath)}`;
    const result = await runPythonProcess(
      command,
      args,
      project?.root || directory,
      pythonExecutionEnvironment(directory, project?.root),
      { timeoutMs: normalized.timeoutMs, maxOutputBytes: maxPythonRunOutputBytes },
    );
    return { ...result, command: displayCommand };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: '',
      error: details || 'Python could not start.',
      ...(command && scratchFileName && normalized ? {
        command: normalized.mode === 'test'
          ? `${path.basename(command)} -u -B -s -m unittest discover -p ${scratchFileName}`
          : `${path.basename(command)} -u -B -s ${scratchFileName}`,
      } : {}),
    };
  } finally {
    if (directory) await removeRenderDirectory(directory);
  }
}

async function runTexCompiler(command, args, cwd) {
  // LuaLaTeX's font loader needs a writable TeX cache.  A packaged macOS app
  // can inherit a restricted environment (or be launched without a usable
  // shell HOME), so keep that cache in Yedit's own user-data area.
  // Other TeX engines retain their normal environment and behavior.
  if (command !== 'lualatex') return run(command, args, cwd);
  const texmfVar = path.join(app.getPath('userData'), 'texmf-var');
  await fs.mkdir(texmfVar, { recursive: true });
  return run(command, args, cwd, { TEXMFVAR: texmfVar, TEXMFCACHE: texmfVar });
}

function safeName(name) {
  const cleaned = String(name || 'Untitled Project')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'Untitled Project';
}

function typeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tex' || ext === '.latex' || ext === '.ltx') return 'latex';
  if (ext === '.tikz') return 'tikz';
  if (ext === '.mf') return 'metafont';
  if (ext === '.svg') return 'svg';
  if (ext === '.mmd' || ext === '.mermaid') return 'mermaid';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'text';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.json') return 'json';
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs' || ext === '.jsx') return 'javascript';
  if (ext === '.ts' || ext === '.cts' || ext === '.mts' || ext === '.tsx') return 'typescript';
  if (ext === '.py' || ext === '.pyw') return 'python';
  if (ext === '.f' || ext === '.for' || ext === '.f90' || ext === '.f95' || ext === '.f03' || ext === '.f08' || ext === '.f18') return 'fortran';
  if (ext === '.sql' || ext === '.ddl') return 'sql';
  if (ext === '.html' || ext === '.htm' || ext === '.xhtml') return 'html';
  if (ext === '.css') return 'css';
  return 'tikz';
}

function extensionForType(type) {
  if (type === 'latex') return 'tex';
  if (type === 'tikz') return 'tikz';
  if (type === 'metafont') return 'mf';
  if (type === 'svg') return 'svg';
  if (type === 'mermaid') return 'mmd';
  if (type === 'markdown') return 'md';
  if (type === 'text') return 'txt';
  if (type === 'yaml') return 'yaml';
  if (type === 'json') return 'json';
  if (type === 'javascript') return 'js';
  if (type === 'typescript') return 'ts';
  if (type === 'python') return 'py';
  if (type === 'fortran') return 'f90';
  if (type === 'sql') return 'sql';
  if (type === 'html') return 'html';
  if (type === 'css') return 'css';
  return 'tex';
}

function normalizeSettings(candidate) {
  const appearance = ['system', 'dark', 'light'].includes(candidate?.appearance) ? candidate.appearance : defaultSettings.appearance;
  const parsedUiScale = Number(candidate?.uiScale);
  const uiScale = Number.isFinite(parsedUiScale) ? Math.min(150, Math.max(85, Math.round(parsedUiScale / 5) * 5)) : defaultSettings.uiScale;
  const editorFontFamily = supportedFontFamilies.has(candidate?.editorFontFamily) ? candidate.editorFontFamily : defaultSettings.editorFontFamily;
  const parsedSize = Number(candidate?.editorFontSize);
  const editorFontSize = Number.isFinite(parsedSize) ? Math.min(24, Math.max(11, Math.round(parsedSize))) : defaultSettings.editorFontSize;
  const editorBackgroundColor = candidate?.editorBackgroundColor === 'theme' || /^#[0-9a-f]{6}$/i.test(String(candidate?.editorBackgroundColor ?? ''))
    ? candidate.editorBackgroundColor
    : defaultSettings.editorBackgroundColor;
  const editorBackgroundPattern = ['none', 'grid', 'dots', 'lines'].includes(candidate?.editorBackgroundPattern)
    ? candidate.editorBackgroundPattern
    : defaultSettings.editorBackgroundPattern;
  const requestedSourceTypes = Array.isArray(candidate?.enabledSourceTypes) ? candidate.enabledSourceTypes : defaultSettings.enabledSourceTypes;
  const enabledSourceTypes = sourceTypeIds.filter((type) => requestedSourceTypes.includes(type));
  // Preferences can be hand-edited, but the workbench must always have a
  // usable creation format. Its UI also prevents the last enabled type from
  // being switched off in the first place.
  if (!enabledSourceTypes.length) enabledSourceTypes.push('text');
  const parsedReferenceSize = Number(candidate?.referenceFontSize);
  const referenceFontSize = Number.isFinite(parsedReferenceSize) ? Math.min(18, Math.max(9, Math.round(parsedReferenceSize))) : defaultSettings.referenceFontSize;
  const explorerOpen = typeof candidate?.explorerOpen === 'boolean' ? candidate.explorerOpen : defaultSettings.explorerOpen;
  const previewOpen = typeof candidate?.previewOpen === 'boolean' ? candidate.previewOpen : defaultSettings.previewOpen;
  const referenceOpen = typeof candidate?.referenceOpen === 'boolean' ? candidate.referenceOpen : defaultSettings.referenceOpen;
  const parsedExplorerWidth = Number(candidate?.explorerWidth);
  const explorerWidth = Number.isFinite(parsedExplorerWidth) ? Math.min(480, Math.max(180, Math.round(parsedExplorerWidth))) : defaultSettings.explorerWidth;
  const parsedInspectorWidth = Number(candidate?.inspectorWidth);
  const inspectorWidth = Number.isFinite(parsedInspectorWidth) ? Math.min(760, Math.max(280, Math.round(parsedInspectorWidth))) : defaultSettings.inspectorWidth;
  const parsedPreviewSplit = Number(candidate?.previewSplit);
  const previewSplit = Number.isFinite(parsedPreviewSplit) ? Math.min(75, Math.max(30, Math.round(parsedPreviewSplit))) : defaultSettings.previewSplit;
  const autoSave = typeof candidate?.autoSave === 'boolean' ? candidate.autoSave : defaultSettings.autoSave;
  const formatOnSave = typeof candidate?.formatOnSave === 'boolean' ? candidate.formatOnSave : defaultSettings.formatOnSave;
  const previewAutoRender = typeof candidate?.previewAutoRender === 'boolean' ? candidate.previewAutoRender : defaultSettings.previewAutoRender;
  const editorWordWrap = typeof candidate?.editorWordWrap === 'boolean' ? candidate.editorWordWrap : defaultSettings.editorWordWrap;
  const editorMinimap = typeof candidate?.editorMinimap === 'boolean' ? candidate.editorMinimap : defaultSettings.editorMinimap;
  const parsedTabSize = Number(candidate?.editorTabSize);
  const editorTabSize = Number.isFinite(parsedTabSize) ? Math.min(8, Math.max(2, Math.round(parsedTabSize))) : defaultSettings.editorTabSize;
  return {
    appearance,
    uiScale,
    editorFontFamily,
    editorFontSize,
    editorBackgroundColor,
    editorBackgroundPattern,
    enabledSourceTypes,
    referenceFontSize,
    explorerOpen,
    previewOpen,
    referenceOpen,
    explorerWidth,
    inspectorWidth,
    previewSplit,
    autoSave,
    formatOnSave,
    previewAutoRender,
    editorWordWrap,
    editorMinimap,
    editorTabSize,
  };
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function legacySettingsPath() {
  return path.join(app.getPath('appData'), 'Diagram Foundry', 'settings.json');
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // Keep existing preferences when upgrading from the former app name.
    try {
      const raw = await fs.readFile(legacySettingsPath(), 'utf8');
      return normalizeSettings(JSON.parse(raw));
    } catch {
      return { ...defaultSettings };
    }
  }
}

async function saveSettings(candidate) {
  const settings = normalizeSettings(candidate);
  const target = settingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
  nativeTheme.themeSource = settings.appearance;
  if (app.isReady()) Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(settings)));
  return settings;
}

function assertInside(root, relativePath) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error('That file is outside the current project.');
  }
  return targetPath;
}

function assertProjectRelativePath(root, relativePath, label = 'file') {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`Choose a ${label} inside the current project.`);
  }
  const target = assertInside(root, relativePath);
  if (target === path.resolve(root)) throw new Error('The project folder itself cannot be changed here.');
  return target;
}

function relativePathFor(root, target) {
  return path.relative(path.resolve(root), target).split(path.sep).join('/');
}

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function projectWorkspace(root) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('Choose a project folder first.');
  const absoluteRoot = path.resolve(root);
  const stat = await fs.stat(absoluteRoot);
  if (!stat.isDirectory()) throw new Error('The selected project folder is unavailable.');
  return { root: absoluteRoot, realRoot: await fs.realpath(absoluteRoot) };
}

async function projectFile(workspace, relativePath) {
  const target = assertProjectRelativePath(workspace.root, relativePath);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular project files can be changed here.');
  const realTarget = await fs.realpath(target);
  if (!isInside(workspace.realRoot, realTarget)) throw new Error('That file resolves outside the current project.');
  return { target, relativePath: relativePathFor(workspace.root, target), stat };
}

function standaloneFilesFor(sender) {
  const senderId = sender.id;
  let files = standaloneFileHandles.get(senderId);
  if (files) return files;
  files = new Map();
  standaloneFileHandles.set(senderId, files);
  sender.once('destroyed', () => standaloneFileHandles.delete(senderId));
  return files;
}

function grantStandaloneFile(sender, target) {
  const files = standaloneFilesFor(sender);
  for (const [fileHandle, knownTarget] of files) {
    if (knownTarget === target) return fileHandle;
  }
  const fileHandle = `source-${randomUUID()}`;
  files.set(fileHandle, target);
  return fileHandle;
}

async function regularStandaloneFile(target) {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular source files can be opened or saved directly.');
  return { target, stat };
}

async function openedStandaloneFile(sender, fileHandle) {
  if (typeof fileHandle !== 'string' || !fileHandle.trim()) throw new Error('The opened file reference is invalid.');
  const target = standaloneFileHandles.get(sender.id)?.get(fileHandle);
  if (!target) throw new Error('This source file is no longer available to Yedit. Open it again to continue.');
  return regularStandaloneFile(target);
}

async function projectRelativeSourcePath(projectRoot, target) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) return undefined;
  const workspace = await projectWorkspace(projectRoot);
  const realTarget = await fs.realpath(target);
  if (!isInside(workspace.realRoot, realTarget)) return undefined;
  const relativePath = relativePathFor(workspace.realRoot, realTarget);
  return (await projectFile(workspace, relativePath)).relativePath;
}

async function sourceLocation(sender, target, projectRoot) {
  const relativePath = await projectRelativeSourcePath(projectRoot, target);
  return relativePath ? { relativePath } : { fileHandle: grantStandaloneFile(sender, target) };
}

async function standaloneSourcePayload(sender, filePath, projectRoot) {
  const target = path.resolve(filePath);
  const extension = path.extname(target).toLowerCase();
  if (!sourceExtensions.has(extension)) throw new Error('Choose a supported Yedit source file.');
  await regularStandaloneFile(target);
  return {
    name: path.basename(target),
    sourceType: typeForPath(target),
    content: await fs.readFile(target, 'utf8'),
    ...await sourceLocation(sender, target, projectRoot),
  };
}

async function saveStandaloneSource(target, content) {
  const noFollow = fssync.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') throw new Error('This macOS runtime cannot safely save an opened source file.');
  const flags = fssync.constants.O_WRONLY | fssync.constants.O_CREAT | fssync.constants.O_TRUNC | noFollow;
  const file = await fs.open(target, flags, 0o600);
  try {
    await file.writeFile(content, 'utf8');
  } finally {
    await file.close();
  }
  return regularStandaloneFile(target);
}

async function projectDestination(workspace, relativePath) {
  const target = assertProjectRelativePath(workspace.root, relativePath);
  try {
    await fs.lstat(target);
    throw new Error('A file with that name already exists.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(target);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) throw new Error('The destination folder is unavailable.');
  const realParent = await fs.realpath(parent);
  if (!isInside(workspace.realRoot, realParent)) throw new Error('The destination resolves outside the current project.');
  return { target, relativePath: relativePathFor(workspace.root, target) };
}

/**
 * A new file may be placed in a nested, previously-uncreated folder. Resolve
 * every parent after creating it so a symlink can never take a project write
 * outside the selected workspace.
 */
async function projectCreateDestination(workspace, relativePath) {
  const target = assertProjectRelativePath(workspace.root, relativePath);
  try {
    await fs.lstat(target);
    throw new Error('A file with that name already exists.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) throw new Error('The destination folder is unavailable.');
  const realParent = await fs.realpath(parent);
  if (!isInside(workspace.realRoot, realParent)) throw new Error('The destination resolves outside the current project.');
  return { target, relativePath: relativePathFor(workspace.root, target) };
}

function visibleProjectPath(relativePath) {
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  return parts.every((part) => (!part.startsWith('.') || projectManifestNames.has(part)) && !ignoredDirectories.has(part));
}

async function buildTree(root, relativePath = '', depth = 0) {
  if (depth >= maxProjectTreeDepth) return [];
  const absolute = path.join(root, relativePath);
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const visible = entries
    .filter((entry) => visibleProjectPath(path.join(relativePath, entry.name)))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = await Promise.all(visible.map(async (entry) => {
    const childAbsolute = path.join(absolute, entry.name);
    const childRelative = relativePathFor(root, childAbsolute);
    try {
      const stat = await fs.lstat(childAbsolute);
      const metadata = {
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        createdAt: stat.birthtimeMs,
        isSymbolicLink: stat.isSymbolicLink(),
      };
      if (entry.isDirectory() && !stat.isSymbolicLink()) {
        return {
          name: entry.name,
          relativePath: childRelative,
          kind: 'directory',
          ...metadata,
          children: await buildTree(root, childRelative, depth + 1),
        };
      }
      return {
        name: entry.name,
        relativePath: childRelative,
        kind: 'file',
        sourceType: typeForPath(entry.name),
        supported: sourceExtensions.has(path.extname(entry.name).toLowerCase()),
        ...metadata,
      };
    } catch (error) {
      // A file can disappear between readdir and lstat when a project is
      // changing externally. Ignore that one entry and keep navigation live.
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  return nodes.filter(Boolean);
}

async function projectPayload(root) {
  const workspace = await projectWorkspace(root);
  return {
    root: workspace.root,
    name: path.basename(workspace.root),
    tree: await buildTree(workspace.root),
  };
}

function stopProjectWatcher(watchId) {
  const record = projectWatchers.get(watchId);
  if (!record) return false;
  projectWatchers.delete(watchId);
  if (record.timer) clearTimeout(record.timer);
  if (record.directorySyncTimer) clearTimeout(record.directorySyncTimer);
  if (record.pollTimer) clearTimeout(record.pollTimer);
  for (const watcher of record.directoryWatchers.values()) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  record.directoryWatchers.clear();
  return true;
}

function stopProjectWatchersFor(sender) {
  for (const [watchId, record] of projectWatchers) {
    if (record.sender === sender) stopProjectWatcher(watchId);
  }
}

function sendProjectWatchUpdate(record, payload) {
  if (!safelySend(record.sender, 'project:changed', payload)) {
    stopProjectWatcher(record.watchId);
  }
}

async function projectDirectoriesToWatch(root) {
  const directories = new Map([[root, '']]);
  const queue = [{ absolutePath: root, relativePath: '', depth: 0 }];
  let limited = false;
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= 8) continue;
    let entries;
    try {
      entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (current.relativePath) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const relativePath = path.join(current.relativePath, entry.name);
      if (!visibleProjectPath(relativePath)) continue;
      if (directories.size >= maxProjectWatchDirectories) {
        limited = true;
        continue;
      }
      const absolutePath = path.join(current.absolutePath, entry.name);
      directories.set(absolutePath, relativePath);
      queue.push({ absolutePath, relativePath, depth: current.depth + 1 });
    }
  }
  return { directories, limited };
}

async function projectWatchSnapshot(root) {
  const entries = new Map();
  const queue = [{ absolutePath: root, relativePath: '', depth: 0 }];
  let limited = false;
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= 8) continue;
    let children;
    try {
      children = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (current.relativePath) continue;
      throw error;
    }
    for (const child of children) {
      const relativePath = path.join(current.relativePath, child.name);
      if (!visibleProjectPath(relativePath)) continue;
      if (entries.size >= maxProjectWatchEntries) {
        limited = true;
        continue;
      }
      const absolutePath = path.join(current.absolutePath, child.name);
      let stat;
      try {
        stat = await fs.lstat(absolutePath);
      } catch {
        continue;
      }
      entries.set(relativePath.split(path.sep).join('/'), `${stat.isDirectory() ? 'd' : 'f'}:${stat.size}:${stat.mtimeMs}`);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        queue.push({ absolutePath, relativePath, depth: current.depth + 1 });
      }
    }
  }
  return { entries, limited };
}

function queueProjectChange(record, relativePath, eventType) {
  record.changes.set(relativePath, eventType);
  if (!record.timer) record.timer = setTimeout(record.flushChanges, 100);
}

function scheduleProjectPolling(record, delay = projectWatchPollInterval) {
  if (record.pollTimer || record.mode !== 'polling' || !projectWatchers.has(record.watchId)) return;
  record.pollTimer = setTimeout(() => {
    record.pollTimer = undefined;
    pollProjectWatcher(record).catch((error) => {
      sendProjectWatchUpdate(record, {
        watchId: record.watchId,
        root: record.root,
        error: String(error?.message || error),
      });
      scheduleProjectPolling(record);
    });
  }, delay);
}

async function pollProjectWatcher(record) {
  if (record.mode !== 'polling' || !projectWatchers.has(record.watchId) || record.polling) return;
  record.polling = true;
  try {
    const { entries, limited } = await projectWatchSnapshot(record.root);
    for (const relativePath of record.pollSnapshot.keys()) {
      if (!entries.has(relativePath)) queueProjectChange(record, relativePath, 'rename');
    }
    for (const [relativePath, signature] of entries) {
      const previous = record.pollSnapshot.get(relativePath);
      if (previous === undefined) queueProjectChange(record, relativePath, 'rename');
      else if (previous !== signature) queueProjectChange(record, relativePath, 'change');
    }
    record.pollSnapshot = entries;
    record.limited = record.limited || limited;
  } finally {
    record.polling = false;
    scheduleProjectPolling(record);
  }
}

function switchProjectWatcherToPolling(record) {
  if (record.mode === 'polling' || !projectWatchers.has(record.watchId)) return;
  record.mode = 'polling';
  if (record.directorySyncTimer) clearTimeout(record.directorySyncTimer);
  record.directorySyncTimer = undefined;
  for (const watcher of record.directoryWatchers.values()) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  record.directoryWatchers.clear();
  sendProjectWatchUpdate(record, {
    watchId: record.watchId,
    root: record.root,
    changes: [],
    warning: 'The operating system watcher limit was reached; monitoring continues with a lightweight project scan.',
    mode: 'polling',
  });
  scheduleProjectPolling(record, 100);
}

function scheduleProjectDirectorySync(record) {
  if (record.directorySyncTimer || record.mode !== 'native' || !projectWatchers.has(record.watchId)) return;
  record.directorySyncTimer = setTimeout(() => {
    record.directorySyncTimer = undefined;
    syncProjectWatchDirectories(record).catch((error) => {
      sendProjectWatchUpdate(record, {
        watchId: record.watchId,
        root: record.root,
        error: String(error?.message || error),
      });
    });
  }, 150);
}

async function syncProjectWatchDirectories(record) {
  if (record.mode !== 'native' || !projectWatchers.has(record.watchId)) return;
  if (record.syncingDirectories) {
    record.needsDirectorySync = true;
    return;
  }
  record.syncingDirectories = true;
  try {
    const { directories, limited } = await projectDirectoriesToWatch(record.root);
    record.limited = record.limited || limited;
    for (const [absolutePath, watcher] of record.directoryWatchers) {
      if (directories.has(absolutePath)) continue;
      try { watcher.close(); } catch { /* already closed */ }
      record.directoryWatchers.delete(absolutePath);
    }
    for (const [absolutePath, relativePath] of directories) {
      if (record.mode !== 'native') break;
      if (record.directoryWatchers.has(absolutePath)) continue;
      let watcher;
      try {
        watcher = fssync.watch(absolutePath, (eventType, filename) => {
          const nativeRelativePath = filename ? path.join(relativePath, String(filename)) : relativePath;
          const changedRelativePath = nativeRelativePath.split(path.sep).join('/');
          if (changedRelativePath && !visibleProjectPath(changedRelativePath)) return;
          queueProjectChange(record, changedRelativePath, eventType);
          if (eventType === 'rename') scheduleProjectDirectorySync(record);
        });
      } catch {
        switchProjectWatcherToPolling(record);
        break;
      }
      watcher.on('error', (error) => {
        record.directoryWatchers.delete(absolutePath);
        if (error?.code === 'ENOENT') scheduleProjectDirectorySync(record);
        else switchProjectWatcherToPolling(record);
      });
      record.directoryWatchers.set(absolutePath, watcher);
    }
  } finally {
    record.syncingDirectories = false;
    if (record.needsDirectorySync && record.mode === 'native') {
      record.needsDirectorySync = false;
      scheduleProjectDirectorySync(record);
    }
  }
}

async function watchProject(root, sender) {
  const workspace = await projectWorkspace(root);
  for (const record of projectWatchers.values()) {
    if (record.sender === sender && record.root === workspace.root) {
      return { watchId: record.watchId, root: record.root, recursive: true, limited: record.limited, mode: record.mode };
    }
  }
  if (projectWatchers.size >= maxProjectWatchers) {
    throw new Error('Too many project folders are being watched. Stop an unused watcher first.');
  }

  const watchId = `project-watch-${nextProjectWatcherId++}`;
  const initialSnapshot = await projectWatchSnapshot(workspace.root);
  const record = {
    watchId,
    sender,
    root: workspace.root,
    changes: new Map(),
    directoryWatchers: new Map(),
    timer: undefined,
    directorySyncTimer: undefined,
    pollTimer: undefined,
    pollSnapshot: initialSnapshot.entries,
    polling: false,
    mode: 'native',
    syncingDirectories: false,
    needsDirectorySync: false,
    limited: initialSnapshot.limited,
  };
  record.flushChanges = () => {
    record.timer = undefined;
    if (!record.changes.size) return;
    const changes = [...record.changes].map(([relativePath, eventType]) => ({ relativePath, eventType }));
    record.changes.clear();
    sendProjectWatchUpdate(record, { watchId, root: workspace.root, changes });
  };
  projectWatchers.set(watchId, record);
  try {
    await syncProjectWatchDirectories(record);
  } catch (error) {
    stopProjectWatcher(watchId);
    throw error;
  }
  return { watchId, root: workspace.root, recursive: true, limited: record.limited, mode: record.mode };
}

function gitErrorMessage(error) {
  if (error?.code === 'ENOENT') return 'Git is not installed or is unavailable on PATH.';
  const output = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n').trim();
  if (/not a git repository/i.test(output)) return 'This folder is not inside a Git repository.';
  return output || 'Git could not inspect this project.';
}

async function gitContext(root) {
  const workspace = await projectWorkspace(root);
  try {
    const { stdout } = await run('git', ['--no-pager', '-C', workspace.root, 'rev-parse', '--is-inside-work-tree'], workspace.root, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    });
    if (stdout.trim() !== 'true') {
      return { workspace, available: false, isRepository: false, error: 'This Git repository does not have a working tree.' };
    }
    return { workspace, available: true, isRepository: true };
  } catch (error) {
    return { workspace, available: false, isRepository: false, error: gitErrorMessage(error) };
  }
}

function unavailableGitResponse(context) {
  return {
    available: false,
    isRepository: false,
    root: context.workspace.root,
    error: context.error || 'Git is unavailable for this project.',
  };
}

async function runGit(context, args) {
  return run('git', ['--no-pager', '-C', context.workspace.root, ...args], context.workspace.root, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  });
}

function projectGitPath(workspace, relativePath) {
  if (relativePath === undefined || relativePath === null || relativePath === '') return '.';
  const target = assertProjectRelativePath(workspace.root, relativePath, 'path');
  return relativePathFor(workspace.root, target);
}

function parseGitStatus(output) {
  const records = output.split('\0').filter(Boolean);
  let branch = '';
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const entry = records[index];
    if (entry.startsWith('## ')) {
      branch = entry.slice(3);
      continue;
    }
    if (entry.length < 3) continue;
    const status = entry.slice(0, 2);
    const item = {
      status,
      indexStatus: status[0],
      workTreeStatus: status[1],
      path: entry.slice(3),
    };
    if (status.includes('R') || status.includes('C')) item.originalPath = records[++index] || '';
    changes.push(item);
  }
  return { branch, changes };
}

async function gitStatus(root) {
  const context = await gitContext(root);
  if (!context.available) return unavailableGitResponse(context);
  try {
    const { stdout } = await runGit(context, ['status', '--porcelain=v1', '--branch', '-z', '--', '.']);
    const { branch, changes } = parseGitStatus(stdout);
    return {
      available: true,
      isRepository: true,
      root: context.workspace.root,
      branch,
      clean: changes.length === 0,
      changes,
    };
  } catch (error) {
    return { available: true, isRepository: true, root: context.workspace.root, error: gitErrorMessage(error), changes: [] };
  }
}

async function gitDiff(root, relativePath, options = {}) {
  const context = await gitContext(root);
  if (!context.available) return unavailableGitResponse(context);
  try {
    const projectPath = projectGitPath(context.workspace, relativePath);
    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3'];
    if (options?.staged === true) args.push('--cached');
    args.push('--', projectPath);
    const { stdout } = await runGit(context, args);
    return {
      available: true,
      isRepository: true,
      root: context.workspace.root,
      relativePath: projectPath === '.' ? undefined : projectPath,
      staged: options?.staged === true,
      hasChanges: Boolean(stdout),
      diff: stdout,
    };
  } catch (error) {
    return { available: true, isRepository: true, root: context.workspace.root, error: gitErrorMessage(error), diff: '' };
  }
}

function parseGitLog(output) {
  return output.split('\x1e').filter(Boolean).map((record) => {
    const [hash, shortHash, author, date, subject] = record.split('\x1f');
    return { hash, shortHash, author, date, subject };
  });
}

async function gitLog(root, relativePath, options = {}) {
  const context = await gitContext(root);
  if (!context.available) return unavailableGitResponse(context);
  try {
    const projectPath = projectGitPath(context.workspace, relativePath);
    const parsedLimit = Number(options?.limit);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, Math.round(parsedLimit))) : 30;
    const { stdout } = await runGit(context, [
      'log',
      '--no-color',
      '--date=iso-strict',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e',
      `-n${limit}`,
      '--',
      projectPath,
    ]);
    return {
      available: true,
      isRepository: true,
      root: context.workspace.root,
      relativePath: projectPath === '.' ? undefined : projectPath,
      entries: parseGitLog(stdout),
    };
  } catch (error) {
    const message = gitErrorMessage(error);
    if (/does not have any commits yet/i.test(message)) {
      return { available: true, isRepository: true, root: context.workspace.root, entries: [] };
    }
    return { available: true, isRepository: true, root: context.workspace.root, error: message, entries: [] };
  }
}

const buildProfiles = [
  {
    id: 'tikz-pdf',
    label: 'Compile TikZ to PDF (pdfLaTeX)',
    sourceTypes: ['tikz'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.pdflatex.compiler,
    engine: 'pdflatex',
  },
  {
    id: 'tikz-xelatex-pdf',
    label: 'Compile TikZ to PDF (XeLaTeX)',
    sourceTypes: ['tikz'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.xelatex.compiler,
    engine: 'xelatex',
  },
  {
    id: 'tikz-lualatex-pdf',
    label: 'Compile TikZ to PDF (LuaLaTeX)',
    sourceTypes: ['tikz'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.lualatex.compiler,
    engine: 'lualatex',
  },
  {
    id: 'latex-pdf',
    label: 'Compile LaTeX to PDF (pdfLaTeX)',
    sourceTypes: ['latex'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.pdflatex.compiler,
    engine: 'pdflatex',
  },
  {
    id: 'latex-xelatex-pdf',
    label: 'Compile LaTeX to PDF (XeLaTeX)',
    sourceTypes: ['latex'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.xelatex.compiler,
    engine: 'xelatex',
  },
  {
    id: 'latex-lualatex-pdf',
    label: 'Compile LaTeX to PDF (LuaLaTeX)',
    sourceTypes: ['latex'],
    outputExtension: 'pdf',
    compiler: latexPdfEngines.lualatex.compiler,
    engine: 'lualatex',
  },
  {
    id: 'latex-dvi',
    label: 'Compile LaTeX to DVI',
    sourceTypes: ['latex'],
    outputExtension: 'dvi',
    compiler: 'latex',
    engine: 'latex',
  },
  {
    id: 'metafont-ttf',
    label: 'Convert MetaFont to TTF',
    sourceTypes: ['metafont'],
    outputExtension: 'ttf',
    compiler: 'mf2pt1 + fontforge',
  },
];

async function runBuildProfile(root, relativePath, profileId) {
  const workspace = await projectWorkspace(root);
  const profile = buildProfiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('That build profile is unavailable.');
  const source = await projectFile(workspace, relativePath);
  if (!profile.sourceTypes.includes(typeForPath(source.target)) || !sourceExtensions.has(path.extname(source.target).toLowerCase())) {
    throw new Error(`This build profile only supports ${profile.sourceTypes.join(' or ')} source files.`);
  }

  const sourceDirectory = path.dirname(source.target);
  const outputDirectory = path.join(workspace.root, '.yedit-build', path.dirname(source.relativePath));
  const baseName = path.parse(source.target).name;
  const outputPath = path.join(outputDirectory, `${baseName}.${profile.outputExtension}`);
  await fs.mkdir(outputDirectory, { recursive: true });

  if (profile.id === 'metafont-ttf') {
    try {
      const sourceText = await fs.readFile(source.target, 'utf8');
      const conversion = await convertMetafontToTtf(sourceText, path.basename(source.target));
      if (!conversion.ok) return { ok: false, profile: profile.id, error: conversion.error };
      await fs.copyFile(conversion.ttfPath, outputPath);
      return {
        ok: true,
        profile: profile.id,
        outputPath,
        outputRelativePath: relativePathFor(workspace.root, outputPath),
      };
    } catch (error) {
      return {
        ok: false,
        profile: profile.id,
        error: [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n') || String(error),
      };
    }
  }

  try {
    await runTexCompiler(profile.compiler, [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-no-shell-escape',
      '-file-line-error',
      `-output-directory=${outputDirectory}`,
      path.basename(source.target),
    ], sourceDirectory);
    return {
      ok: true,
      profile: profile.id,
      outputPath,
      outputRelativePath: relativePathFor(workspace.root, outputPath),
    };
  } catch (error) {
    const logPath = path.join(outputDirectory, `${baseName}.log`);
    let log = '';
    try { log = await fs.readFile(logPath, 'utf8'); } catch { /* compiler output below is enough */ }
    return {
      ok: false,
      profile: profile.id,
      error: [missingCompilerMessage(error, profile.compiler), error.stderr, error.stdout, log, error.message]
        .filter(Boolean)
        .join('\n')
        .slice(-12000),
    };
  }
}

async function makeRenderDirectory(prefix = 'render') {
  const directory = path.join(app.getPath('temp'), 'yedit', `${prefix}-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function removeRenderDirectory(directory) {
  try { await fs.rm(directory, { recursive: true, force: true }); } catch { /* temporary cleanup never blocks a render */ }
}

async function readTextTail(filePath, maximumBytes = 128 * 1024) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function compilerLabel(command) {
  return latexPdfEngines[command]?.label || command;
}

function missingCompilerMessage(error, command) {
  if (!isMissingCommand(error, command)) return '';
  return `${compilerLabel(command)} is unavailable. Install a TeX distribution that provides ${command}, then restart Yedit.`;
}

async function compilerErrorMessage(directory, baseName, error, compiler) {
  const logPath = path.join(directory, `${baseName}.log`);
  let log = '';
  try { log = await fs.readFile(logPath, 'utf8'); } catch { /* the compiler may have failed before making a log */ }
  return [missingCompilerMessage(error, compiler), error?.stderr, error?.stdout, log, error?.message]
    .filter(Boolean)
    .join('\n')
    .slice(-12000) || String(error?.message || error);
}

function compilerBaseName(suggestedName, fallback = 'document') {
  return path.basename(suggestedName || `${fallback}.tex`)
    .replace(/\.(?:tex|latex|ltx|tikz)$/i, '') || fallback;
}

function isMissingCommand(error, command) {
  return error?.code === 'ENOENT' || new RegExp(`spawn ${command} ENOENT`, 'i').test(String(error?.message || ''));
}

function resolveLatexRenderEngine(outputFormat, requestedEngine) {
  const hasRequestedEngine = requestedEngine !== undefined && requestedEngine !== null && String(requestedEngine).trim() !== '';
  const engine = hasRequestedEngine ? String(requestedEngine).trim().toLowerCase() : 'pdflatex';

  if (outputFormat === 'dvi') {
    // Keep DVI deterministic: it is always generated by classic Knuth TeX's
    // LaTeX command.  Allow the default PDF engine value so callers can keep
    // one engine preference while switching the output mode.
    if (hasRequestedEngine && engine !== 'pdflatex') {
      return {
        ok: false,
        error: 'DVI output always uses the classic latex engine. Select PDF to use XeLaTeX or LuaLaTeX.',
      };
    }
    return { ok: true, compiler: 'latex', engine: 'latex' };
  }

  const definition = latexPdfEngines[engine];
  if (!definition) {
    return {
      ok: false,
      error: 'Choose pdfLaTeX, XeLaTeX, or LuaLaTeX for TeX PDF output.',
    };
  }
  return { ok: true, compiler: definition.compiler, engine };
}

async function renderLatex(source, suggestedName = 'document.tex', mode = 'pdf', requestedEngine) {
  const outputFormat = String(mode || 'pdf').toLowerCase();
  if (!['pdf', 'dvi'].includes(outputFormat)) {
    return { ok: false, error: 'LaTeX preview supports PDF or DVI output.' };
  }
  const engine = resolveLatexRenderEngine(outputFormat, requestedEngine);
  if (!engine.ok) return engine;

  const directory = await makeRenderDirectory('latex');
  const baseName = compilerBaseName(suggestedName, 'document');
  const texPath = path.join(directory, `${baseName}.tex`);
  const outputPath = path.join(directory, `${baseName}.${outputFormat}`);
  const compiler = engine.compiler;
  await fs.writeFile(texPath, source, 'utf8');

  try {
    await runTexCompiler(compiler, [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-no-shell-escape',
      '-file-line-error',
      `-output-directory=${directory}`,
      texPath,
    ], directory);
    await fs.access(outputPath);

    if (outputFormat === 'pdf') {
      const data = await fs.readFile(outputPath);
      return {
        ok: true,
        format: 'pdf',
        dataUri: `data:application/pdf;base64,${data.toString('base64')}`,
        pdfPath: outputPath,
        directory,
        engine: engine.engine,
      };
    }

    // Electron/Chromium has no DVI viewer.  When available, dvisvgm gives us
    // a portable, sandboxed SVG representation of the first DVI page.
    const svgPath = path.join(directory, `${baseName}.svg`);
    try {
      await run('dvisvgm', ['--page=1', '--no-fonts', `--output=${svgPath}`, outputPath], directory);
      const svg = await fs.readFile(svgPath, 'utf8');
      return {
        ok: true,
        format: 'dvi',
        dviPath: outputPath,
        directory,
        engine: engine.engine,
        previewKind: 'svg',
        svg,
      };
    } catch (previewError) {
      const detail = isMissingCommand(previewError, 'dvisvgm')
        ? 'Install dvisvgm (included with a full TeX Live or MacTeX installation) to preview DVI files here.'
        : 'dvisvgm could not convert the DVI first page to an SVG preview.';
      return {
        ok: true,
        format: 'dvi',
        dviPath: outputPath,
        directory,
        engine: engine.engine,
        previewKind: 'none',
        warning: `DVI compiled successfully. ${detail} You can still export the DVI build output.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: await compilerErrorMessage(directory, baseName, error, compiler),
    };
  }
}

async function renderTikz(source, suggestedName = 'diagram.tikz', requestedEngine) {
  const engine = resolveLatexRenderEngine('pdf', requestedEngine);
  if (!engine.ok) return engine;
  const directory = await makeRenderDirectory('tikz');
  const baseName = path.basename(suggestedName || 'diagram.tex').replace(/\.(tikz|tex)$/i, '') || 'diagram';
  const texPath = path.join(directory, `${baseName}.tex`);
  const pdfPath = path.join(directory, `${baseName}.pdf`);
  await fs.writeFile(texPath, source, 'utf8');

  try {
    await runTexCompiler(engine.compiler, ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '-file-line-error', `-output-directory=${directory}`, texPath], directory);
    const data = await fs.readFile(pdfPath);
    return {
      ok: true,
      dataUri: `data:application/pdf;base64,${data.toString('base64')}`,
      pdfPath,
      directory,
      engine: engine.engine,
    };
  } catch (error) {
    return {
      ok: false,
      error: await compilerErrorMessage(directory, baseName, error, engine.compiler),
    };
  }
}

function metafontBaseName(suggestedName, fallback = 'font') {
  const candidate = path.basename(suggestedName || `${fallback}.mf`)
    .replace(/\.mf$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return candidate || fallback;
}

function metafontEnvironment(directory) {
  // Keep all generated metrics, GF files, and proof-font lookups confined to
  // this render job. A trailing colon lets kpathsea retain its normal fallback
  // paths for plain MetaFont support files such as modes.mf and gray.mf.
  const localPath = `${directory}:`;
  return {
    MFINPUTS: localPath,
    TFMFONTS: localPath,
    GFFONTS: localPath,
    PKFONTS: localPath,
    TEXFONTS: localPath,
  };
}

async function metafontGfPath(directory, baseName) {
  const files = await fs.readdir(directory);
  const gfName = files.find((file) => file.startsWith(`${baseName}.`) && /\.\d+gf$/i.test(file));
  if (!gfName) throw new Error('MetaFont finished without producing a GF font. Add at least one beginchar definition before rendering a glyph proof.');
  return path.join(directory, gfName);
}

function missingMetafontToolMessage(error, command) {
  if (!isMissingCommand(error, command)) return '';
  if (command === 'fontforge') {
    return 'TTF export needs FontForge. Install the FontForge command-line tool (for example, `brew install fontforge`) and restart Yedit.';
  }
  if (command === 'mf2pt1') {
    return 'TTF export needs mf2pt1, which is included with a full TeX Live or MacTeX installation.';
  }
  if (command === 'mf-nowin') {
    return 'MetaFont preview needs the headless `mf-nowin` command from TeX Live or MacTeX.';
  }
  if (command === 'gftodvi' || command === 'dvisvgm') {
    return 'MetaFont preview needs gftodvi and dvisvgm from a full TeX Live or MacTeX installation.';
  }
  return `${command} is unavailable.`;
}

async function metafontErrorMessage(directory, baseName, error, command) {
  let log = '';
  try { log = await readTextTail(path.join(directory, `${baseName}.log`)); } catch { /* compiler may have failed before making a log */ }
  return [missingMetafontToolMessage(error, command), error?.stderr, error?.stdout, log, error?.message]
    .filter(Boolean)
    .join('\n')
    .slice(-12000) || String(error?.message || error);
}

/**
 * Compile a genuine MetaFont GF file, then turn its first glyph-proof page
 * into sandbox-safe SVG. Unlike tracing, this path works for ordinary MetaFont
 * programs and faithfully shows the generated bitmap output.
 */
async function renderMetafont(source, suggestedName = 'font.mf') {
  const directory = await makeRenderDirectory('metafont');
  const baseName = metafontBaseName(suggestedName);
  const mfPath = path.join(directory, `${baseName}.mf`);
  const env = metafontEnvironment(directory);
  await fs.writeFile(mfPath, source, 'utf8');
  let activeTool = 'mf-nowin';

  try {
    await run('mf-nowin', [`\\mode:=localfont; nonstopmode; input ${baseName}`], directory, env, { timeoutMs: metafontProofTimeoutMs });
    const gfPath = await metafontGfPath(directory, baseName);

    // GFtoDVI uses gray.tfm for the bitmap proof pages. Generate it locally so
    // a packaged app does not depend on a globally installed generated metric.
    await run('mf-nowin', ['\\mode:=localfont; nonstopmode; input gray'], directory, env, { timeoutMs: metafontProofTimeoutMs });
    activeTool = 'gftodvi';
    await run('gftodvi', [path.basename(gfPath)], directory, env, { timeoutMs: metafontProofTimeoutMs });

    const dviPath = path.join(directory, `${baseName}.dvi`);
    const svgPath = path.join(directory, `${baseName}.svg`);
    await fs.access(dviPath);
    activeTool = 'dvisvgm';
    await run('dvisvgm', ['--page=1', '--no-fonts', `--output=${svgPath}`, dviPath], directory, env, { timeoutMs: metafontProofTimeoutMs });
    const svgStats = await fs.stat(svgPath);
    if (svgStats.size > maxMetafontProofSvgBytes) {
      throw new Error(`The generated MetaFont proof is ${(svgStats.size / (1024 * 1024)).toFixed(1)} MB. Reduce its complexity before previewing it.`);
    }
    const svg = await fs.readFile(svgPath, 'utf8');
    return { ok: true, svg };
  } catch (error) {
    return { ok: false, error: await metafontErrorMessage(directory, baseName, error, activeTool) };
  } finally {
    await removeRenderDirectory(directory);
  }
}

/**
 * Convert mf2pt1-compatible MetaFont outlines to a TTF. mf2pt1 emits a
 * Type 1 outline font from the MetaFont program; FontForge then performs the
 * final OpenType conversion. The required tools remain local and never touch
 * the user's source file.
 */
async function convertMetafontToTtf(source, suggestedName = 'font.mf') {
  const directory = await makeRenderDirectory('metafont-ttf');
  const baseName = metafontBaseName(suggestedName);
  const mfPath = path.join(directory, `${baseName}.mf`);
  const pfbPath = path.join(directory, `${baseName}.pfb`);
  const ttfPath = path.join(directory, `${baseName}.ttf`);
  const postscriptName = `${baseName.replace(/[^A-Za-z0-9]/g, '') || 'FoundryFont'}-Regular`;
  const familyName = safeName(baseName.replace(/[-_]+/g, ' '));
  await fs.writeFile(mfPath, source, 'utf8');

  try {
    await run('mf2pt1', [
      `--output-dir=${directory}`,
      `--name=${postscriptName}`,
      `--family=${familyName}`,
      `--fullname=${familyName} Regular`,
      '--encoding=standard',
      mfPath,
    ], directory, metafontEnvironment(directory), { timeoutMs: metafontConversionTimeoutMs });
    await fs.access(pfbPath);
  } catch (error) {
    return { ok: false, error: await metafontErrorMessage(directory, baseName, error, 'mf2pt1') };
  }

  try {
    await run('fontforge', ['-lang=ff', '-c', 'Open($1); Generate($2);', pfbPath, ttfPath], directory, {}, { timeoutMs: metafontConversionTimeoutMs });
    await fs.access(ttfPath);
    return { ok: true, ttfPath, pfbPath, directory };
  } catch (error) {
    return { ok: false, error: await metafontErrorMessage(directory, baseName, error, 'fontforge') };
  }
}

async function convertSvg(svg, format, scale = 1) {
  const directory = await makeRenderDirectory('svg');
  const input = path.join(directory, 'diagram.svg');
  const output = path.join(directory, `diagram.${format}`);
  await fs.writeFile(input, svg, 'utf8');
  if (format === 'svg') return { output, directory };
  const args = ['-f', format];
  if (format === 'png' && scale > 1) args.push('-z', String(scale));
  args.push('-o', output, input);
  await run('rsvg-convert', args, directory);
  return { output, directory };
}

async function convertHtml(html, format, scale = 1) {
  if (!['png', 'pdf', 'html'].includes(format)) throw new Error('HTML previews support HTML, PNG, and PDF export only.');
  const directory = await makeRenderDirectory('html');
  const output = path.join(directory, `document.${format}`);
  if (format === 'html') {
    await fs.writeFile(output, html, 'utf8');
    return { output, directory };
  }
  const exportWindow = new BrowserWindow({
    show: false,
    width: 1440 * scale,
    height: 980 * scale,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await exportWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await exportWindow.webContents.executeJavaScript('document.fonts ? document.fonts.ready : Promise.resolve()');
    if (format === 'pdf') {
      const data = await exportWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'default' },
      });
      await fs.writeFile(output, data);
      return { output, directory };
    }

    const height = await exportWindow.webContents.executeJavaScript('Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))');
    if (height > 16000) throw new Error('This document is too tall for a single PNG. Export it as a PDF instead.');
    exportWindow.setContentSize(1440 * scale, Math.max(900 * scale, height + 32 * scale));
    const image = await exportWindow.webContents.capturePage();
    await fs.writeFile(output, image.toPNG());
    return { output, directory };
  } finally {
    if (!exportWindow.isDestroyed()) exportWindow.destroy();
  }
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A defensive export fallback for code/data modes. The renderer normally
 * sends a complete preview document, but source must never be interpreted as
 * HTML merely because a preview has not arrived yet.
 */
function sourceTextPreviewHtml(source, label) {
  const escapedLabel = escapeHtmlText(label || 'Source');
  const escapedSource = escapeHtmlText(source || '');
  return '<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />'
    + '<title>' + escapedLabel + '</title>'
    + '<style>body{margin:0;padding:32px;background:#111622;color:#d9e3f8;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}h1{margin:0 0 18px;font:700 18px/1.2 system-ui,sans-serif}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style>'
    + '</head><body><h1>' + escapedLabel + '</h1><pre>' + escapedSource + '</pre></body></html>';
}

async function exportPayload(payload) {
  const { sourceType, source, svg, html, format, suggestedName = 'diagram', engine, texEngine } = payload;
  // `engine` is the public payload field.  Keep the former internal spelling
  // as an alias so queued renderer work from an older window still exports.
  const requestedTexEngine = engine ?? texEngine;
  const requestedScale = Number(payload?.scale);
  const scale = [1, 2, 4].includes(requestedScale) ? requestedScale : 1;
  let generated;
  let extension = format;

  try {
    if (sourceType === 'tikz' || sourceType === 'latex') {
      if (!['png', 'svg', 'pdf', 'dvi'].includes(format)) {
        return { ok: false, error: 'LaTeX and TikZ source files support PNG, SVG, and PDF export; LaTeX also supports DVI.' };
      }
      if (format === 'dvi' && sourceType !== 'latex') {
        return { ok: false, error: 'DVI export is available for LaTeX source files.' };
      }
      const compilation = sourceType === 'latex'
        ? await renderLatex(source, `${suggestedName}.tex`, format === 'dvi' ? 'dvi' : 'pdf', requestedTexEngine)
        : await renderTikz(source, `${suggestedName}.tikz`, requestedTexEngine);
      if (!compilation.ok) return { ok: false, error: compilation.error };
      if (format === 'dvi') {
        generated = compilation.dviPath;
      } else if (format === 'pdf') {
        generated = compilation.pdfPath;
      } else {
        const output = path.join(compilation.directory, `diagram.${format}`);
        const args = format === 'png'
          ? ['-png', '-singlefile', '-r', String(144 * scale), compilation.pdfPath, path.join(compilation.directory, 'diagram')]
          : ['-svg', compilation.pdfPath, output];
        await run('pdftocairo', args, compilation.directory);
        generated = output;
      }
    } else if (sourceType === 'metafont') {
      if (!['png', 'svg', 'pdf', 'ttf'].includes(format)) {
        return { ok: false, error: 'MetaFont source files support GF-proof PNG, SVG, and PDF exports, plus TTF outline conversion.' };
      }
      if (format === 'ttf') {
        const conversion = await convertMetafontToTtf(source, `${suggestedName}.mf`);
        if (!conversion.ok) return { ok: false, error: conversion.error };
        generated = conversion.ttfPath;
      } else {
        const proof = await renderMetafont(source, `${suggestedName}.mf`);
        if (!proof.ok) return { ok: false, error: proof.error };
        const result = await convertSvg(proof.svg, format, scale);
        generated = result.output;
      }
    } else if (['markdown', 'text', 'yaml', 'json', 'javascript', 'typescript', 'python', 'fortran', 'sql', 'html', 'css'].includes(sourceType)) {
      const documentForExport = html || (sourceType === 'html' ? source : sourceTextPreviewHtml(source, sourceType));
      const result = await convertHtml(documentForExport, format, scale);
      generated = result.output;
    } else {
      const renderedSvg = svg || source;
      const result = await convertSvg(renderedSvg, format, scale);
      generated = result.output;
    }
  } catch (error) {
    return { ok: false, error: [error.stderr, error.stdout, error.message].filter(Boolean).join('\n') };
  }

  const choice = await dialog.showSaveDialog(mainWindow, {
    title: `Export ${format.toUpperCase()}`,
    defaultPath: `${safeName(suggestedName)}.${extension}`,
    filters: [{ name: `${format.toUpperCase()} file`, extensions: [extension] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: true, canceled: true };
  await fs.copyFile(generated, choice.filePath);
  return { ok: true, path: choice.filePath };
}

function sendToRenderer(action) {
  const webContents = currentMainWebContents();
  if (!webContents) return;
  if (!rendererReady) {
    pendingRendererActions.push(action);
    return;
  }
  if (!safelySend(webContents, 'menu-action', action)) {
    rendererReady = false;
    pendingRendererActions = [];
  }
}

function menuTemplate(settings = defaultSettings) {
  const isMac = process.platform === 'darwin';
  const enabledSourceTypes = new Set(
    Array.isArray(settings?.enabledSourceTypes)
      ? settings.enabledSourceTypes.filter((type) => sourceTypeIds.includes(type))
      : defaultSettings.enabledSourceTypes,
  );
  const sourceItem = (type, label, action, accelerator) => {
    if (!enabledSourceTypes.has(type)) return undefined;
    return {
      label,
      ...(accelerator ? { accelerator } : {}),
      click: () => sendToRenderer(action),
    };
  };
  const sourceGroup = (label, items) => {
    const submenu = items.filter(Boolean);
    return submenu.length ? { label, submenu } : undefined;
  };
  const sourceCreationSubmenu = [
    sourceGroup('Diagram & Documents', [
      sourceItem('tikz', 'TikZ (.tikz)', 'new-tikz'),
      sourceItem('latex', 'LaTeX (.tex)', 'new-latex'),
      sourceItem('metafont', 'MetaFont (.mf)', 'new-metafont'),
      sourceItem('svg', 'SVG (.svg)', 'new-svg'),
      sourceItem('mermaid', 'Mermaid (.mmd)', 'new-mermaid'),
      sourceItem('markdown', 'Markdown (.md)', 'new-markdown'),
      sourceItem('text', 'Plain Text (.txt)', 'new-text'),
    ]),
    sourceGroup('Data', [
      sourceItem('yaml', 'YAML (.yaml)', 'new-yaml'),
      sourceItem('json', 'JSON (.json)', 'new-json'),
    ]),
    sourceGroup('Code & Web', [
      sourceItem('javascript', 'JavaScript (.js)', 'new-javascript'),
      sourceItem('typescript', 'TypeScript (.ts)', 'new-typescript'),
      sourceItem('python', 'Python (.py)', 'new-python'),
      sourceItem('fortran', 'Fortran (.f90)', 'new-fortran'),
      sourceItem('sql', 'SQL (.sql)', 'new-sql'),
      sourceItem('html', 'HTML (.html)', 'new-html'),
      sourceItem('css', 'CSS (.css)', 'new-css'),
    ]),
  ].filter(Boolean);
  const diagramSourceItems = [
    sourceItem('tikz', 'TikZ Source', 'select-tikz', 'CmdOrCtrl+1'),
    sourceItem('latex', 'LaTeX Source', 'select-latex', 'CmdOrCtrl+2'),
    sourceItem('metafont', 'MetaFont Source', 'select-metafont', 'CmdOrCtrl+3'),
    sourceItem('svg', 'SVG Source', 'select-svg', 'CmdOrCtrl+4'),
    sourceItem('mermaid', 'Mermaid Source', 'select-mermaid', 'CmdOrCtrl+5'),
    sourceItem('markdown', 'Markdown Source', 'select-markdown', 'CmdOrCtrl+6'),
    sourceItem('text', 'Plain Text Source', 'select-text', 'CmdOrCtrl+7'),
  ].filter(Boolean);
  const diagramSubmenu = [
    ...diagramSourceItems,
    { type: 'separator' },
    { label: 'Render Preview', accelerator: 'CmdOrCtrl+Enter', click: () => sendToRenderer('render') },
  ];
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToRenderer('new-project') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: () => sendToRenderer('open-file') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendToRenderer('open-project') },
        { type: 'separator' },
        { label: 'New Source File…', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('new-file') },
        {
          label: 'New Source As',
          submenu: sourceCreationSubmenu,
        },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendToRenderer('save-as') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => sendToRenderer('export') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToRenderer('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => sendToRenderer('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Format Document', accelerator: 'Shift+Alt+F', click: () => sendToRenderer('format') },
      ],
    },
    {
      label: 'JSON',
      submenu: [
        { label: 'Validate JSON', click: () => sendToRenderer('json-validate') },
        { label: 'Pretty print JSON', accelerator: 'Shift+Alt+J', click: () => sendToRenderer('json-pretty') },
        { label: 'Minify JSON', click: () => sendToRenderer('json-minify') },
        { type: 'separator' },
        { label: 'Generate JSON Schema', click: () => sendToRenderer('json-schema') },
        { type: 'separator' },
        { label: 'Create JSON with AI prompt…', click: () => sendToRenderer('json-prompt-create') },
        { label: 'Analyze JSON with AI prompt…', click: () => sendToRenderer('json-prompt-analyze') },
      ],
    },
    {
      label: 'Python',
      submenu: [
        { label: 'Run Active Python Source', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendToRenderer('build') },
        { label: 'Test Active Python Source', click: () => sendToRenderer('python-test') },
        { type: 'separator' },
        { label: 'Show Python Output', click: () => sendToRenderer('python-output') },
      ],
    },
    {
      label: 'Diagram',
      submenu: diagramSubmenu,
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'Shift+CmdOrCtrl+P', click: () => sendToRenderer('palette') },
        { label: 'Toggle Explorer', click: () => sendToRenderer('explorer') },
        { label: 'Toggle Live Preview', click: () => sendToRenderer('preview') },
        { label: 'Toggle Reference Deck', accelerator: 'CmdOrCtrl+Shift+R', click: () => sendToRenderer('references') },
        { label: 'Reset Panel Layout', click: () => sendToRenderer('reset-layout') },
        { type: 'separator' },
        { label: 'Prompt Studio…', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendToRenderer('prompt-studio') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendToRenderer('settings') },
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'About Yedit', click: () => sendToRenderer('about') },
      ],
    },
  ];
}

function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#10131b' : '#f4f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const windowForCleanup = mainWindow;
  const webContentsForCleanup = windowForCleanup.webContents;
  webContentsForCleanup.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) return;
    rendererReady = false;
    pendingRendererActions = [];
  });
  windowForCleanup.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  let projectWatchersStopped = false;
  const stopWindowProjectWatchers = () => {
    if (projectWatchersStopped) return;
    projectWatchersStopped = true;
    stopProjectWatchersFor(webContentsForCleanup);
  };
  webContentsForCleanup.once('destroyed', stopWindowProjectWatchers);
  windowForCleanup.on('closed', () => {
    stopWindowProjectWatchers();
    if (mainWindow === windowForCleanup) mainWindow = undefined;
    rendererReady = false;
    pendingRendererActions = [];
  });
  if (process.env.ELECTRON_DEV === '1' && isLiveWebContents(webContentsForCleanup)) {
    webContentsForCleanup.openDevTools({ mode: 'detach' });
  }
}

app.whenReady().then(async () => {
  const settings = await loadSettings();
  nativeTheme.themeSource = settings.appearance;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(settings)));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  for (const watchId of [...projectWatchers.keys()]) stopProjectWatcher(watchId);
});

ipcMain.handle('project:open', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a Yedit project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  return projectPayload(picked.filePaths[0]);
});

ipcMain.handle('project:open-file', async (event, projectRoot) => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a Yedit source file',
    properties: ['openFile'],
    filters: [{ name: 'Yedit source files', extensions: [...sourceExtensions].map((extension) => extension.slice(1)).sort() }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  return standaloneSourcePayload(event.sender, picked.filePaths[0], projectRoot);
});

ipcMain.handle('project:create', async (_event, name) => {
  const parent = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where to create the project',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (parent.canceled || !parent.filePaths[0]) return { canceled: true };
  const root = path.join(parent.filePaths[0], safeName(name));
  if (fssync.existsSync(root)) throw new Error('A folder with that project name already exists.');
  await fs.mkdir(path.join(root, 'diagrams'), { recursive: true });
  await fs.mkdir(path.join(root, 'documents'), { recursive: true });
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, '.yedit.json'), JSON.stringify({ name: safeName(name), version: 1 }, null, 2));
  // A project supplies only an empty, predictable folder structure.  Complete
  // source examples are available from the explicit Template Gallery; creating
  // a project must not silently add boilerplate in any format.
  return projectPayload(root);
});

ipcMain.handle('project:refresh', async (_event, root) => projectPayload(root));
ipcMain.handle('project:open-recent', async (_event, root) => projectPayload(root));
ipcMain.handle('project:read-file', async (_event, root, relativePath) => {
  const workspace = await projectWorkspace(root);
  const source = await projectFile(workspace, relativePath);
  return fs.readFile(source.target, 'utf8');
});
ipcMain.handle('project:write-file', async (_event, root, relativePath, content) => {
  if (typeof content !== 'string') throw new Error('Project source must be text.');
  const workspace = await projectWorkspace(root);
  const source = await projectFile(workspace, relativePath);
  await fs.writeFile(source.target, content, 'utf8');
  return { relativePath: source.relativePath };
});
ipcMain.handle('project:create-file', async (_event, root, relativePath, content) => {
  if (typeof content !== 'string') throw new Error('Project source must be text.');
  const workspace = await projectWorkspace(root);
  const destination = await projectCreateDestination(workspace, relativePath);
  await fs.writeFile(destination.target, content, 'utf8');
  return { relativePath: destination.relativePath };
});
ipcMain.handle('project:rename-file', async (_event, root, fromRelativePath, toRelativePath) => {
  const workspace = await projectWorkspace(root);
  const source = await projectFile(workspace, fromRelativePath);
  const destinationPath = assertProjectRelativePath(workspace.root, toRelativePath);
  if (source.target === destinationPath) return { relativePath: source.relativePath };
  const destination = await projectDestination(workspace, toRelativePath);
  await fs.rename(source.target, destination.target);
  return { relativePath: destination.relativePath, previousRelativePath: source.relativePath };
});
ipcMain.handle('project:duplicate-file', async (_event, root, fromRelativePath, toRelativePath) => {
  const workspace = await projectWorkspace(root);
  const source = await projectFile(workspace, fromRelativePath);
  const destination = await projectDestination(workspace, toRelativePath);
  await fs.copyFile(source.target, destination.target, fssync.constants.COPYFILE_EXCL);
  return { relativePath: destination.relativePath, sourceRelativePath: source.relativePath };
});
ipcMain.handle('project:delete-file', async (_event, root, relativePath) => {
  const workspace = await projectWorkspace(root);
  const source = await projectFile(workspace, relativePath);
  await fs.unlink(source.target);
  return { relativePath: source.relativePath };
});
ipcMain.handle('project:watch', async (event, root) => watchProject(root, event.sender));
ipcMain.handle('project:unwatch', async (event, watchId) => {
  const record = projectWatchers.get(watchId);
  if (record && record.sender !== event.sender) throw new Error('That project watcher belongs to another window.');
  return { stopped: stopProjectWatcher(watchId) };
});
ipcMain.handle('project:build-profiles', async () => buildProfiles.map((profile) => ({ ...profile, sourceTypes: [...profile.sourceTypes] })));
ipcMain.handle('project:run-build', async (_event, root, relativePath, profileId) => runBuildProfile(root, relativePath, profileId));
ipcMain.handle('project:run-python', async (_event, source, name, options) => runPythonSource(source, name, options));
ipcMain.handle('project:write-open-file', async (event, fileHandle, content) => {
  if (typeof content !== 'string') throw new Error('Source content must be text.');
  const source = await openedStandaloneFile(event.sender, fileHandle);
  await saveStandaloneSource(source.target, content);
  return { name: path.basename(source.target) };
});
ipcMain.handle('project:save-as', async (event, suggestedName, content, type, projectRoot) => {
  if (typeof content !== 'string') throw new Error('Source content must be text.');
  const extension = extensionForType(type);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save source as',
    defaultPath: `${path.basename(suggestedName || 'diagram').replace(/\.[^/.]+$/, '')}.${extension}`,
    filters: [{ name: `${type} source`, extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const target = path.resolve(result.filePath);
  await saveStandaloneSource(target, content);
  return { name: path.basename(target), ...await sourceLocation(event.sender, target, projectRoot) };
});
ipcMain.handle('render:tikz', async (_event, source, name, engine) => renderTikz(source, name, engine));
ipcMain.handle('render:latex', async (_event, source, name, mode, engine) => renderLatex(source, name, mode, engine));
ipcMain.handle('render:metafont', async (_event, source, name) => renderMetafont(source, name));
ipcMain.handle('render:export', async (_event, payload) => exportPayload(payload));
ipcMain.handle('git:status', async (_event, root) => gitStatus(root));
ipcMain.handle('git:diff', async (_event, root, relativePath, options) => gitDiff(root, relativePath, options));
ipcMain.handle('git:log', async (_event, root, relativePath, options) => gitLog(root, relativePath, options));
ipcMain.handle('clipboard:write-svg', async (_event, svg) => {
  if (typeof svg !== 'string' || !svg.trim()) throw new Error('There is no SVG to copy.');
  if (Buffer.byteLength(svg, 'utf8') > 5 * 1024 * 1024) throw new Error('That SVG is too large to copy to the clipboard.');
  clipboard.writeText(svg);
  return { ok: true };
});
ipcMain.handle('clipboard:write-data-uri-image', async (_event, dataUri) => {
  if (typeof dataUri !== 'string' || !/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(dataUri)) {
    throw new Error('Copy Image expects a PNG, JPEG, GIF, or WebP data URI.');
  }
  if (Buffer.byteLength(dataUri, 'utf8') > 30 * 1024 * 1024) throw new Error('That image is too large to copy to the clipboard.');
  const image = nativeImage.createFromDataURL(dataUri);
  if (image.isEmpty()) throw new Error('The preview image could not be copied.');
  clipboard.writeImage(image);
  return { ok: true, size: image.getSize() };
});
ipcMain.on('renderer:ready', (event) => {
  const webContents = currentMainWebContents();
  if (!webContents || event.sender !== webContents) return;
  rendererReady = true;
  const queued = pendingRendererActions;
  pendingRendererActions = [];
  for (const action of queued) {
    if (safelySend(webContents, 'menu-action', action)) continue;
    rendererReady = false;
    pendingRendererActions = [];
    break;
  }
});
ipcMain.handle('settings:load', async () => {
  const settings = await loadSettings();
  nativeTheme.themeSource = settings.appearance;
  return settings;
});
ipcMain.handle('settings:save', async (_event, settings) => saveSettings(settings));
ipcMain.handle('shell:reveal', async (_event, target) => shell.showItemInFolder(target));
