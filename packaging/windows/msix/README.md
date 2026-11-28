# Microsoft Store packages

The Store packages use the released Windows x64 executables for 7TXT **1.0.4**
and Yedit **1.0.2**, with MSIX versions **1.0.4.0** and **1.0.2.0** respectively.
They require **Windows 11 (22000+)** and
use the system Evergreen WebView2 runtime. The separate GitHub NSIS installers
continue to support Windows 10 and 11.

## Product identities

`products.json` contains the exact identities reserved in Partner Center.

| App | Store ID | Package name |
| --- | --- | --- |
| 7TXT | 9PB1F4G8F3WH | OrhanGkl.7TXT |
| Yedit | 9P3QNM6NK8L4 | OrhanGkl.Yedit |

The public publisher identity is not a signing credential. Upload the **unsigned
real-identity MSIX**; Microsoft signs it after certification. Never upload a
TEST-ONLY package or private signing material.

## Build and verification

Run the manually dispatched `store-msix.yml` workflow and select the product to
package. It verifies installer hashes against each release manifest, extracts the installed release
executables, and packages them with the Windows SDK's MakePri and MakeAppx.
`package-store-msix.ps1` checks the AMD64 PE, version, identity, payload hash,
capabilities and unsigned state. `verify-store-msix.py` independently checks the
ZIP, manifest, every 64 KiB block-map hash, whole-file hashes and package hash.

The artifact `Editor-Store-preparation-x64` contains `packages/` and `reports/`.
The package JSON records the exact released binary hash and packaging commit.
Reports and screenshots are evidence of the run that produced them, not a
Microsoft certification result.

CI signs disposable copies under separate test identities with a one-day test
certificate. It activates the registered AppUserModelID, opens an external UTF-8
file, verifies Unicode editing and saving, forces a restart and checks durable
draft recovery, then uninstalls the test packages. A sentinel in the existing
direct-edition data directory must survive. Test keys, certificates and signed
copies are deleted and excluded from uploaded artifacts. Native renderer
screenshots use fictional documents and the same released executable.

The workflow also attempts Windows App Certification Kit tests when the kit is
available. Read `WACK-status.json` and any XML report. An unavailable kit, timeout
or incomplete test requires a separate Windows 11 review. Passing functional
tests is not a WACK pass or Store approval.

## Store behavior and listing

Only `runFullTrust` is requested for ordinary desktop file editing and explicitly
requested local development-tool workflows. There is no `unvirtualizedResources`,
virtualization exclusion, startup task, service, elevation or file association.
Microsoft VCLibs is declared as a framework dependency when the released PE
imports its DLLs; the Store handles that dependency.

Windows applies its default data virtualization. New app-private data may be
removed on reset/uninstall. Existing data from a direct-download installation may
be reused under Windows' compatibility rules. Save unfinished work to ordinary
document files before reset/uninstall. Do not promise independent data stores or
automatic migration between editions.

English listing text, features, keywords, support links and reviewer notes are in
`../store-listing/<app>/en-US/`. The initial draft is free and public in supported
markets. Ratings must describe the Windows product itself. Ask AI through Codex,
fixed Bash tasks and native WebKit PNG/PDF export are unavailable on Windows in
this version. Optional external tools are not bundled.

Preparing or uploading a draft does not submit it for certification. Review the
final package, screenshots, ratings, restricted-capability explanation and WACK
results before the separate **Submit for certification** action.

Microsoft references: [desktop app behavior](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes),
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).
