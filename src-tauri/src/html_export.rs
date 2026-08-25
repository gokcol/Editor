//! Native HTML, Markdown, and source-preview export support.
//!
//! Yedit renders HTML with the operating system WebKit engine rather than
//! shipping a second browser engine for PNG and PDF export. This module owns
//! the platform-neutral file lifecycle and calls the small Objective-C/WebKit
//! bridge next to it.
//!
//! ## Integration
//!
//! `html_export_bridge.m` must be compiled into the Tauri binary on macOS.
//! Keep that build-time detail outside this module so commands can use a
//! simple, testable Rust API.  See the comment above `macos_bridge` below for
//! the exact `build.rs` addition.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// The output variants that need a native HTML renderer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HtmlExportFormat {
    Html,
    Pdf,
    Png,
}

impl HtmlExportFormat {
    pub fn from_extension(value: &str) -> Result<Self, String> {
        match value
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "html" | "htm" => Ok(Self::Html),
            "pdf" => Ok(Self::Pdf),
            "png" => Ok(Self::Png),
            other => Err(format!(
                "HTML previews support HTML, PNG, and PDF export only (got .{other})."
            )),
        }
    }

    pub const fn extension(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::Pdf => "pdf",
            Self::Png => "png",
        }
    }
}

/// A completed export and its isolated temporary working directory.
///
/// The directory deliberately remains available after return.  The caller
/// needs the output path long enough to copy it into the user's chosen
/// destination, just like every other temporary render directory.
#[derive(Clone, Debug)]
pub struct HtmlExport {
    pub output: PathBuf,
    pub directory: PathBuf,
}

const MAX_PNG_SCALE: f64 = 4.0;
const MIN_PNG_SCALE: f64 = 1.0;
static RENDER_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write a self-contained document and, for raster/PDF output, render it with
/// the operating system's WebKit engine.
///
/// `scale` controls the requested export resolution. It is clamped here so
/// a malformed frontend payload cannot accidentally ask WebKit to allocate a
/// huge bitmap.
pub fn export_html_document(
    html: &str,
    format: HtmlExportFormat,
    scale: f64,
) -> Result<HtmlExport, String> {
    let directory = make_render_directory()?;
    let input = directory.join("document.html");
    let output = directory.join(format!("document.{}", format.extension()));
    fs::write(&input, html).map_err(|error| {
        format!(
            "Could not write the temporary HTML document at {}: {error}",
            input.display()
        )
    })?;

    if format == HtmlExportFormat::Html {
        return Ok(HtmlExport { output, directory });
    }

    let scale = normalize_scale(scale);
    #[cfg(target_os = "macos")]
    macos_bridge::render(&input, &output, format, scale)?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = scale;
        return Err(
            "Native HTML-to-PNG/PDF export is currently implemented for the macOS Yedit app only."
                .to_owned(),
        );
    }

    let metadata = fs::metadata(&output)
        .map_err(|error| format!("WebKit did not produce {}: {error}", format.extension()))?;
    if metadata.len() == 0 {
        return Err(format!(
            "WebKit produced an empty {} export.",
            format.extension()
        ));
    }

    Ok(HtmlExport { output, directory })
}

fn normalize_scale(scale: f64) -> f64 {
    if !scale.is_finite() {
        return MIN_PNG_SCALE;
    }
    scale.clamp(MIN_PNG_SCALE, MAX_PNG_SCALE)
}

fn make_render_directory() -> Result<PathBuf, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create an HTML export timestamp: {error}"))?
        .as_nanos();
    for _ in 0..16 {
        let count = RENDER_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("yedit-html-{}-{now}-{count}", std::process::id()));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create the temporary HTML export directory at {}: {error}",
                    directory.display()
                ));
            }
        }
    }
    Err("Could not allocate a temporary HTML export directory.".to_owned())
}

#[cfg(target_os = "macos")]
mod macos_bridge {
    use super::{HtmlExportFormat, Path};
    use std::{
        ffi::{CStr, CString},
        os::raw::{c_char, c_double, c_int},
        ptr,
    };

    // This is intentionally a tiny C ABI.  The Objective-C implementation is
    // compiled into the signed Yedit binary (not into a runtime helper).
    //
    // Required build.rs addition:
    //
    // cc::Build::new()
    //   .file("src/html_export_bridge.m")
    //   .flag("-fobjc-arc")
    //   .compile("yedit_html_export");
    // println!("cargo:rustc-link-lib=framework=AppKit");
    // println!("cargo:rustc-link-lib=framework=WebKit");
    //
    // Required Cargo.toml build dependency:
    // cc = "1"
    unsafe extern "C" {
        fn yedit_html_export_render(
            input_path: *const c_char,
            output_path: *const c_char,
            output_format: c_int,
            scale: c_double,
            error_message: *mut *mut c_char,
        ) -> bool;
        fn yedit_html_export_free_error(error_message: *mut c_char);
    }

    pub fn render(
        input: &Path,
        output: &Path,
        format: HtmlExportFormat,
        scale: f64,
    ) -> Result<(), String> {
        let input = c_path(input, "input HTML path")?;
        let output = c_path(output, "output path")?;
        let output_format = match format {
            HtmlExportFormat::Pdf => 0,
            HtmlExportFormat::Png => 1,
            HtmlExportFormat::Html => unreachable!("HTML output does not need WebKit rendering"),
        };
        let mut error_message = ptr::null_mut();
        let ok = unsafe {
            yedit_html_export_render(
                input.as_ptr(),
                output.as_ptr(),
                output_format,
                scale,
                &mut error_message,
            )
        };
        if ok {
            return Ok(());
        }

        let error = if error_message.is_null() {
            "Native WebKit could not render the HTML export.".to_owned()
        } else {
            // The bridge always allocates UTF-8 text with `strdup`.
            let message = unsafe { CStr::from_ptr(error_message) }
                .to_string_lossy()
                .into_owned();
            unsafe { yedit_html_export_free_error(error_message) };
            message
        };
        Err(error)
    }

    fn c_path(path: &Path, label: &str) -> Result<CString, String> {
        CString::new(path.to_string_lossy().as_bytes()).map_err(|_| {
            format!("The {label} contains a null byte and cannot be passed to native WebKit.")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_scale, HtmlExportFormat};

    #[test]
    fn recognizes_supported_extensions() {
        assert_eq!(
            HtmlExportFormat::from_extension("PDF").unwrap(),
            HtmlExportFormat::Pdf
        );
        assert_eq!(
            HtmlExportFormat::from_extension(".png").unwrap(),
            HtmlExportFormat::Png
        );
        assert!(HtmlExportFormat::from_extension("svg").is_err());
    }

    #[test]
    fn clamps_export_scale() {
        assert_eq!(normalize_scale(0.1), 1.0);
        assert_eq!(normalize_scale(2.0), 2.0);
        assert_eq!(normalize_scale(99.0), 4.0);
        assert_eq!(normalize_scale(f64::NAN), 1.0);
    }
}
