import { invoke, isTauri, type InvokeArgs } from '@tauri-apps/api/core';
import { listen, type EventName, type UnlistenFn } from '@tauri-apps/api/event';
import type { DesktopApi } from './contract';

type ProjectApi = DesktopApi['project'];
type RecentsApi = DesktopApi['recents'];
type RenderApi = DesktopApi['render'];
type SettingsApi = DesktopApi['settings'];
type GitApi = DesktopApi['git'];
type ClipboardApi = DesktopApi['clipboard'];
type ExternalFilesApi = DesktopApi['externalFiles'];
type PythonRunner = NonNullable<ProjectApi['runPython']>;
type EmptyArgs = Record<string, never>;

/** Raw values returned by the Rust task commands. Keep this shape private to
 * the Tauri boundary; React only receives the normalized DesktopApi types. */
type RawProjectTask = {
  id: string;
  label: string;
  scriptName?: string;
  relativePath?: string;
  command?: string;
  kind?: string;
};
type RawProjectTaskList = {
  root: string;
  tasks: RawProjectTask[];
};
type RawProjectTaskRun = {
  ok: boolean;
  task?: RawProjectTask;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
  artifact?: {
    path?: string;
    relativePath?: string;
    dataUri?: string | null;
  } | null;
};

/** Native-to-renderer event names shared with the Tauri backend. */
export const TAURI_PROJECT_CHANGED_EVENT = 'project-changed';
export const TAURI_MENU_ACTION_EVENT = 'menu-action';
export const TAURI_EXTERNAL_OPEN_FILES_EVENT = 'external-open-files';

/**
 * Every native command that the Tauri adapter is allowed to invoke. Keeping
 * names, argument casing, and response types here makes command drift local
 * to the desktop boundary instead of spreading untyped invoke calls through
 * the workbench.
 */
