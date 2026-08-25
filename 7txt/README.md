# 7TXT

7TXT is Yedit's deliberately small, independent companion: a native macOS editor
for `.txt`, `.md`, and `.markdown` files.

It provides local open/save, recent files, undo/redo, find, cursor and document
statistics, Markdown outline navigation, safe local Markdown preview, and an
explicit encoding selector for UTF, ISO-8859, Windows, Mac, Cyrillic, and East
Asian text files. It
does not load remote content or include AI, project pipelines, diagram renderers,
or a heavyweight code editor runtime.

## Run or build

From this folder:

```sh
npm run dev
npm run build
```

The scripts use the workspace's already-installed Tauri, TypeScript, and Vite
packages. Run `npm install` in the parent workspace first if those are absent.

`npm run build` produces `src-tauri/target/release/bundle/macos/7TXT.app`.
