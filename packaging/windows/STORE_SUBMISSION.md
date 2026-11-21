# 7TXT and Yedit Microsoft Store updates

## Version 1.0.2.0 — 21 November 2026

Version **1.0.2.0** packages prepared **21 November 2026**, using the released
**1.0.2** Windows executables with the update checker. Both previous 1.0.1.0
versions are currently live. Both updates are **In certification**, verified at
**16:16 Europe/Istanbul**. Automatic publication after approval was confirmed in
Partner Center. The 1.0.2.0 updates are not live yet.

| Product | Update submission | Package status |
| --- | --- | --- |
| [7TXT](https://partner.microsoft.com/en-us/dashboard/products/9PB1F4G8F3WH/overview) | 1152921505702468051 | Validated; in certification |
| [Yedit](https://partner.microsoft.com/en-us/dashboard/products/9P3QNM6NK8L4/overview) | 1152921505702468056 | Validated; in certification |

English release notes, reviewer testing instructions, and the existing
`runFullTrust` explanations were saved for both updates. Pricing, availability,
existing screenshots and age ratings were retained.

The new Store release notes describe manual update checks and optional daily
checks, which are off by default. Microsoft Store-signed editions query Store
services; sideloaded/test-signed editions show Store guidance. Neither silently
installs an update or sends documents/file paths. The existing identities,
Windows 11 x64 minimum, system WebView2 runtime, standard virtualization and
sole `runFullTrust` capability are retained.

| Upload | Bytes | SHA-256 |
| --- | ---: | --- |
| 7TXT-1.0.2.0-store-x64.msix | 4,589,308 | `ce94b0ebd4f6788dc492206d1d5df74f39657b6a6f61df8437de2a1953620b04` |
| Yedit-1.0.2.0-store-x64.msix | 9,124,083 | `ab536aa391f03079e758f10115ae4c49292a35979d697ee2c97c3df314703788` |

[Packaging and validation run](https://github.com/gokcol/Editor/actions/runs/44905716376),
commit `cfa94bd95a3f0ae194c42b35ef45b68d63a6684d`. The packet is stored locally at
`release/store-submission-1.0.2/`, with exact packages, hashes, listing sources,
functional reports, WACK XML, and `WACK-reviewed.json`.

Both packages passed semantic/payload validation, independent ZIP CRC and block
hash checks, activation, Unicode editing/saving, recovery after forced restart,
uninstall, preservation of existing direct-edition data, and native detection of
test-signed packages as sideloaded. WACK reports overall PASS for both, retaining
only optional Blocked executables findings for desktop process-launch references.
These are documented for `runFullTrust` review; Microsoft certification is separate.

## Initial 1.0.1.0 submissions

Submitted **15 November 2026**. Partner Center confirmed **In certification** for
both products. Status verified at **12:03 Europe/Istanbul**. Both products
subsequently became available in Microsoft Store; live status was verified in
Partner Center on 21 November 2026.

| Product | Partner Center | Submission | Identity |
| --- | --- | --- | --- |
| 7TXT | [Open submission](https://partner.microsoft.com/en-us/dashboard/products/9PB1F4G8F3WH/overview) | 1152921505702407347 | OrhanGkl.7TXT |
| Yedit | [Open submission](https://partner.microsoft.com/en-us/dashboard/products/9P3QNM6NK8L4/overview) | 1152921505702407895 | OrhanGkl.Yedit |

### Saved in Partner Center

- Free, public and discoverable, all 240 supported markets and future markets.
- Desktop only, Windows 11 x64 minimum build 22000, system Evergreen WebView2.
- 7TXT: Productivity. Yedit: Developer tools / Utilities.
- Privacy, website and support URLs, recommended keyboard and mouse.
- Separate IARC questionnaires completed, with Everyone / 3+ ratings saved.
- Real-identity unsigned MSIX **1.0.1.0**, accepted and **Validated** for each app.
- English (United States) description, release notes, short description, six
  features, seven search terms, developer/copyright information, two Windows
  screenshots and captions per product. The listing import completed successfully.
- Reviewer instructions in Additional Testing Information, and a complete
  `runFullTrust` justification in Submission Options.
- Both submitted for certification, with automatic publication after approval.

The Windows listing accurately excludes the unavailable Codex companion AI,
fixed Bash tasks and native WebKit PNG/PDF export. External development tools are
optional and not bundled. No accessibility certification is claimed.

### Initial upload packages and evidence

The canonical local packet is `release/store-submission/` (ignored by Git).
Its `packages/` contains the exact files uploaded, their hash sidecars and
independent verification results. Its `listings/` contains the imported folders
with Microsoft's exported CSV schema and screenshots. Its `reports/` contains
native functional tests, screenshot provenance and raw WACK XML.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| 7TXT-1.0.1.0-store-x64.msix | 3,553,697 | `12643eeb6c38fcb4a9228c85b7d058b235700949bf2c6cbdc2b9c2cebe5eaa09` |
| Yedit-1.0.1.0-store-x64.msix | 8,122,624 | `4267e7c6ae54580e81ae62ac933ca9603cbf2ee16279654fd78d8d4d20e19669` |

[Successful packaging and verification run](https://github.com/gokcol/Editor/actions/runs/43687274422),
packaging commit `6d1c37d`. The executables are the already released **v1.0.1**
Windows binaries; this task did not rebuild or alter editor behavior. Package
records contain each released executable's exact SHA-256.

Verified: MakeAppx semantics and unpacked payload; real publisher/product
identity; AMD64 architecture; unsigned upload; only `runFullTrust`; every ZIP CRC,
64 KiB block-map hash and whole-file hash; AppModel activation; Unicode opening,
editing and saving; durable recovery after forced restart; uninstall; preservation
of a pre-existing direct-edition data sentinel; unchanged unsigned packages.

Functional tests use separately identified disposable signed copies. No test
certificate, private key or signed test package is in the upload packet.

### Initial certification review record

WACK **10.0.26100.9457** reports **OVERALL_RESULT=PASS**, **PARTIAL_RUN=FALSE**,
with 24 tests per app on the Windows Server 2025 CI host. Both reports retain an
**optional** `Blocked executables` finding for process-launch APIs/executable-name
references in the desktop binaries. This is documented for desktop-capability
review; it is not a Microsoft certification result. Read the raw XML and
`reports/WACK-reviewed.json`, which extracts the actual result text directly.

The original CI `WACK-status.json` serialized XML result nodes incorrectly and
overreported findings. The raw XML is unaffected; the helper's extraction has
been corrected for future runs. The reviewed JSON is the accurate summary.

Microsoft's review of `runFullTrust`, certification and package signing were
pending at the initial submission. Both initial releases are now live. A Windows 11
end-user check remains useful alongside the CI host results, particularly for
installed external-tool workflows.

Standard MSIX virtualization is retained. New private recovery may be removed by
reset/uninstall. Windows may reuse an existing direct-edition data directory;
save unfinished work to ordinary files and do not assume edition data isolation.

Build instructions: [MSIX README](https://github.com/gokcol/Editor/blob/main/packaging/windows/msix/README.md). Editable listing sources:
`store-listing/7TXT/en-US/` and `store-listing/Yedit/en-US/`. The public privacy
policy is [PRIVACY.md](https://github.com/gokcol/Editor/blob/main/PRIVACY.md).