type TauriCommandArgs = {
  recovery_load: EmptyArgs;
  recovery_save: { payload: unknown };
  recovery_finish_close: EmptyArgs;
  project_open: EmptyArgs;
  project_open_file: { projectRoot?: Parameters<ProjectApi['openFile']>[0]; encoding?: Parameters<ProjectApi['openFile']>[1] };
  project_reveal_open_file_folder: { fileHandle: Parameters<ProjectApi['revealOpenedFileFolder']>[0] };
  project_create: { name: Parameters<ProjectApi['create']>[0] };
  project_refresh: { root: Parameters<ProjectApi['refresh']>[0] };
  project_read_file: { root: Parameters<ProjectApi['readFile']>[0]; relativePath: Parameters<ProjectApi['readFile']>[1]; encoding?: Parameters<ProjectApi['readFile']>[2]; bindingMode?: Parameters<ProjectApi['readFile']>[3] };
  project_write_file: { root: Parameters<ProjectApi['writeFile']>[0]; relativePath: Parameters<ProjectApi['writeFile']>[1]; content: Parameters<ProjectApi['writeFile']>[2]; encoding?: Parameters<ProjectApi['writeFile']>[3]; expectedVersion?: Parameters<ProjectApi['writeFile']>[4] };
  project_create_file: { root: Parameters<ProjectApi['createFile']>[0]; relativePath: Parameters<ProjectApi['createFile']>[1]; content: Parameters<ProjectApi['createFile']>[2] };
  project_rename_file: { root: Parameters<ProjectApi['renameFile']>[0]; fromRelativePath: Parameters<ProjectApi['renameFile']>[1]; toRelativePath: Parameters<ProjectApi['renameFile']>[2] };
  project_duplicate_file: { root: Parameters<ProjectApi['duplicateFile']>[0]; fromRelativePath: Parameters<ProjectApi['duplicateFile']>[1]; toRelativePath: Parameters<ProjectApi['duplicateFile']>[2] };
  project_delete_file: { root: Parameters<ProjectApi['deleteFile']>[0]; relativePath: Parameters<ProjectApi['deleteFile']>[1] };
  project_watch: { root: Parameters<ProjectApi['watch']>[0] };
  project_unwatch: { watchId: Parameters<ProjectApi['unwatch']>[0] };
  project_list_tasks: { root: Parameters<ProjectApi['listTasks']>[0] };
  project_run_task: { root: Parameters<ProjectApi['runTask']>[0]; taskId: Parameters<ProjectApi['runTask']>[1] };
  project_build_profiles: EmptyArgs;
  project_run_build: { root: Parameters<ProjectApi['runBuild']>[0]; relativePath: Parameters<ProjectApi['runBuild']>[1]; profileId: Parameters<ProjectApi['runBuild']>[2] };
  project_run_python: { source: Parameters<PythonRunner>[0]; name: Parameters<PythonRunner>[1]; options?: Parameters<PythonRunner>[2] };
  project_write_open_file: { fileHandle: Parameters<ProjectApi['writeOpenedFile']>[0]; content: Parameters<ProjectApi['writeOpenedFile']>[1]; encoding?: Parameters<ProjectApi['writeOpenedFile']>[2]; expectedVersion?: Parameters<ProjectApi['writeOpenedFile']>[3] };
  project_read_open_file: { fileHandle: Parameters<ProjectApi['readOpenedFile']>[0]; encoding?: Parameters<ProjectApi['readOpenedFile']>[1] };
  project_save_as: { suggestedName: Parameters<ProjectApi['saveAs']>[0]; content: Parameters<ProjectApi['saveAs']>[1]; sourceType: Parameters<ProjectApi['saveAs']>[2]; projectRoot?: Parameters<ProjectApi['saveAs']>[3]; encoding?: Parameters<ProjectApi['saveAs']>[4] };
  recents_list: EmptyArgs;
  recents_migrate_legacy_projects: { projects: Parameters<RecentsApi['migrateLegacyProjects']>[0] };
  recents_open: { id: Parameters<RecentsApi['open']>[0]; projectRoot?: Parameters<RecentsApi['open']>[1]; encoding?: Parameters<RecentsApi['open']>[2] };
  recents_remove: { id: Parameters<RecentsApi['remove']>[0] };
  recents_clear: EmptyArgs;
  render_tikz: { source: Parameters<RenderApi['tikz']>[0]; name: Parameters<RenderApi['tikz']>[1]; engine?: Parameters<RenderApi['tikz']>[2] };
  render_latex: { source: Parameters<RenderApi['latex']>[0]; name: Parameters<RenderApi['latex']>[1]; mode?: Parameters<RenderApi['latex']>[2]; engine?: Parameters<RenderApi['latex']>[3] };
  render_metafont: { source: Parameters<RenderApi['metafont']>[0]; name: Parameters<RenderApi['metafont']>[1] };
  render_export: { payload: Parameters<RenderApi['export']>[0] };
  settings_load: EmptyArgs;
  settings_save: { settings: Parameters<SettingsApi['save']>[0] };
  git_status: { root: Parameters<GitApi['status']>[0] };
  git_diff: { root: Parameters<GitApi['diff']>[0]; relativePath?: Parameters<GitApi['diff']>[1]; options?: Parameters<GitApi['diff']>[2] };
  git_log: { root: Parameters<GitApi['log']>[0]; relativePath?: Parameters<GitApi['log']>[1]; options?: Parameters<GitApi['log']>[2] };
  git_stage: { root: Parameters<GitApi['stage']>[0]; relativePath: Parameters<GitApi['stage']>[1] };
  git_unstage: { root: Parameters<GitApi['unstage']>[0]; relativePath: Parameters<GitApi['unstage']>[1] };
  git_commit: { root: Parameters<GitApi['commit']>[0]; message: Parameters<GitApi['commit']>[1] };
  git_branches: { root: Parameters<GitApi['branches']>[0] };
  git_switch_branch: { root: Parameters<GitApi['switchBranch']>[0]; branch: Parameters<GitApi['switchBranch']>[1] };
  clipboard_write_svg: { svg: Parameters<ClipboardApi['writeSvg']>[0] };
  clipboard_write_data_uri_image: { dataUri: Parameters<ClipboardApi['writeDataUriImage']>[0] };
  shell_reveal: { target: Parameters<DesktopApi['shell']['reveal']>[0] };
  take_pending_external_files: { projectRoot?: Parameters<ExternalFilesApi['takePending']>[0] };
  renderer_ready: EmptyArgs;
};

