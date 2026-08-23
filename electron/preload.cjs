const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diagramApi', {
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    openFile: (projectRoot) => ipcRenderer.invoke('project:open-file', projectRoot),
    create: (name) => ipcRenderer.invoke('project:create', name),
    refresh: (root) => ipcRenderer.invoke('project:refresh', root),
    readFile: (root, relativePath) => ipcRenderer.invoke('project:read-file', root, relativePath),
    writeFile: (root, relativePath, content) => ipcRenderer.invoke('project:write-file', root, relativePath, content),
    createFile: (root, relativePath, content) => ipcRenderer.invoke('project:create-file', root, relativePath, content),
    renameFile: (root, fromRelativePath, toRelativePath) => ipcRenderer.invoke('project:rename-file', root, fromRelativePath, toRelativePath),
    duplicateFile: (root, fromRelativePath, toRelativePath) => ipcRenderer.invoke('project:duplicate-file', root, fromRelativePath, toRelativePath),
    deleteFile: (root, relativePath) => ipcRenderer.invoke('project:delete-file', root, relativePath),
    watch: (root) => ipcRenderer.invoke('project:watch', root),
    unwatch: (watchId) => ipcRenderer.invoke('project:unwatch', watchId),
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('project:changed', listener);
      return () => ipcRenderer.removeListener('project:changed', listener);
    },
    buildProfiles: () => ipcRenderer.invoke('project:build-profiles'),
    runBuild: (root, relativePath, profileId) => ipcRenderer.invoke('project:run-build', root, relativePath, profileId),
    runPython: (source, name, options) => ipcRenderer.invoke('project:run-python', source, name, options),
    writeOpenedFile: (fileHandle, content) => ipcRenderer.invoke('project:write-open-file', fileHandle, content),
    saveAs: (suggestedName, content, type, projectRoot) => ipcRenderer.invoke('project:save-as', suggestedName, content, type, projectRoot),
  },
  recents: {
    list: () => ipcRenderer.invoke('recents:list'),
    migrateLegacyProjects: (projects) => ipcRenderer.invoke('recents:migrate-legacy-projects', projects),
    open: (id, projectRoot) => ipcRenderer.invoke('recents:open', id, projectRoot),
    remove: (id) => ipcRenderer.invoke('recents:remove', id),
    clear: () => ipcRenderer.invoke('recents:clear'),
  },
  render: {
    tikz: (source, name, engine) => ipcRenderer.invoke('render:tikz', source, name, engine),
    latex: (source, name, mode, engine) => ipcRenderer.invoke('render:latex', source, name, mode, engine),
    metafont: (source, name) => ipcRenderer.invoke('render:metafont', source, name),
    export: (payload) => ipcRenderer.invoke('render:export', payload),
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
  },
  git: {
    status: (root) => ipcRenderer.invoke('git:status', root),
    diff: (root, relativePath, options) => ipcRenderer.invoke('git:diff', root, relativePath, options),
    log: (root, relativePath, options) => ipcRenderer.invoke('git:log', root, relativePath, options),
  },
  clipboard: {
    writeSvg: (svg) => ipcRenderer.invoke('clipboard:write-svg', svg),
    writeDataUriImage: (dataUri) => ipcRenderer.invoke('clipboard:write-data-uri-image', dataUri),
  },
  shell: {
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path),
  },
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  },
  rendererReady: () => ipcRenderer.send('renderer:ready'),
});
