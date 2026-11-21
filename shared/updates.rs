//! Release discovery only. No document access, installer download or installation.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};

#[cfg(target_os = "windows")]
#[path = "updates_windows.rs"]
mod windows;

const RELEASES: &str = "https://github.com/gokcol/Editor/releases";
const API: &str = "https://api.github.com/repos/gokcol/Editor/releases?per_page=100";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Product {
    SevenTxt,
    Yedit,
}
impl Product {
    fn from_app(app: &AppHandle) -> Result<Self, String> {
        match app.config().identifier.as_str() {
            "com.gokcol.7txt" => Ok(Self::SevenTxt),
            "com.yedit.desktop" => Ok(Self::Yedit),
            _ => Err("This application has no configured update channel.".into()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::SevenTxt => "7TXT",
            Self::Yedit => "Yedit",
        }
    }
    fn store_id(self) -> &'static str {
        match self {
            Self::SevenTxt => "9PB1F4G8F3WH",
            Self::Yedit => "9P3QNM6NK8L4",
        }
    }
    fn store_url(self) -> String {
        format!("https://apps.microsoft.com/detail/{}", self.store_id())
    }
    #[cfg(target_os = "windows")]
    fn store_identity(self) -> &'static str {
        match self {
            Self::SevenTxt => "OrhanGkl.7TXT",
            Self::Yedit => "OrhanGkl.Yedit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum Channel {
    Github,
    Store,
    Sideloaded,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    app_name: String,
    installed_version: String,
    channel: Channel,
    releases_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Available {
    pub(super) id: String,
    version: Option<String>,
    title: String,
    notes: String,
    pub(super) url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    info: UpdateInfo,
    available: Option<Available>,
}

#[derive(Default)]
pub struct UpdateService {
    running: Arc<AtomicBool>,
    report: Mutex<Option<UpdateReport>>,
}

struct CheckGuard(Arc<AtomicBool>);
impl Drop for CheckGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Version([u32; 3]);
impl Version {
    fn parse(value: &str) -> Option<Self> {
        let parts = value
            .strip_prefix('v')
            .unwrap_or(value)
            .split('.')
            .collect::<Vec<_>>();
        if parts.len() != 3 {
            return None;
        }
        let mut version = [0; 3];
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty()
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return None;
            }
            version[index] = part.parse().ok()?;
        }
        Some(Self(version))
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    state: String,
}

fn filenames(product: Product, version: &str, platform: &str, architecture: &str) -> Vec<String> {
    let app = product.name();
    match (platform, architecture) {
        ("macos", "aarch64") => vec![
            format!("{app}_{version}_universal.dmg"),
            format!("{app}_{version}_aarch64.dmg"),
            format!("{app}_{version}_arm64.dmg"),
        ],
        ("macos", "x86_64") => vec![
            format!("{app}_{version}_universal.dmg"),
            format!("{app}_{version}_x64.dmg"),
            format!("{app}_{version}_x86_64.dmg"),
        ],
        ("windows", "x86_64") => vec![format!("{app}_{version}_x64-setup.exe")],
        ("windows", "aarch64") => vec![
            format!("{app}_{version}_arm64-setup.exe"),
            format!("{app}_{version}_aarch64-setup.exe"),
        ],
        _ => vec![],
    }
}

fn github_report(
    json: &str,
    product: Product,
    installed: &str,
    platform: &str,
    architecture: &str,
) -> Result<Option<Available>, String> {
    let current = Version::parse(installed).ok_or("This build has an unrecognized version.")?;
    let releases: Vec<Release> = serde_json::from_str(json)
        .map_err(|_| "GitHub returned an unreadable release list. Try again later.")?;
    let latest = releases.into_iter().filter(|r| !r.draft && !r.prerelease && r.published_at.is_some()).filter_map(|release| {
        let version = Version::parse(&release.tag_name)?;
        let number = release.tag_name.trim_start_matches('v');
        let asset = filenames(product, number, platform, architecture).into_iter().find_map(|name| {
            let url = format!("{RELEASES}/download/{}/{name}", release.tag_name);
            release.assets.iter().find(|a| a.name == name && a.state == "uploaded" && a.size > 0 && a.browser_download_url == url)
        })?;
        Some((version, Available {
            id: release.tag_name.clone(), version: Some(number.to_owned()), title: format!("{} {} is available", product.name(), number),
            notes: release.body.as_deref().unwrap_or("See the release page for details.").chars().take(12_000).collect(),
            url: asset.browser_download_url.clone(),
        }))
    }).max_by(|a, b| a.0.cmp(&b.0)).ok_or("No published download is available for this app and platform yet. Open the release page to check manually.")?;
    Ok((latest.0 > current).then_some(latest.1))
}

fn github_check(product: Product, installed: &str) -> Result<Option<Available>, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .https_only(true)
            .max_redirects(0)
            .timeout_global(Some(std::time::Duration::from_secs(20)))
            .build(),
    );
    let mut response = match agent
        .get(API)
        .header(
            "User-Agent",
            &format!("{}-update-check/{installed}", product.name()),
        )
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(403 | 429)) => {
            return Err(
                "GitHub is limiting update checks. Try again later or open the release page."
                    .into(),
            )
        }
        Err(_) => return Err("Couldn't reach GitHub. Check your connection and try again.".into()),
    };
    let json = response
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_string()
        .map_err(|_| "Couldn't read the GitHub release list. Try again later.")?;
    github_report(
        &json,
        product,
        installed,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

fn info(app: &AppHandle, product: Product) -> Result<UpdateInfo, String> {
    #[cfg(target_os = "windows")]
    let (channel, installed_version) =
        windows::installation(product, &app.package_info().version.to_string())?;
    #[cfg(not(target_os = "windows"))]
    let (channel, installed_version) = (
        if cfg!(target_os = "macos") {
            Channel::Github
        } else {
            Channel::Unsupported
        },
        app.package_info().version.to_string(),
    );
    Ok(UpdateInfo {
        app_name: product.name().into(),
        installed_version,
        channel,
        releases_url: if matches!(channel, Channel::Store | Channel::Sideloaded) {
            product.store_url()
        } else {
            RELEASES.into()
        },
    })
}

#[tauri::command]
pub async fn updates_info(app: AppHandle) -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || info(&app, Product::from_app(&app)?))
        .await
        .map_err(|_| "Could not read update information.")?
}