type TauriCommandResult = {
  recovery_load: Awaited<ReturnType<DesktopApi['recovery']['load']>>;
  recovery_save: number;
  recovery_finish_close: void;
  project_open: Awaited<ReturnType<ProjectApi['open']>>;
  project_open_file: Awaited<ReturnType<ProjectApi['openFile']>>;
  project_reveal_open_file_folder: Awaited<ReturnType<ProjectApi['revealOpenedFileFolder']>>;
  project_create: Awaited<ReturnType<ProjectApi['create']>>;
  project_refresh: Awaited<ReturnType<ProjectApi['refresh']>>;
  project_read_file: Awaited<ReturnType<ProjectApi['readFile']>>;
  project_write_file: Awaited<ReturnType<ProjectApi['writeFile']>>;
  project_create_file: Awaited<ReturnType<ProjectApi['createFile']>>;
  project_rename_file: Awaited<ReturnType<ProjectApi['renameFile']>>;
  project_duplicate_file: Awaited<ReturnType<ProjectApi['duplicateFile']>>;
  project_delete_file: Awaited<ReturnType<ProjectApi['deleteFile']>>;
  project_watch: Awaited<ReturnType<ProjectApi['watch']>>;
  project_unwatch: Awaited<ReturnType<ProjectApi['unwatch']>>;
  project_list_tasks: RawProjectTaskList;
  project_run_task: RawProjectTaskRun;
  project_build_profiles: Awaited<ReturnType<ProjectApi['buildProfiles']>>;
  project_run_build: Awaited<ReturnType<ProjectApi['runBuild']>>;
  project_run_python: Awaited<ReturnType<PythonRunner>>;
  project_write_open_file: Awaited<ReturnType<ProjectApi['writeOpenedFile']>>;
  project_read_open_file: Awaited<ReturnType<ProjectApi['readOpenedFile']>>;
  project_save_as: Awaited<ReturnType<ProjectApi['saveAs']>>;
  recents_list: Awaited<ReturnType<RecentsApi['list']>>;
  recents_migrate_legacy_projects: Awaited<ReturnType<RecentsApi['migrateLegacyProjects']>>;
  recents_open: Awaited<ReturnType<RecentsApi['open']>>;
  recents_remove: Awaited<ReturnType<RecentsApi['remove']>>;
  recents_clear: Awaited<ReturnType<RecentsApi['clear']>>;
  render_tikz: Awaited<ReturnType<RenderApi['tikz']>>;
  render_latex: Awaited<ReturnType<RenderApi['latex']>>;
  render_metafont: Awaited<ReturnType<RenderApi['metafont']>>;
  render_export: Awaited<ReturnType<RenderApi['export']>>;
  settings_load: Awaited<ReturnType<SettingsApi['load']>>;
  settings_save: Awaited<ReturnType<SettingsApi['save']>>;
  git_status: Awaited<ReturnType<GitApi['status']>>;
  git_diff: Awaited<ReturnType<GitApi['diff']>>;
  git_log: Awaited<ReturnType<GitApi['log']>>;
  git_stage: Awaited<ReturnType<GitApi['stage']>>;
  git_unstage: Awaited<ReturnType<GitApi['unstage']>>;
  git_commit: Awaited<ReturnType<GitApi['commit']>>;
  git_branches: Awaited<ReturnType<GitApi['branches']>>;
  git_switch_branch: Awaited<ReturnType<GitApi['switchBranch']>>;
  clipboard_write_svg: Awaited<ReturnType<ClipboardApi['writeSvg']>>;
  clipboard_write_data_uri_image: Awaited<ReturnType<ClipboardApi['writeDataUriImage']>>;
  shell_reveal: Awaited<ReturnType<DesktopApi['shell']['reveal']>>;
  take_pending_external_files: Awaited<ReturnType<ExternalFilesApi['takePending']>>;
  renderer_ready: { ok: true };
};

type TauriCommand = keyof TauriCommandArgs;

function invokeCommand<Command extends TauriCommand>(
  command: Command,
  args?: TauriCommandArgs[Command],
): Promise<TauriCommandResult[Command]> {
  // Tauri's generic InvokeArgs does not preserve the command-specific shape;
  // that single boundary cast is guarded by TauriCommandArgs above.
  return invoke<TauriCommandResult[Command]>(command, args as InvokeArgs | undefined);
}

function taskDescription(task: RawProjectTask, script?: string, command?: string) {
  if (command) {
    const verb = task.kind === 'test' ? 'tests' : task.kind === 'lint' ? 'lints' : task.kind === 'format' ? 'formats' : task.kind === 'preview' ? 'builds a preview for' : 'runs against';
    return `Locally ${verb} this project with an explicit argv task from yedit.tasks.json.`;
  }
  if (task.kind === 'preview') {
    return script
      ? `Runs ${script} for a fast project PDF refresh. Run the full project build first when the project needs verified build state.`
      : 'Builds a fast project preview and opens its PDF. Run the full project build first when needed.';
  }
  return script
    ? `Runs ${script} to create the authoritative project output. Use this first for an assembled document.`
    : 'Builds the authoritative project output. Use this first for an assembled document.';
}

