# 7TXT and Yedit Microsoft Store drafts

Prepared **15 November 2026**. Both products remain **in draft**. Every submission
section is complete and Partner Center enables **Submit for certification**.
That final action has **not** been performed.

| Product | Partner Center | Submission | Identity |
| --- | --- | --- | --- |
| 7TXT | [Open draft](https://partner.microsoft.com/en-us/dashboard/products/9PB1F4G8F3WH/overview) | 1152921505702407347 | OrhanGkl.7TXT |
| Yedit | [Open draft](https://partner.microsoft.com/en-us/dashboard/products/9P3QNM6NK8L4/overview) | 1152921505702407895 | OrhanGkl.Yedit |

## Saved in Partner Center

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
- Default publication after certification; no certification submission yet.

The Windows listing accurately excludes the unavailable Codex companion AI,
fixed Bash tasks and native WebKit PNG/PDF export. External development tools are
optional and not bundled. No accessibility certification is claimed.

## Upload packages and evidence

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

## Certification review still required

WACK **10.0.26100.9457** reports **OVERALL_RESULT=PASS**, **PARTIAL_RUN=FALSE**,
with 24 tests per app on the Windows Server 2025 CI host. Both reports retain an
**optional** `Blocked executables` finding for process-launch APIs/executable-name
references in the desktop binaries. This is documented for desktop-capability
review; it is not a Microsoft certification result. Read the raw XML and
`reports/WACK-reviewed.json`, which extracts the actual result text directly.

The original CI `WACK-status.json` serialized XML result nodes incorrectly and
overreported findings. The raw XML is unaffected; the helper's extraction has
been corrected for future runs. The reviewed JSON is the accurate summary.

Microsoft still needs to approve `runFullTrust`, certify and sign each package.
Review the final listings and capability explanation before using **Submit for
certification**. A Windows 11 end-user check remains useful alongside the CI host
results, particularly for installed external-tool workflows.

Standard MSIX virtualization is retained. New private recovery may be removed by
reset/uninstall. Windows may reuse an existing direct-edition data directory;
save unfinished work to ordinary files and do not assume edition data isolation.

Build instructions: [MSIX README](https://github.com/gokcol/Editor/blob/main/packaging/windows/msix/README.md). Editable listing sources:
`store-listing/7TXT/en-US/` and `store-listing/Yedit/en-US/`. The public privacy
policy is [PRIVACY.md](https://github.com/gokcol/Editor/blob/main/PRIVACY.md).