#[tauri::command]
pub async fn updates_check(
    app: AppHandle,
    window: WebviewWindow,
    service: State<'_, UpdateService>,
) -> Result<UpdateReport, String> {
    if service
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("An update check is already running.".into());
    }
    let guard = CheckGuard(service.running.clone());
    // Clear an old download action when a new check starts or fails.
    *service
        .report
        .lock()
        .map_err(|_| "Update information is unavailable.")? = None;
    #[cfg(target_os = "windows")]
    let parent = window.hwnd().ok().map(|h| h.0 as isize);
    #[cfg(not(target_os = "windows"))]
    let parent: Option<isize> = {
        let _ = window;
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let product = Product::from_app(&app)?;
        let info = info(&app, product)?;
        let available = match info.channel {
            Channel::Github => github_check(product, &info.installed_version)?,
            #[cfg(target_os = "windows")]
            Channel::Store => windows::check(product, parent)?,
            Channel::Sideloaded => return Err("This package wasn't signed by Microsoft Store. Open the Store to install its supported edition.".into()),
            _ => { let _ = parent; return Err("Update checks are available in the macOS and Windows desktop editions.".into()); }
        };
        let report = UpdateReport { info, available };
        *app.state::<UpdateService>().report.lock().map_err(|_| "Update information is unavailable.")? = Some(report.clone());
        Ok(report)
    }).await.map_err(|_| "The update check stopped. Try again.")?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Destination {
    Releases,
    Download,
}