function normalizeProjectTask(task: RawProjectTask) {
  const script = task.scriptName || task.relativePath;
  const command = task.command;
  return {
    id: task.id,
    label: task.label,
    description: taskDescription(task, script, command),
    ...(script ? { script } : {}),
    ...(command ? { command } : {}),
    ...(task.kind ? { kind: task.kind as import('../types').ProjectTask['kind'] } : {}),
  };
}

function unsubscribeSafely(unlisten: UnlistenFn) {
  try {
    void Promise.resolve(unlisten()).catch(() => undefined);
  } catch {
    // Window teardown may have already disposed the Tauri event bridge.
  }
}

/**
 * Tauri's `listen` is asynchronous while DesktopApi subscriptions are
 * synchronous. This wrapper makes unsubscription safe even if React cleans up
 * an effect before the native listener has finished registering.
 */
type Subscription = {
  unsubscribe: () => void;
  /** Resolves after native listener registration succeeds or fails. */
  settled: Promise<void>;
};

function subscribe<T>(event: EventName, callback: (payload: T) => void): Subscription {
  let disposed = false;
  let unlisten: UnlistenFn | undefined;

  const registration = listen<T>(event, ({ payload }) => {
    if (!disposed) callback(payload);
  }).then((registeredUnlisten) => {
    unlisten = registeredUnlisten;
    if (disposed) unsubscribeSafely(registeredUnlisten);
  });
  // Effects that only need a cleanup function should not produce an unhandled
  // rejection if Tauri is shutting down while their listener is registering.
  const settled = registration.catch(() => undefined);

  return {
    settled,
    unsubscribe: () => {
      if (disposed) return;
      disposed = true;
      if (unlisten) unsubscribeSafely(unlisten);
    },
  };
}

/** Safe in browsers: only a real Tauri WebView selects this adapter. */
export function isTauriDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/**
 * Tauri implementation of the renderer contract. The React workbench only
 * receives DesktopApi and therefore has no IPC coupling.
 */
