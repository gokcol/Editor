# Desktop releases

Both applications use version 1.0.1. Downloads are published together at
<https://github.com/gokcol/Editor/releases>.

| Platform | Package | Runtime |
| --- | --- | --- |
| macOS 12 or newer | One universal `.dmg` per app, for Apple silicon and Intel | System WKWebView |
| Windows 10/11 x64 | One per-user NSIS `-setup.exe` per app | Microsoft Edge WebView2; the installer downloads its bootstrapper if needed |

macOS packages are ad-hoc signed, without Developer ID or Apple notarization.
Windows packages have no Authenticode signature. OS security checks may block
these downloads or show an unidentified-publisher warning. These packages do not
provide the trust guarantees of a notarized or publisher-signed release.

## Platform support

Both apps provide local text editing, opening and saving, encoding controls,
recent files, conflict protection, and draft recovery. 7TXT also provides
Markdown preview, PDF/image viewing, and a lightweight file browser. Windows
uses known user folders and the Recycle Bin. Undo history in 7TXT is capped at
100 versions, and large-file input defers statistics, outline, and preview work.

The following optional features remain macOS-only in this release:

- Ask AI through the Codex companion. Windows companion discovery and process
  cancellation have not been validated, so Windows does not launch it.
- Native HTML/Markdown conversion to PNG/PDF through the bundled WebKit bridge.
  HTML export remains available on Windows.
- Yedit's fixed Bash project task scripts. Declarative allowlisted tasks can
  use installed native executables. No WSL or shell is installed automatically.
- Yedit's Reveal in Finder action.

Yedit's TeX, MetaFont, and other external-tool workflows require the corresponding
tools on PATH; they are not bundled. Windows support does not add compilers or
language servers to the offline language editing modes. Some help text and
shortcut hints retain macOS symbols; native menus use Ctrl on Windows, and
Yedit's configurable command shortcuts default to Ctrl there.

## Reproducing packages

Use Node 24 or newer, stable Rust, and the platform prerequisites documented by
[Tauri](https://v2.tauri.app/start/prerequisites/). Install both lockfiles:

```sh
npm ci
npm --prefix 7txt ci
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path 7txt/src-tauri/Cargo.toml
```

On Windows, run `npm run package:windows` and
`npm --prefix 7txt run package:windows`. Platform-specific Tauri configurations
select NSIS and per-user installation without changing macOS settings.

On macOS, `npm run package:mac` and `npm --prefix 7txt run package:mac` use the
configured Developer ID identity. The GitHub **Release builds** workflow overrides
that identity with `-` and builds a universal binary using both Apple targets.

The workflow runs shared and native tests on both systems, verifies both macOS
architectures and app signatures, and tests the actual Windows Tauri/WebView2
executables with synthetic files: external file open, Unicode editing and save,
draft checkpointing, and recovery after restart. Browser automation connects
through an environment variable set only for the CI child processes; no test
bridge or debugging port is compiled into production configuration.

Build artifacts include Windows smoke reports/screenshots. Publication is a
separate step after both platform jobs succeed. Release assets include SHA-256
checksums for all installers.