#[tauri::command]
pub async fn updates_open(app: AppHandle, destination: Destination) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let product = Product::from_app(&app)?;
        let url = match destination {
            Destination::Releases => info(&app, product)?.releases_url,
            Destination::Download => app
                .state::<UpdateService>()
                .report
                .lock()
                .map_err(|_| "Update information is unavailable.")?
                .as_ref()
                .and_then(|r| r.available.as_ref())
                .map(|a| a.url.clone())
                .ok_or("Check for updates before opening a download.")?,
        };
        // Only this backend's fixed channel or previously validated release asset is opened.
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|_| "Could not open the update page in your browser.".to_owned())
    })
    .await
    .map_err(|_| "Could not open the update page.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str, product: Product, platform: &str, arch: &str) -> serde_json::Value {
        let name = filenames(product, tag.trim_start_matches('v'), platform, arch)[0].clone();
        serde_json::json!({"tag_name":tag,"draft":false,"prerelease":false,"published_at":"2026-11-21T00:00:00Z","body":"Release notes", "assets":[{"name":name,"state":"uploaded","size":100,"browser_download_url":format!("{RELEASES}/download/{tag}/{name}")}]})
    }
    fn evaluate(
        releases: &[serde_json::Value],
        product: Product,
        current: &str,
        os: &str,
        arch: &str,
    ) -> Result<Option<Available>, String> {
        github_report(
            &serde_json::to_string(releases).unwrap(),
            product,
            current,
            os,
            arch,
        )
    }
    #[test]
    fn numeric_versions_and_stable_tags() {
        assert!(Version::parse("2.10.0") > Version::parse("v2.9.9"));
        for bad in [
            "1.0",
            "1.0.0-beta",
            "1.0.0/evil",
            "01.0.0",
            "1.0.0+build",
            "999999999999.0.0",
        ] {
            assert!(Version::parse(bad).is_none());
        }
    }
    #[test]
    fn checks_each_app_in_combined_releases_without_downgrades() {
        for product in [Product::SevenTxt, Product::Yedit] {
            let r = release("v1.0.2", product, "macos", "aarch64");
            let current = evaluate(&[r.clone()], product, "1.0.1", "macos", "x86_64")
                .unwrap()
                .unwrap();
            assert_eq!(current.version.as_deref(), Some("1.0.2"));
            assert!(current.url.contains(product.name()));
            assert!(evaluate(&[r.clone()], product, "1.0.2", "macos", "aarch64")
                .unwrap()
                .is_none());
            assert!(evaluate(&[r], product, "1.1.0", "macos", "aarch64")
                .unwrap()
                .is_none());
        }
        let r = release("v2.0.0", Product::Yedit, "windows", "x86_64");
        assert!(evaluate(
            &[r.clone()],
            Product::SevenTxt,
            "1.0.1",
            "windows",
            "x86_64"
        )
        .is_err());
        assert!(evaluate(&[r.clone()], Product::Yedit, "1.0.1", "macos", "aarch64").is_err());
        assert!(evaluate(&[r], Product::Yedit, "1.0.1", "windows", "aarch64").is_err());
    }
    #[test]
    fn skips_unpublished_incompatible_and_untrusted_downloads() {
        let good = release("v1.0.2", Product::SevenTxt, "windows", "x86_64");
        let mut bad = release("v2.0.0", Product::SevenTxt, "windows", "x86_64");
        for (field, value) in [
            ("draft", serde_json::json!(true)),
            ("prerelease", serde_json::json!(true)),
            ("published_at", serde_json::Value::Null),
        ] {
            bad[field] = value;
            assert_eq!(
                evaluate(
                    &[good.clone(), bad.clone()],
                    Product::SevenTxt,
                    "1.0.1",
                    "windows",
                    "x86_64"
                )
                .unwrap()
                .unwrap()
                .version
                .as_deref(),
                Some("1.0.2")
            );
            bad = release("v2.0.0", Product::SevenTxt, "windows", "x86_64");
        }
        for url in [
            "https://evil.example/7TXT.exe",
            "https://github.com/other/Editor/releases/download/v2.0.0/7TXT_2.0.0_x64-setup.exe",
            "https://github.com@gokcol.example/payload.exe",
        ] {
            bad["assets"][0]["browser_download_url"] = url.into();
            assert!(evaluate(
                &[bad.clone()],
                Product::SevenTxt,
                "1.0.1",
                "windows",
                "x86_64"
            )
            .is_err());
        }
        let mut missing = good.clone();
        missing["assets"][0]["size"] = 0.into();
        assert!(evaluate(&[missing], Product::SevenTxt, "1.0.1", "windows", "x86_64").is_err());
        assert!(github_report("not JSON", Product::SevenTxt, "1.0.1", "macos", "aarch64").is_err());
    }
    #[test]
    fn download_order_is_numeric_and_notes_stay_plain_bounded_text() {
        let mut newer = release("v1.10.0", Product::Yedit, "macos", "x86_64");
        newer["body"] = format!("<script>alert(1)</script>{}", "x".repeat(15_000)).into();
        let r = evaluate(
            &[newer, release("v1.9.0", Product::Yedit, "macos", "aarch64")],
            Product::Yedit,
            "1.0.1",
            "macos",
            "aarch64",
        )
        .unwrap()
        .unwrap();
        assert_eq!(r.version.as_deref(), Some("1.10.0"));
        assert!(r.notes.starts_with("<script>"));
        assert_eq!(r.notes.chars().count(), 12_000);
    }
    #[test]
    #[ignore = "Contacts the public GitHub release API; run explicitly with network access"]
    fn live_github_update_checks() {
        for product in [Product::SevenTxt, Product::Yedit] {
            let update = github_check(product, "1.0.0")
                .expect("compatible public release")
                .expect("public release newer than 1.0.0");
            assert!(
                Version::parse(update.version.as_deref().unwrap()).unwrap()
                    > Version::parse("1.0.0").unwrap()
            );
            assert!(update.url.starts_with(RELEASES));
            assert!(update.url.contains(product.name()));
        }
    }
}
