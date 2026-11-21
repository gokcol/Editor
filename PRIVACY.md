# 7TXT and Yedit privacy policy

Effective date: 21 November 2026

7TXT and Yedit are desktop editors by Orhan Gökçöl. This policy covers their
GitHub downloads and Microsoft Store editions.

## Editing on your computer

The editors read, display, edit, preview and save files locally. Documents, source
code, Markdown, PDF/image content, local annotations and file paths are not sent
to a developer-operated server. The editors require no account for ordinary
editing and contain no advertising, analytics or automatic crash-report uploads.
Editor assets and language definitions are bundled rather than loaded from a CDN.

You choose the files and folders to open, save, export or copy. Clipboard content
can be accessed by other applications and any clipboard synchronization service
you enable. Files in cloud-synced or network folders are subject to those services
and your configuration. External links open in your browser; the destination
receives ordinary connection information under its own privacy policy.

Yedit can invoke installed development tools and local Git operations at your
request. Those tools, project scripts and their configuration have their own
behavior and data handling. No compiler or AI service is required for basic
editing. Some native exports and optional integrations are available only on
macOS; see the platform support documentation.

## Preferences, recent files and recovery

The editors store preferences, recent paths, local history and draft recovery on
your computer. Recovery and history may contain document contents, including
unsaved or confidential material. They are not separately encrypted by the app;
protection depends on your operating-system permissions and disk encryption.
Temporary files may be created during preview, export or external-tool work.

On Windows, app data uses the per-user application-data location for
`com.gokcol.7txt` or `com.yedit.desktop`, together with WebView2's local browser
storage. The Microsoft Store editions use standard MSIX data virtualization.
Preferences and recovery created in the Store edition can be private to that
package and removed on uninstall or reset. Save unfinished documents to a folder
you choose before removing or resetting the app. Files saved in your Documents
folder or another chosen location are not intentionally deleted by uninstall.
Data sharing with the direct-download edition is not guaranteed.

On macOS, the apps use their application-support locations and local WebKit
storage. 7TXT may keep annotations beside an opened media file. Use the editor's
history, recovery and file-management controls, or the operating system, to
manage unwanted local data. 7TXT's Trash/Recycle Bin operation delegates recovery
to the operating system.

## Optional AI and network services

**App updates:** Check for Updates requests public release metadata from GitHub
for direct-download macOS and Windows installations. It sends a normal network
request and the app name/version, with no documents, selections or file paths.
Microsoft Store installations query Microsoft's Store services instead. Optional
daily checks are off by default. The preference, last attempt time and dismissed
release are stored locally. Release downloads open in your browser only when
you choose Download; the editors do not silently download or install updates.

The Windows editions do not enable the optional Codex companion integration in
version 1.0.1. On macOS, Ask AI can use an installed Codex companion and your
existing ChatGPT sign-in. Context defaults to none. Choosing Send transmits your
prompt and the context you explicitly selected to OpenAI through that companion.
OpenAI's account and privacy terms govern that processing. AI replies remain
text for you to review; they are not automatically applied or saved. Do not send
confidential content unless you intend that disclosure.

Microsoft Store downloads, updates and Store diagnostics are handled by Microsoft
under its policies. Windows 11's system WebView2 runtime is maintained by
Microsoft; the editors do not send document content to Microsoft for rendering.
GitHub processes requests to the source, privacy page and direct downloads under
its own policies.

## Contact

For privacy or support questions, contact
[orhan.gokcol@hotmail.com](mailto:orhan.gokcol@hotmail.com) or use
[the issue tracker](https://github.com/gokcol/Editor/issues). Do not post
confidential documents or personal information in public issues. Changes to this
policy will be published here with an updated effective date.