export function createTauriDesktopApi(): DesktopApi {
  if (!isTauriDesktop()) throw new Error('The Tauri desktop bridge is unavailable outside a Tauri WebView.');

  // App registers the menu subscriber immediately before rendererReady().
  // Tauri listener installation is asynchronous, so delay that native signal
  // until the subscription has settled or menu events could be lost.
  let menuActionRegistration = Promise.resolve();

  return {
    project: {
      open: () => invokeCommand('project_open'),
      openFile: (projectRoot, encoding) => invokeCommand('project_open_file', { projectRoot, encoding }),
      revealOpenedFileFolder: (fileHandle) => invokeCommand('project_reveal_open_file_folder', { fileHandle }),
      create: (name) => invokeCommand('project_create', { name }),
      refresh: (root) => invokeCommand('project_refresh', { root }),
      readFile: (root, relativePath, encoding, bindingMode) => invokeCommand('project_read_file', { root, relativePath, encoding, bindingMode }),
      writeFile: (root, relativePath, content, encoding, expectedVersion) => invokeCommand('project_write_file', { root, relativePath, content, encoding, expectedVersion }),
      createFile: (root, relativePath, content) => invokeCommand('project_create_file', { root, relativePath, content }),
      renameFile: (root, fromRelativePath, toRelativePath) => invokeCommand('project_rename_file', { root, fromRelativePath, toRelativePath }),
      duplicateFile: (root, fromRelativePath, toRelativePath) => invokeCommand('project_duplicate_file', { root, fromRelativePath, toRelativePath }),
      deleteFile: (root, relativePath) => invokeCommand('project_delete_file', { root, relativePath }),
      watch: (root) => invokeCommand('project_watch', { root }),
      unwatch: (watchId) => invokeCommand('project_unwatch', { watchId }),
      onChanged: (callback) => subscribe(TAURI_PROJECT_CHANGED_EVENT, callback).unsubscribe,
      listTasks: async (root) => {
        const response = await invokeCommand('project_list_tasks', { root });
        return response.tasks.map(normalizeProjectTask);
      },
      runTask: async (root, taskId) => {
        const response = await invokeCommand('project_run_task', { root, taskId });
        const task = response.task;
        const artifact = response.artifact ?? undefined;
        const output = response.output || [response.stdout, response.stderr].filter(Boolean).join('\n');
        return {
          ok: response.ok,
          taskId: task?.id || taskId,
          label: task?.label || 'Project task',
          ...(output ? { output } : {}),
          ...(response.error ? { error: response.error } : {}),
          ...(artifact?.path ? { outputPath: artifact.path } : {}),
          ...(artifact?.relativePath ? { outputRelativePath: artifact.relativePath } : {}),
          ...(artifact?.dataUri ? { dataUri: artifact.dataUri } : {}),
        };
      },
      buildProfiles: () => invokeCommand('project_build_profiles'),
      runBuild: (root, relativePath, profileId) => invokeCommand('project_run_build', { root, relativePath, profileId }),
      runPython: (source, name, options) => invokeCommand('project_run_python', { source, name, options }),
      writeOpenedFile: (fileHandle, content, encoding, expectedVersion) => invokeCommand('project_write_open_file', { fileHandle, content, encoding, expectedVersion }),
      readOpenedFile: (fileHandle, encoding) => invokeCommand('project_read_open_file', { fileHandle, encoding }),
      saveAs: (suggestedName, content, sourceType, projectRoot, encoding) => invokeCommand('project_save_as', { suggestedName, content, sourceType, projectRoot, encoding }),
    },
    recovery: {
      load: () => invokeCommand('recovery_load'),
      save: (payload) => invokeCommand('recovery_save', { payload }),
      onCloseRequested: (handler) => listen('recovery-close-requested', () => { void handler(); }),
      finishClose: () => invokeCommand('recovery_finish_close'),
    },
    recents: {
      list: () => invokeCommand('recents_list'),
      migrateLegacyProjects: (projects) => invokeCommand('recents_migrate_legacy_projects', { projects }),
      open: (id, projectRoot, encoding) => invokeCommand('recents_open', { id, projectRoot, encoding }),
      remove: (id) => invokeCommand('recents_remove', { id }),
      clear: () => invokeCommand('recents_clear'),
    },
    render: {
      tikz: (source, name, engine) => invokeCommand('render_tikz', { source, name, engine }),
      latex: (source, name, mode, engine) => invokeCommand('render_latex', { source, name, mode, engine }),
      metafont: (source, name) => invokeCommand('render_metafont', { source, name }),
      export: (payload) => invokeCommand('render_export', { payload }),
    },
    settings: {
      load: () => invokeCommand('settings_load'),
      save: (settings) => invokeCommand('settings_save', { settings }),
    },
    git: {
      status: (root) => invokeCommand('git_status', { root }),
      diff: (root, relativePath, options) => invokeCommand('git_diff', { root, relativePath, options }),
      log: (root, relativePath, options) => invokeCommand('git_log', { root, relativePath, options }),
      stage: (root, relativePath) => invokeCommand('git_stage', { root, relativePath }),
      unstage: (root, relativePath) => invokeCommand('git_unstage', { root, relativePath }),
      commit: (root, message) => invokeCommand('git_commit', { root, message }),
      branches: (root) => invokeCommand('git_branches', { root }),
      switchBranch: (root, branch) => invokeCommand('git_switch_branch', { root, branch }),
    },
    clipboard: {
      writeSvg: (svg) => invokeCommand('clipboard_write_svg', { svg }),
      writeDataUriImage: (dataUri) => invokeCommand('clipboard_write_data_uri_image', { dataUri }),
    },
    shell: {
      reveal: (target) => invokeCommand('shell_reveal', { target }),
    },
    externalFiles: {
      takePending: (projectRoot) => invokeCommand('take_pending_external_files', { projectRoot }),
      onOpen: (callback) => subscribe<void>(TAURI_EXTERNAL_OPEN_FILES_EVENT, () => callback()).unsubscribe,
    },
    onMenuAction: (callback) => {
      const subscription = subscribe(TAURI_MENU_ACTION_EVENT, callback);
      menuActionRegistration = subscription.settled;
      return subscription.unsubscribe;
    },
    rendererReady: () => {
      // Defer the lookup by one microtask too: React StrictMode can tear down
      // and recreate this effect synchronously, and the newest subscription
      // is the one that must be ready before native actions are released.
      void Promise.resolve()
        .then(() => menuActionRegistration)
        .then(() => invokeCommand('renderer_ready'))
        .catch(() => undefined);
    },
  };
}
