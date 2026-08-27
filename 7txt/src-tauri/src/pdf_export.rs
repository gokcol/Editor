//! Clean A4-width PDF export for 7TXT documents.
//!
//! The native printing panel is deliberately not involved: it can add user
//! configured headers and footers. Instead, macOS WebKit prints the rendered
//! HTML into a chosen PDF file using an A4-width document layout.

use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static RENDER_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn export_pdf_document(html: &str, output: &Path) -> Result<(), String> {
    let directory = make_render_directory()?;
    let input = directory.join("document.html");
    let result = (|| {
        fs::write(&input, html).map_err(|error| {
            format!("Could not prepare the temporary document for PDF export: {error}")
        })?;

        #[cfg(target_os = "macos")]
        macos_bridge::render(&input, output)?;

        #[cfg(not(target_os = "macos"))]
        return Err("Clean PDF export is currently available in the macOS 7TXT app.".to_owned());

        let metadata = fs::metadata(output)
            .map_err(|error| format!("macOS did not produce the PDF: {error}"))?;
        if metadata.len() == 0 {
            return Err("macOS produced an empty PDF.".to_owned());
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&directory);
    result
}

fn make_render_directory() -> Result<std::path::PathBuf, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Could not create a PDF export timestamp: {error}"))?
        .as_nanos();
    for _ in 0..16 {
        let count = RENDER_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "7txt-pdf-{}-{now}-{count}",
            std::process::id()
        ));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create a PDF export directory: {error}")),
        }
    }
    Err("Could not allocate a temporary PDF export directory.".to_owned())
}

#[cfg(target_os = "macos")]
mod macos_bridge {
    use std::{
        ffi::{CStr, CString},
        os::raw::c_char,
        path::Path,
        ptr,
    };

    unsafe extern "C" {
        fn seventxt_pdf_export_render(
            input_path: *const c_char,
            output_path: *const c_char,
            error_message: *mut *mut c_char,
        ) -> bool;
        fn seventxt_pdf_export_free_error(error_message: *mut c_char);
    }

    pub fn render(input: &Path, output: &Path) -> Result<(), String> {
        let input = c_path(input, "input HTML path")?;
        let output = c_path(output, "output PDF path")?;
        let mut error_message = ptr::null_mut();
        let ok = unsafe {
            seventxt_pdf_export_render(input.as_ptr(), output.as_ptr(), &mut error_message)
        };
        if ok {
            return Ok(());
        }
        let message = if error_message.is_null() {
            "macOS could not export the document as PDF.".to_owned()
        } else {
            let message = unsafe { CStr::from_ptr(error_message) }
                .to_string_lossy()
                .into_owned();
            unsafe { seventxt_pdf_export_free_error(error_message) };
            message
        };
        Err(message)
    }

    fn c_path(path: &Path, label: &str) -> Result<CString, String> {
        CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| format!("The {label} contains a null byte."))
    }
}

#[cfg(test)]
mod tests {
    use super::make_render_directory;

    #[test]
    fn allocates_an_isolated_temporary_directory() {
        let directory = make_render_directory().expect("temporary export directory");
        assert!(directory.is_dir());
        let _ = std::fs::remove_dir_all(directory);
    }

}
