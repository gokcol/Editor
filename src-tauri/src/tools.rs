//! Native, local-only tool integrations used by Yedit's Tauri shell.
//!
//! This module intentionally does not expose an arbitrary shell or filesystem
//! process API to the webview.  Every process name below is allow-listed, all
//! arguments are supplied as argv (never a shell string), project paths are
//! checked before use, and compilers/runners have both time and output limits.
//!
//! `Cargo.toml` needs the following dependencies when this module is wired into
//! the Tauri application:
//!
//! ```toml
//! arboard = "3"
//! base64 = "0.22"
//! image = { version = "0.25", default-features = false, features = ["png", "jpeg", "gif", "webp"] }
//! rfd = "0.16"
//! uuid = { version = "1", features = ["v4"] }
//! ```

use crate::html_export::{export_html_document, HtmlExportFormat};

use std::{
    borrow::Cow,
    ffi::OsStr,
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rfd::FileDialog;
use serde_json::{json, Value};
use uuid::Uuid;

const DEFAULT_TOOL_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TOOL_OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const METAFONT_PROOF_TIMEOUT_MS: u64 = 45_000;
const METAFONT_CONVERSION_TIMEOUT_MS: u64 = 120_000;
const MAX_METAFONT_PROOF_SVG_BYTES: u64 = 6 * 1024 * 1024;
const DEFAULT_PYTHON_RUN_TIMEOUT_MS: u64 = 15_000;
const MIN_PYTHON_RUN_TIMEOUT_MS: u64 = 1_000;
const MAX_PYTHON_RUN_TIMEOUT_MS: u64 = 30_000;
const MAX_PYTHON_RUN_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_PYTHON_SOURCE_BYTES: usize = 2 * 1024 * 1024;
const PYTHON_DISCOVERY_TIMEOUT_MS: u64 = 4_000;
const MAX_ERROR_TEXT_CHARS: usize = 12_000;
const PROJECT_TASK_TIMEOUT_MS: u64 = 30 * 60 * 1_000;
const PROJECT_TASK_OUTPUT_LIMIT_BYTES: usize = 24 * 1024 * 1024;
const MAX_PROJECT_TASK_PDF_DATA_URI_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROJECT_TASK_ARTIFACT_SCAN_ENTRIES: usize = 12_000;
const MAX_PROJECT_TASK_ARTIFACT_DEPTH: usize = 12;
const PROJECT_TASK_CONFIG_NAME: &str = "yedit.tasks.json";
const MAX_DECLARED_PROJECT_TASKS: usize = 20;
const MAX_DECLARED_TASK_ARGUMENTS: usize = 32;
const MAX_DECLARED_TASK_CONFIG_BYTES: u64 = 256 * 1024;

static PYTHON_COMMAND: OnceLock<String> = OnceLock::new();

/// The webview may only ask this backend to launch a known local development
/// tool.  New entries should be accompanied by a focused command function;
/// never turn this into a renderer-controlled command runner.
const ALLOWED_COMMANDS: &[&str] = &[
    "pdflatex",
    "xelatex",
    "lualatex",
    "latex",
    "dvisvgm",
    "mf-nowin",
    "gftodvi",
    "mf2pt1",
    "fontforge",
    "rsvg-convert",
    "pdftocairo",
    "python3",
    "python",
    "node",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "deno",
    "pytest",
    "uv",
    "poetry",
    "pipenv",
    "cargo",
    "make",
    "just",
    "go",
    "java",
    "ruff",
    "prettier",
    "eslint",
    "sqlfluff",
    "fprettify",
    "gfortran",
    "latexmk",
    "typst",
    "git",
    "open",
];

#[derive(Debug, Default)]
struct CapturedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    total_bytes: usize,
    output_limited: bool,
}

#[derive(Debug)]
struct ToolOutput {
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct ToolError {
    message: String,
    stdout: String,
    stderr: String,
    not_found: bool,
    timed_out: bool,
    output_limited: bool,
    exit_code: Option<i32>,
}

impl ToolError {
    fn spawn(command: &str, error: io::Error) -> Self {
        let not_found = error.kind() == io::ErrorKind::NotFound;
        Self {
            message: if not_found {
                format!("{command} is unavailable.")
            } else {
                format!("Could not start {command}: {error}")
            },
            stdout: String::new(),
            stderr: String::new(),
            not_found,
            timed_out: false,
            output_limited: false,
            exit_code: None,
        }
    }

    fn combined(&self) -> String {
        join_error_parts([
            self.stderr.as_str(),
            self.stdout.as_str(),
            self.message.as_str(),
        ])
    }
}

#[derive(Clone, Copy)]
struct BuildProfile {
    id: &'static str,
    label: &'static str,
    source_types: &'static [&'static str],
    output_extension: &'static str,
    compiler: &'static str,
    engine: Option<&'static str>,
}

/// A project task is deliberately a fixed, root-level script name.  This is
/// not a generic command runner: the renderer can select a stable id only,
/// and the native host independently checks the mapped script before running
/// `/bin/bash` with that one argv value.
#[derive(Clone, Copy, Debug)]
struct ProjectTask {
    id: &'static str,
    label: &'static str,
    script_name: &'static str,
    kind: &'static str,
}

/// A project-declared task is still constrained to an allow-listed executable
/// and argv array. It deliberately has no shell string, environment, or
/// arbitrary executable path, even though its definition lives in a project.
#[derive(Clone, Debug)]
struct DeclaredProjectTask {
    id: String,
    label: String,
    kind: String,
    command: String,
    arguments: Vec<String>,
    working_directory: PathBuf,
}

#[derive(Clone, Debug)]
enum WorkspaceProjectTask {
    Script(ProjectTask),
    Declared(DeclaredProjectTask),
}

const PROJECT_TASKS: &[ProjectTask] = &[
    ProjectTask {
        id: "build",
        label: "Build project",
        script_name: "build.sh",
        kind: "build",
    },
    ProjectTask {
        id: "build-preview",
        label: "Build preview",
        script_name: "build-preview.sh",
        kind: "preview",
    },
];

#[derive(Debug)]
struct ProjectPdfArtifact {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

const BUILD_PROFILES: &[BuildProfile] = &[
    BuildProfile {
        id: "tikz-pdf",
        label: "Compile TikZ to PDF (pdfLaTeX)",
        source_types: &["tikz"],
        output_extension: "pdf",
        compiler: "pdflatex",
        engine: Some("pdflatex"),
    },
    BuildProfile {
        id: "tikz-xelatex-pdf",
        label: "Compile TikZ to PDF (XeLaTeX)",
        source_types: &["tikz"],
        output_extension: "pdf",
        compiler: "xelatex",
        engine: Some("xelatex"),
    },
    BuildProfile {
        id: "tikz-lualatex-pdf",
        label: "Compile TikZ to PDF (LuaLaTeX)",
        source_types: &["tikz"],
        output_extension: "pdf",
        compiler: "lualatex",
        engine: Some("lualatex"),
    },
    BuildProfile {
        id: "latex-pdf",
        label: "Compile LaTeX to PDF (pdfLaTeX)",
        source_types: &["latex"],
        output_extension: "pdf",
        compiler: "pdflatex",
        engine: Some("pdflatex"),
    },
    BuildProfile {
        id: "latex-xelatex-pdf",
        label: "Compile LaTeX to PDF (XeLaTeX)",
        source_types: &["latex"],
        output_extension: "pdf",
        compiler: "xelatex",
        engine: Some("xelatex"),
    },
    BuildProfile {
        id: "latex-lualatex-pdf",
        label: "Compile LaTeX to PDF (LuaLaTeX)",
        source_types: &["latex"],
        output_extension: "pdf",
        compiler: "lualatex",
        engine: Some("lualatex"),
    },
    BuildProfile {
        id: "latex-dvi",
        label: "Compile LaTeX to DVI",
        source_types: &["latex"],
        output_extension: "dvi",
        compiler: "latex",
        engine: Some("latex"),
    },
    BuildProfile {
        id: "metafont-ttf",
        label: "Convert MetaFont to TTF",
        source_types: &["metafont"],
        output_extension: "ttf",
        compiler: "mf2pt1 + fontforge",
        engine: None,
    },
];

struct TexArtifact {
    directory: PathBuf,
    output_path: PathBuf,
    base_name: String,
    engine: String,
}

struct MetafontTtfArtifact {
    directory: PathBuf,
    ttf_path: PathBuf,
}

fn tool_path() -> String {
    let mut paths = Vec::new();
    if let Some(current) = std::env::var_os("PATH") {
        let current = current.to_string_lossy();
        if !current.trim().is_empty() {
            paths.push(current.into_owned());
        }
    }
    for path in [
        "/Library/TeX/texbin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
    ] {
        if !paths.iter().any(|known| known == path) {
            paths.push(path.to_owned());
        }
    }
    paths.join(":")
}

fn yedit_temp_root() -> Result<PathBuf, String> {
    let root = std::env::temp_dir().join("yedit");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create Yedit's temporary folder: {error}"))?;
    Ok(root)
}

fn make_temp_directory(prefix: &str) -> Result<PathBuf, String> {
    let root = yedit_temp_root()?;
    let safe_prefix = safe_file_stem(prefix, "render");
    for _ in 0..4 {
        let candidate = root.join(format!("{safe_prefix}-{}", Uuid::new_v4()));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "Could not create a temporary render folder: {error}"
                ))
            }
        }
    }
    Err("Could not allocate a temporary render folder.".to_owned())
}

fn remove_temp_directory(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn safe_name(value: &str, fallback: &str) -> String {
    let mut output = String::new();
    let mut previous_space = false;
    for character in value.chars() {
        let replacement = if matches!(
            character,
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        ) {
            '-'
        } else {
            character
        };
        if replacement.is_whitespace() {
            if !output.is_empty() && !previous_space {
                output.push(' ');
            }
            previous_space = true;
        } else {
            output.push(replacement);
            previous_space = false;
        }
        if output.chars().count() >= 80 {
            break;
        }
    }
    let cleaned = output.trim().to_owned();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn safe_file_stem(value: &str, fallback: &str) -> String {
    let filename = Path::new(value)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(value);
    let raw_stem = Path::new(filename)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(filename);
    let cleaned = raw_stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(72)
        .collect::<String>();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn compiler_base_name(value: &str, fallback: &str) -> String {
    safe_file_stem(value, fallback)
}

fn metafont_base_name(value: &str) -> String {
    safe_file_stem(value, "font").chars().take(48).collect()
}

fn is_allowed_command(command: &str) -> bool {
    ALLOWED_COMMANDS.contains(&command)
}

fn spawn_reader<R: Read + Send + 'static>(
    mut stream: R,
    stdout: bool,
    captured: Arc<Mutex<CapturedOutput>>,
    maximum_bytes: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            let read = match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let mut state = match captured.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            let remaining = maximum_bytes.saturating_sub(state.total_bytes);
            let preserved = remaining.min(read);
            if preserved > 0 {
                if stdout {
                    state.stdout.extend_from_slice(&buffer[..preserved]);
                } else {
                    state.stderr.extend_from_slice(&buffer[..preserved]);
                }
            }
            state.total_bytes = state.total_bytes.saturating_add(read);
            if state.total_bytes > maximum_bytes {
                state.output_limited = true;
            }
        }
    })
}

fn captured_strings(captured: &Arc<Mutex<CapturedOutput>>) -> (String, String, bool) {
    match captured.lock() {
        Ok(state) => (
            String::from_utf8_lossy(&state.stdout).into_owned(),
            String::from_utf8_lossy(&state.stderr).into_owned(),
            state.output_limited,
        ),
        Err(_) => (String::new(), String::new(), false),
    }
}

fn terminate(child: &mut Child) {
    // `Child::kill` is a direct process signal, not a shell command.  It is
    // intentionally best-effort because a compiler may have exited between
    // the timeout check and this call.
    let _ = child.kill();
}

fn run_command(
    command: &str,
    arguments: &[String],
    working_directory: &Path,
    environment: &[(String, String)],
    clear_environment: bool,
    timeout_ms: u64,
    maximum_output_bytes: usize,
) -> Result<ToolOutput, ToolError> {
    if !is_allowed_command(command) {
        return Err(ToolError {
            message: "That local tool is not enabled by Yedit.".to_owned(),
            stdout: String::new(),
            stderr: String::new(),
            not_found: false,
            timed_out: false,
            output_limited: false,
            exit_code: None,
        });
    }

    let mut process = Command::new(command);
    process
        .args(arguments)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if clear_environment {
        process.env_clear();
    }
    process.env("PATH", tool_path());
    for (name, value) in environment {
        process.env(name, value);
    }

    let mut child = process
        .spawn()
        .map_err(|error| ToolError::spawn(command, error))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let captured = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_reader = spawn_reader(stdout, true, Arc::clone(&captured), maximum_output_bytes);
    let stderr_reader = spawn_reader(stderr, false, Arc::clone(&captured), maximum_output_bytes);
    let started_at = Instant::now();
    let mut termination = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                let (_, _, output_limited) = captured_strings(&captured);
                if output_limited {
                    termination = Some("output limit");
                    terminate(&mut child);
                    break child.wait();
                }
                if started_at.elapsed() >= Duration::from_millis(timeout_ms) {
                    termination = Some("timeout");
                    terminate(&mut child);
                    break child.wait();
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                terminate(&mut child);
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    let (stdout, stderr, output_limited) = captured_strings(&captured);

    let status = status.map_err(|error| ToolError {
        message: format!("Could not wait for {command}: {error}"),
        stdout: stdout.clone(),
        stderr: stderr.clone(),
        not_found: false,
        timed_out: false,
        output_limited,
        exit_code: None,
    })?;

    if termination == Some("timeout") {
        return Err(ToolError {
            message: format!(
                "{command} timed out after {} seconds.",
                timeout_ms.div_ceil(1_000)
            ),
            stdout,
            stderr,
            not_found: false,
            timed_out: true,
            output_limited: false,
            exit_code: status.code(),
        });
    }
    if termination == Some("output limit") || output_limited {
        return Err(ToolError {
            message: format!(
                "{command} produced more than {} MB of output and was stopped.",
                maximum_output_bytes / (1024 * 1024)
            ),
            stdout,
            stderr,
            not_found: false,
            timed_out: false,
            output_limited: true,
            exit_code: status.code(),
        });
    }
    if status.success() {
        return Ok(ToolOutput { stdout, stderr });
    }
    let status_text = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "an unknown status".to_owned());
    Err(ToolError {
        message: format!("{command} exited with {status_text}."),
        stdout,
        stderr,
        not_found: false,
        timed_out: false,
        output_limited: false,
        exit_code: status.code(),
    })
}

/// Runs one of Yedit's pre-discovered root task scripts.  It intentionally
/// has no command/path parameters from the renderer: its caller supplies a
/// canonical file already verified as one of `PROJECT_TASKS`.
fn run_project_task_script(script: &Path, workspace: &Path) -> Result<ToolOutput, ToolError> {
    const BASH: &str = "/bin/bash";

    let mut process = Command::new(BASH);
    process
        .arg(script)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PATH", tool_path())
        // Do not let an inherited non-interactive shell bootstrap turn this
        // fixed script runner into an implicit second script input.
        .env_remove("BASH_ENV")
        .env_remove("ENV");

    // The timeout/output guard must stop the script's process tree, not only
    // the shell that launched it.  Giving bash its own process group makes a
    // negative-PID kill precise and prevents a compiler it started from
    // continuing after Yedit has reported a timeout.
    #[cfg(unix)]
    unsafe {
        process.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = process
        .spawn()
        .map_err(|error| ToolError::spawn("the selected project task", error))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let captured = Arc::new(Mutex::new(CapturedOutput::default()));
    let stdout_reader = spawn_reader(
        stdout,
        true,
        Arc::clone(&captured),
        PROJECT_TASK_OUTPUT_LIMIT_BYTES,
    );
    let stderr_reader = spawn_reader(
        stderr,
        false,
        Arc::clone(&captured),
        PROJECT_TASK_OUTPUT_LIMIT_BYTES,
    );
    let started_at = Instant::now();
    let mut termination = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {
                let (_, _, output_limited) = captured_strings(&captured);
                if output_limited {
                    termination = Some("output limit");
                    terminate_project_task(&mut child);
                    break child.wait();
                }
                if started_at.elapsed() >= Duration::from_millis(PROJECT_TASK_TIMEOUT_MS) {
                    termination = Some("timeout");
                    terminate_project_task(&mut child);
                    break child.wait();
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                terminate_project_task(&mut child);
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    let (stdout, stderr, output_limited) = captured_strings(&captured);

    let status = status.map_err(|error| ToolError {
        message: format!("Could not wait for the selected project task: {error}"),
        stdout: stdout.clone(),
        stderr: stderr.clone(),
        not_found: false,
        timed_out: false,
        output_limited,
        exit_code: None,
    })?;

    if termination == Some("timeout") {
        return Err(ToolError {
            message: "The project task timed out after 30 minutes.".to_owned(),
            stdout,
            stderr,
            not_found: false,
            timed_out: true,
            output_limited: false,
            exit_code: status.code(),
        });
    }
    if termination == Some("output limit") || output_limited {
        return Err(ToolError {
            message: "The project task produced more than 24 MB of output and was stopped."
                .to_owned(),
            stdout,
            stderr,
            not_found: false,
            timed_out: false,
            output_limited: true,
            exit_code: status.code(),
        });
    }
    if status.success() {
        return Ok(ToolOutput { stdout, stderr });
    }
    let status_text = status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "an unknown status".to_owned());
    Err(ToolError {
        message: format!("The project task exited with {status_text}."),
        stdout,
        stderr,
        not_found: false,
        timed_out: false,
        output_limited: false,
        exit_code: status.code(),
    })
}

fn terminate_project_task(child: &mut Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // See the `setpgid` call above.  This intentionally targets only
            // the dedicated group created for this fixed task invocation.
            unsafe {
                let _ = libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    terminate(child);
}

fn join_error_parts<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let combined = parts
        .into_iter()
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    tail_chars(&combined, MAX_ERROR_TEXT_CHARS)
}

fn tail_chars(value: &str, maximum_chars: usize) -> String {
    let character_count = value.chars().count();
    if character_count <= maximum_chars {
        return value.to_owned();
    }
    value
        .chars()
        .skip(character_count.saturating_sub(maximum_chars))
        .collect()
}

fn read_text_tail(path: &Path, maximum_bytes: u64) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let length = size.min(maximum_bytes);
    file.seek(SeekFrom::Start(size.saturating_sub(length)))?;
    let mut data = Vec::with_capacity(length as usize);
    file.read_to_end(&mut data)?;
    Ok(String::from_utf8_lossy(&data).into_owned())
}

fn compiler_label(command: &str) -> &str {
    match command {
        "pdflatex" => "pdfLaTeX",
        "xelatex" => "XeLaTeX",
        "lualatex" => "LuaLaTeX",
        _ => command,
    }
}

fn missing_compiler_message(error: &ToolError, compiler: &str) -> Option<String> {
    error.not_found.then(|| {
        format!(
            "{} is unavailable. Install a TeX distribution that provides {compiler}, then restart Yedit.",
            compiler_label(compiler)
        )
    })
}

fn compiler_error_message(
    directory: &Path,
    base_name: &str,
    error: &ToolError,
    compiler: &str,
) -> String {
    let log =
        read_text_tail(&directory.join(format!("{base_name}.log")), 128 * 1024).unwrap_or_default();
    let missing = missing_compiler_message(error, compiler).unwrap_or_default();
    join_error_parts([
        missing.as_str(),
        error.stderr.as_str(),
        error.stdout.as_str(),
        log.as_str(),
        error.message.as_str(),
    ])
}

fn tex_environment(compiler: &str) -> Result<Vec<(String, String)>, String> {
    if compiler != "lualatex" {
        return Ok(Vec::new());
    }
    let cache = yedit_temp_root()?.join("texmf-var");
    fs::create_dir_all(&cache)
        .map_err(|error| format!("Could not prepare the LuaLaTeX cache: {error}"))?;
    let cache = cache.to_string_lossy().into_owned();
    Ok(vec![
        ("TEXMFVAR".to_owned(), cache.clone()),
        ("TEXMFCACHE".to_owned(), cache),
    ])
}

fn run_tex_compiler(
    compiler: &str,
    arguments: &[String],
    working_directory: &Path,
) -> Result<ToolOutput, ToolError> {
    let environment = tex_environment(compiler).map_err(|message| ToolError {
        message,
        stdout: String::new(),
        stderr: String::new(),
        not_found: false,
        timed_out: false,
        output_limited: false,
        exit_code: None,
    })?;
    run_command(
        compiler,
        arguments,
        working_directory,
        &environment,
        false,
        DEFAULT_TOOL_TIMEOUT_MS,
        DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
    )
}

fn resolve_latex_engine(
    mode: &str,
    requested_engine: Option<&str>,
) -> Result<(&'static str, &'static str), String> {
    let requested = requested_engine
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    if mode == "dvi" {
        if requested
            .as_deref()
            .is_some_and(|engine| engine != "pdflatex")
        {
            return Err("DVI output always uses the classic latex engine. Select PDF to use XeLaTeX or LuaLaTeX.".to_owned());
        }
        return Ok(("latex", "latex"));
    }
    match requested.as_deref().unwrap_or("pdflatex") {
        "pdflatex" => Ok(("pdflatex", "pdflatex")),
        "xelatex" => Ok(("xelatex", "xelatex")),
        "lualatex" => Ok(("lualatex", "lualatex")),
        _ => Err("Choose pdfLaTeX, XeLaTeX, or LuaLaTeX for TeX PDF output.".to_owned()),
    }
}

fn compile_latex_to_temp(
    source: &str,
    suggested_name: &str,
    mode: &str,
    requested_engine: Option<&str>,
) -> Result<TexArtifact, String> {
    let (compiler, engine) = resolve_latex_engine(mode, requested_engine)?;
    let directory = make_temp_directory("latex")?;
    let base_name = compiler_base_name(suggested_name, "document");
    let tex_path = directory.join(format!("{base_name}.tex"));
    let output_path = directory.join(format!("{base_name}.{mode}"));
    if let Err(error) = fs::write(&tex_path, source) {
        remove_temp_directory(&directory);
        return Err(format!(
            "Could not write the temporary LaTeX source: {error}"
        ));
    }
    let arguments = vec![
        "-interaction=nonstopmode".to_owned(),
        "-halt-on-error".to_owned(),
        "-no-shell-escape".to_owned(),
        "-file-line-error".to_owned(),
        format!("-output-directory={}", directory.display()),
        tex_path.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_tex_compiler(compiler, &arguments, &directory) {
        let message = compiler_error_message(&directory, &base_name, &error, compiler);
        remove_temp_directory(&directory);
        return Err(message);
    }
    if let Err(error) = fs::metadata(&output_path) {
        remove_temp_directory(&directory);
        return Err(format!(
            "{compiler} finished without producing the expected {mode} file: {error}"
        ));
    }
    Ok(TexArtifact {
        directory,
        output_path,
        base_name,
        engine: engine.to_owned(),
    })
}

fn compile_tikz_to_temp(
    source: &str,
    suggested_name: &str,
    requested_engine: Option<&str>,
) -> Result<TexArtifact, String> {
    let (compiler, engine) = resolve_latex_engine("pdf", requested_engine)?;
    let directory = make_temp_directory("tikz")?;
    let base_name = compiler_base_name(suggested_name, "diagram");
    let tex_path = directory.join(format!("{base_name}.tex"));
    let output_path = directory.join(format!("{base_name}.pdf"));
    if let Err(error) = fs::write(&tex_path, source) {
        remove_temp_directory(&directory);
        return Err(format!(
            "Could not write the temporary TikZ source: {error}"
        ));
    }
    let arguments = vec![
        "-interaction=nonstopmode".to_owned(),
        "-halt-on-error".to_owned(),
        "-no-shell-escape".to_owned(),
        "-file-line-error".to_owned(),
        format!("-output-directory={}", directory.display()),
        tex_path.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_tex_compiler(compiler, &arguments, &directory) {
        let message = compiler_error_message(&directory, &base_name, &error, compiler);
        remove_temp_directory(&directory);
        return Err(message);
    }
    if let Err(error) = fs::metadata(&output_path) {
        remove_temp_directory(&directory);
        return Err(format!(
            "{compiler} finished without producing the expected PDF: {error}"
        ));
    }
    Ok(TexArtifact {
        directory,
        output_path,
        base_name,
        engine: engine.to_owned(),
    })
}

fn metafont_environment(directory: &Path) -> Vec<(String, String)> {
    let local_path = format!("{}:", directory.display());
    ["MFINPUTS", "TFMFONTS", "GFFONTS", "PKFONTS", "TEXFONTS"]
        .into_iter()
        .map(|name| (name.to_owned(), local_path.clone()))
        .collect()
}

fn metafont_gf_path(directory: &Path, base_name: &str) -> Result<PathBuf, String> {
    let prefix = format!("{base_name}.");
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect MetaFont output: {error}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(suffix) = name.strip_prefix(&prefix) {
            if let Some(resolution) = suffix.strip_suffix("gf") {
                if !resolution.is_empty()
                    && resolution
                        .bytes()
                        .all(|character| character.is_ascii_digit())
                {
                    return Ok(entry.path());
                }
            }
        }
    }
    Err("MetaFont finished without producing a GF font. Add at least one beginchar definition before rendering a glyph proof.".to_owned())
}

fn missing_metafont_tool_message(error: &ToolError, command: &str) -> Option<&'static str> {
    if !error.not_found {
        return None;
    }
    match command {
        "fontforge" => Some("TTF export needs FontForge. Install the FontForge command-line tool (for example, `brew install fontforge`) and restart Yedit."),
        "mf2pt1" => Some("TTF export needs mf2pt1, which is included with a full TeX Live or MacTeX installation."),
        "mf-nowin" => Some("MetaFont preview needs the headless `mf-nowin` command from TeX Live or MacTeX."),
        "gftodvi" | "dvisvgm" => Some("MetaFont preview needs gftodvi and dvisvgm from a full TeX Live or MacTeX installation."),
        _ => Some("A required MetaFont tool is unavailable."),
    }
}

fn metafont_error_message(
    directory: &Path,
    base_name: &str,
    error: &ToolError,
    command: &str,
) -> String {
    let log =
        read_text_tail(&directory.join(format!("{base_name}.log")), 128 * 1024).unwrap_or_default();
    let missing = missing_metafont_tool_message(error, command).unwrap_or_default();
    join_error_parts([
        missing,
        error.stderr.as_str(),
        error.stdout.as_str(),
        log.as_str(),
        error.message.as_str(),
    ])
}

fn render_metafont_sync(source: &str, suggested_name: &str) -> Value {
    let directory = match make_temp_directory("metafont") {
        Ok(directory) => directory,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let base_name = metafont_base_name(suggested_name);
    let source_path = directory.join(format!("{base_name}.mf"));
    let environment = metafont_environment(&directory);
    let mut active_tool = "mf-nowin";
    let result = (|| -> Result<String, String> {
        fs::write(&source_path, source)
            .map_err(|error| format!("Could not write the temporary MetaFont source: {error}"))?;
        let input = format!("\\mode:=localfont; nonstopmode; input {base_name}");
        run_command(
            "mf-nowin",
            &[input],
            &directory,
            &environment,
            false,
            METAFONT_PROOF_TIMEOUT_MS,
            DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        )
        .map_err(|error| metafont_error_message(&directory, &base_name, &error, active_tool))?;
        let gf_path = metafont_gf_path(&directory, &base_name)?;
        let gray_input = "\\mode:=localfont; nonstopmode; input gray".to_owned();
        run_command(
            "mf-nowin",
            &[gray_input],
            &directory,
            &environment,
            false,
            METAFONT_PROOF_TIMEOUT_MS,
            DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        )
        .map_err(|error| metafont_error_message(&directory, &base_name, &error, active_tool))?;
        active_tool = "gftodvi";
        run_command(
            "gftodvi",
            &[gf_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()],
            &directory,
            &environment,
            false,
            METAFONT_PROOF_TIMEOUT_MS,
            DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        )
        .map_err(|error| metafont_error_message(&directory, &base_name, &error, active_tool))?;
        let dvi_path = directory.join(format!("{base_name}.dvi"));
        fs::metadata(&dvi_path)
            .map_err(|error| format!("MetaFont proof DVI was not created: {error}"))?;
        active_tool = "dvisvgm";
        let svg_path = directory.join(format!("{base_name}.svg"));
        run_command(
            "dvisvgm",
            &[
                "--page=1".to_owned(),
                "--no-fonts".to_owned(),
                format!("--output={}", svg_path.display()),
                dvi_path.to_string_lossy().into_owned(),
            ],
            &directory,
            &environment,
            false,
            METAFONT_PROOF_TIMEOUT_MS,
            DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        )
        .map_err(|error| metafont_error_message(&directory, &base_name, &error, active_tool))?;
        let size = fs::metadata(&svg_path)
            .map_err(|error| format!("Could not read the MetaFont proof SVG: {error}"))?
            .len();
        if size > MAX_METAFONT_PROOF_SVG_BYTES {
            return Err(format!(
                "The generated MetaFont proof is {:.1} MB. Reduce its complexity before previewing it.",
                size as f64 / (1024.0 * 1024.0)
            ));
        }
        fs::read_to_string(&svg_path)
            .map_err(|error| format!("Could not read the MetaFont proof SVG: {error}"))
    })();
    remove_temp_directory(&directory);
    match result {
        Ok(svg) => json!({ "ok": true, "svg": svg }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn convert_metafont_to_ttf(
    source: &str,
    suggested_name: &str,
) -> Result<MetafontTtfArtifact, String> {
    let directory = make_temp_directory("metafont-ttf")?;
    let base_name = metafont_base_name(suggested_name);
    let source_path = directory.join(format!("{base_name}.mf"));
    let pfb_path = directory.join(format!("{base_name}.pfb"));
    let ttf_path = directory.join(format!("{base_name}.ttf"));
    let postscript_name = format!(
        "{}-Regular",
        base_name
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .if_empty_then("FoundryFont")
    );
    let family_name = safe_name(&base_name.replace(['-', '_'], " "), "Foundry Font");
    if let Err(error) = fs::write(&source_path, source) {
        remove_temp_directory(&directory);
        return Err(format!(
            "Could not write the temporary MetaFont source: {error}"
        ));
    }
    let environment = metafont_environment(&directory);
    let mf2pt1_args = vec![
        format!("--output-dir={}", directory.display()),
        format!("--name={postscript_name}"),
        format!("--family={family_name}"),
        format!("--fullname={family_name} Regular"),
        "--encoding=standard".to_owned(),
        source_path.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_command(
        "mf2pt1",
        &mf2pt1_args,
        &directory,
        &environment,
        false,
        METAFONT_CONVERSION_TIMEOUT_MS,
        DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
    ) {
        let message = metafont_error_message(&directory, &base_name, &error, "mf2pt1");
        remove_temp_directory(&directory);
        return Err(message);
    }
    if let Err(error) = fs::metadata(&pfb_path) {
        remove_temp_directory(&directory);
        return Err(format!(
            "mf2pt1 finished without producing a Type 1 font: {error}"
        ));
    }
    let fontforge_args = vec![
        "-lang=ff".to_owned(),
        "-c".to_owned(),
        "Open($1); Generate($2);".to_owned(),
        pfb_path.to_string_lossy().into_owned(),
        ttf_path.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_command(
        "fontforge",
        &fontforge_args,
        &directory,
        &[],
        false,
        METAFONT_CONVERSION_TIMEOUT_MS,
        DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
    ) {
        let message = metafont_error_message(&directory, &base_name, &error, "fontforge");
        remove_temp_directory(&directory);
        return Err(message);
    }
    if let Err(error) = fs::metadata(&ttf_path) {
        remove_temp_directory(&directory);
        return Err(format!(
            "FontForge finished without producing a TTF font: {error}"
        ));
    }
    Ok(MetafontTtfArtifact {
        directory,
        ttf_path,
    })
}

/// A small extension trait keeps the FontForge postscript name fallback easy
/// to read without pulling another utility crate into the native shell.
trait EmptyFallback {
    fn if_empty_then(self, fallback: &str) -> String;
}

impl EmptyFallback for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

fn convert_svg(svg: &str, format: &str, scale: u32) -> Result<(PathBuf, PathBuf), String> {
    if !matches!(format, "svg" | "png" | "pdf") {
        return Err("SVG previews support SVG, PNG, and PDF export only.".to_owned());
    }
    let directory = make_temp_directory("svg")?;
    let input = directory.join("diagram.svg");
    let output = directory.join(format!("diagram.{format}"));
    if let Err(error) = fs::write(&input, svg) {
        remove_temp_directory(&directory);
        return Err(format!("Could not write the temporary SVG: {error}"));
    }
    if format == "svg" {
        return Ok((directory, output));
    }
    let mut arguments = vec!["-f".to_owned(), format.to_owned()];
    if format == "png" && scale > 1 {
        arguments.push("-z".to_owned());
        arguments.push(scale.to_string());
    }
    arguments.push("-o".to_owned());
    arguments.push(output.to_string_lossy().into_owned());
    arguments.push(input.to_string_lossy().into_owned());
    if let Err(error) = run_command(
        "rsvg-convert",
        &arguments,
        &directory,
        &[],
        false,
        DEFAULT_TOOL_TIMEOUT_MS,
        DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
    ) {
        let message = if error.not_found {
            "SVG image export needs rsvg-convert. Install librsvg (for example, `brew install librsvg`) and restart Yedit.".to_owned()
        } else {
            error.combined()
        };
        remove_temp_directory(&directory);
        return Err(message);
    }
    Ok((directory, output))
}

fn convert_html(html: &str, format: &str, scale: u32) -> Result<(PathBuf, PathBuf), String> {
    let format = HtmlExportFormat::from_extension(format)?;
    let artifact = export_html_document(html, format, scale as f64)?;
    Ok((artifact.directory, artifact.output))
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn source_text_preview_html(source: &str, label: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>{}</title><style>body{{margin:0;padding:32px;background:#111622;color:#d9e3f8;font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}}h1{{margin:0 0 18px;font:700 18px/1.2 system-ui,sans-serif}}pre{{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}}</style></head><body><h1>{}</h1><pre>{}</pre></body></html>",
        escape_html_text(label),
        escape_html_text(label),
        escape_html_text(source),
    )
}

fn export_destination(format: &str, suggested_name: &str) -> Option<PathBuf> {
    let extension = format;
    let file_name = format!("{}.{}", safe_name(suggested_name, "diagram"), extension);
    let title = format!("Export {}", format.to_ascii_uppercase());
    let filter = format!("{} file", format.to_ascii_uppercase());
    FileDialog::new()
        .set_title(title)
        .set_file_name(&file_name)
        .add_filter(filter, &[extension])
        .save_file()
}

fn parse_scale(payload: &Value) -> u32 {
    match payload.get("scale").and_then(Value::as_u64) {
        Some(1 | 2 | 4) => payload.get("scale").and_then(Value::as_u64).unwrap_or(1) as u32,
        _ => 1,
    }
}

fn export_payload_sync(payload: Value) -> Value {
    let source_type = match payload.get("sourceType").and_then(Value::as_str) {
        Some(source_type) => source_type,
        None => return json!({ "ok": false, "error": "Choose a source type before exporting." }),
    };
    let source = payload
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let svg = payload.get("svg").and_then(Value::as_str);
    let html = payload.get("html").and_then(Value::as_str);
    let format = match payload.get("format").and_then(Value::as_str) {
        Some(format @ ("png" | "pdf" | "dvi" | "svg" | "html" | "ttf")) => format,
        _ => return json!({ "ok": false, "error": "Choose a supported export format." }),
    };
    let suggested_name = payload
        .get("suggestedName")
        .and_then(Value::as_str)
        .unwrap_or("diagram");
    let requested_engine = payload
        .get("engine")
        .or_else(|| payload.get("texEngine"))
        .and_then(Value::as_str);
    let scale = parse_scale(&payload);
    let mut temporary_directories = Vec::<PathBuf>::new();

    let generated = (|| -> Result<PathBuf, String> {
        match source_type {
            "tikz" | "latex" => {
                if !matches!(format, "png" | "svg" | "pdf" | "dvi") {
                    return Err("LaTeX and TikZ source files support PNG, SVG, and PDF export; LaTeX also supports DVI.".to_owned());
                }
                if format == "dvi" && source_type != "latex" {
                    return Err("DVI export is available for LaTeX source files.".to_owned());
                }
                let artifact = if source_type == "latex" {
                    compile_latex_to_temp(
                        source,
                        &format!("{suggested_name}.tex"),
                        if format == "dvi" { "dvi" } else { "pdf" },
                        requested_engine,
                    )?
                } else {
                    compile_tikz_to_temp(
                        source,
                        &format!("{suggested_name}.tikz"),
                        requested_engine,
                    )?
                };
                let directory = artifact.directory.clone();
                let pdf_or_dvi = artifact.output_path.clone();
                temporary_directories.push(directory.clone());
                if format == "dvi" || format == "pdf" {
                    return Ok(pdf_or_dvi);
                }
                let output = directory.join(format!("diagram.{format}"));
                let arguments = if format == "png" {
                    vec![
                        "-png".to_owned(),
                        "-singlefile".to_owned(),
                        "-r".to_owned(),
                        (144_u32.saturating_mul(scale)).to_string(),
                        pdf_or_dvi.to_string_lossy().into_owned(),
                        directory.join("diagram").to_string_lossy().into_owned(),
                    ]
                } else {
                    vec![
                        "-svg".to_owned(),
                        pdf_or_dvi.to_string_lossy().into_owned(),
                        output.to_string_lossy().into_owned(),
                    ]
                };
                run_command(
                    "pdftocairo",
                    &arguments,
                    &directory,
                    &[],
                    false,
                    DEFAULT_TOOL_TIMEOUT_MS,
                    DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
                )
                .map_err(|error| {
                    if error.not_found {
                        "PDF image export needs pdftocairo. Install Poppler (for example, `brew install poppler`) and restart Yedit.".to_owned()
                    } else {
                        error.combined()
                    }
                })?;
                Ok(output)
            }
            "metafont" => {
                if !matches!(format, "png" | "svg" | "pdf" | "ttf") {
                    return Err("MetaFont source files support GF-proof PNG, SVG, and PDF exports, plus TTF outline conversion.".to_owned());
                }
                if format == "ttf" {
                    let conversion =
                        convert_metafont_to_ttf(source, &format!("{suggested_name}.mf"))?;
                    let path = conversion.ttf_path.clone();
                    temporary_directories.push(conversion.directory);
                    return Ok(path);
                }
                let proof = render_metafont_sync(source, &format!("{suggested_name}.mf"));
                let proof_svg = proof.get("svg").and_then(Value::as_str).ok_or_else(|| {
                    proof
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("MetaFont proof generation failed.")
                        .to_owned()
                })?;
                let (directory, output) = convert_svg(proof_svg, format, scale)?;
                temporary_directories.push(directory);
                Ok(output)
            }
            "markdown" | "text" | "yaml" | "json" | "javascript" | "typescript" | "python"
            | "php" | "fortran" | "sql" | "html" | "css" | "c" | "cpp" | "pascal" | "go"
            | "ruby" | "bash" | "csh" | "powershell" | "batch" | "vbscript" | "swift"
            | "objectivec" | "kotlin" => {
                let document =
                    html.unwrap_or_else(|| if source_type == "html" { source } else { "" });
                let fallback;
                let document = if document.is_empty() {
                    fallback = source_text_preview_html(source, source_type);
                    fallback.as_str()
                } else {
                    document
                };
                let (directory, output) = convert_html(document, format, scale)?;
                temporary_directories.push(directory);
                Ok(output)
            }
            _ => {
                let rendered_svg = svg.unwrap_or(source);
                let (directory, output) = convert_svg(rendered_svg, format, scale)?;
                temporary_directories.push(directory);
                Ok(output)
            }
        }
    })();

    let response = match generated {
        Ok(generated) => match export_destination(format, suggested_name) {
            None => json!({ "ok": true, "canceled": true }),
            Some(destination) => match fs::copy(&generated, &destination) {
                Ok(_) => json!({ "ok": true, "path": destination }),
                Err(error) => {
                    json!({ "ok": false, "error": format!("Could not save the export: {error}") })
                }
            },
        },
        Err(error) => json!({ "ok": false, "error": error }),
    };
    for directory in temporary_directories {
        remove_temp_directory(&directory);
    }
    response
}

fn path_is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn canonical_workspace(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("Choose a project folder first.".to_owned());
    }
    let path = Path::new(root);
    let metadata =
        fs::metadata(path).map_err(|_| "The selected project folder is unavailable.".to_owned())?;
    if !metadata.is_dir() {
        return Err("The selected project folder is unavailable.".to_owned());
    }
    fs::canonicalize(path)
        .map_err(|error| format!("Could not resolve the selected project folder: {error}"))
}

fn checked_relative_path(relative_path: &str, label: &str) -> Result<PathBuf, String> {
    if relative_path.trim().is_empty() {
        return Err(format!("Choose a {label} inside the current project."));
    }
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("That file is outside the current project.".to_owned());
    }
    if path
        .components()
        .all(|component| matches!(component, Component::CurDir))
    {
        return Err("The project folder itself cannot be changed here.".to_owned());
    }
    Ok(path.to_path_buf())
}

fn resolve_regular_project_file(
    root: &Path,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let relative = checked_relative_path(relative_path, "file")?;
    let lexical = root.join(&relative);
    let metadata = fs::symlink_metadata(&lexical)
        .map_err(|_| "That project file is unavailable.".to_owned())?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("Only regular project files can be changed here.".to_owned());
    }
    let real =
        fs::canonicalize(&lexical).map_err(|_| "That project file is unavailable.".to_owned())?;
    if !path_is_inside(root, &real) {
        return Err("That file resolves outside the current project.".to_owned());
    }
    Ok((real, relative))
}

fn fixed_project_task_value(task: ProjectTask) -> Value {
    json!({
        "id": task.id,
        "label": task.label,
        "scriptName": task.script_name,
        "relativePath": task.script_name,
        "kind": task.kind,
    })
}

fn declared_task_id_is_valid(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && value.len() <= 48
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
}

fn declared_task_kind(value: Option<&str>) -> String {
    match value.unwrap_or("run") {
        "build" | "preview" | "test" | "run" | "lint" | "format" => {
            value.unwrap_or("run").to_owned()
        }
        _ => "run".to_owned(),
    }
}

fn declared_task_working_directory(root: &Path, value: Option<&str>) -> Option<PathBuf> {
    let relative = value.unwrap_or(".").trim();
    if relative.is_empty() || relative == "." {
        return Some(root.to_path_buf());
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let lexical = root.join(path);
    let metadata = fs::symlink_metadata(&lexical).ok()?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let real = fs::canonicalize(&lexical).ok()?;
    path_is_inside(root, &real).then_some(real)
}

fn declared_project_tasks(root: &Path) -> Vec<DeclaredProjectTask> {
    let config_path = root.join(PROJECT_TASK_CONFIG_NAME);
    let metadata = match fs::symlink_metadata(&config_path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            metadata
        }
        _ => return Vec::new(),
    };
    if metadata.len() > MAX_DECLARED_TASK_CONFIG_BYTES {
        return Vec::new();
    }
    let real = match fs::canonicalize(&config_path) {
        Ok(real) if path_is_inside(root, &real) && real.parent() == Some(root) => real,
        _ => return Vec::new(),
    };
    let source = match fs::read_to_string(real) {
        Ok(source) => source,
        Err(_) => return Vec::new(),
    };
    let tasks = match serde_json::from_str::<Value>(&source)
        .ok()
        .and_then(|value| value.get("tasks").and_then(Value::as_array).cloned())
    {
        Some(tasks) => tasks,
        None => return Vec::new(),
    };

    let mut known_ids = std::collections::HashSet::new();
    tasks
        .into_iter()
        .take(MAX_DECLARED_PROJECT_TASKS)
        .filter_map(|value| {
            let object = value.as_object()?;
            let id = object.get("id")?.as_str()?.trim();
            if !declared_task_id_is_valid(id)
                || matches!(id, "build" | "build-preview")
                || !known_ids.insert(id.to_owned())
            {
                return None;
            }
            let command = object.get("command")?.as_str()?.trim();
            if !is_allowed_command(command) {
                return None;
            }
            let arguments = object
                .get("args")
                .and_then(Value::as_array)
                .map(|values| values.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
                .unwrap_or(Some(Vec::new()))?;
            if arguments.len() > MAX_DECLARED_TASK_ARGUMENTS
                || arguments
                    .iter()
                    .any(|argument| argument.len() > 512 || argument.contains('\0'))
            {
                return None;
            }
            let working_directory =
                declared_task_working_directory(root, object.get("cwd").and_then(Value::as_str))?;
            let label = object
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|label| !label.is_empty() && label.chars().count() <= 72)
                .unwrap_or(id)
                .to_owned();
            Some(DeclaredProjectTask {
                id: format!("task:{id}"),
                label,
                kind: declared_task_kind(object.get("kind").and_then(Value::as_str)),
                command: command.to_owned(),
                arguments: arguments.into_iter().map(str::to_owned).collect(),
                working_directory,
            })
        })
        .collect()
}

/// Resolves a task script only when it is one of the two fixed project-root
/// filenames and is currently a regular, non-symlink file.  `root` has
/// already been canonicalized by `canonical_workspace`.
fn resolve_project_task_script(root: &Path, task: ProjectTask) -> Option<PathBuf> {
    let lexical = root.join(task.script_name);
    let metadata = fs::symlink_metadata(&lexical).ok()?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let real = fs::canonicalize(&lexical).ok()?;
    if !path_is_inside(root, &real)
        || real.parent() != Some(root)
        || real.file_name() != Some(OsStr::new(task.script_name))
    {
        return None;
    }
    let real_metadata = fs::symlink_metadata(&real).ok()?;
    if !real_metadata.file_type().is_file() || real_metadata.file_type().is_symlink() {
        return None;
    }
    Some(real)
}

fn workspace_project_task_value(task: &WorkspaceProjectTask) -> Value {
    match task {
        WorkspaceProjectTask::Script(task) => fixed_project_task_value(*task),
        WorkspaceProjectTask::Declared(task) => json!({
            "id": task.id,
            "label": task.label,
            "kind": task.kind,
            "command": if task.arguments.is_empty() { task.command.clone() } else { format!("{} {}", task.command, task.arguments.join(" ")) },
            "relativePath": PROJECT_TASK_CONFIG_NAME,
        }),
    }
}

fn project_tasks_for_workspace(root: &Path) -> Vec<WorkspaceProjectTask> {
    let mut tasks = PROJECT_TASKS
        .iter()
        .copied()
        .filter(|task| resolve_project_task_script(root, *task).is_some())
        .map(WorkspaceProjectTask::Script)
        .collect::<Vec<_>>();
    tasks.extend(
        declared_project_tasks(root)
            .into_iter()
            .map(WorkspaceProjectTask::Declared),
    );
    tasks
}

fn project_task_by_id(root: &Path, task_id: &str) -> Option<WorkspaceProjectTask> {
    project_tasks_for_workspace(root)
        .into_iter()
        .find(|task| match task {
            WorkspaceProjectTask::Script(task) => task.id == task_id,
            WorkspaceProjectTask::Declared(task) => task.id == task_id,
        })
}

/// Artifact folders are intentionally constant rather than supplied by the
/// renderer or parsed out of the script.  The preview folder wins for both
/// task kinds because a book project may deliberately publish a checked
/// preview there last.
const PROJECT_TASK_PDF_DIRECTORIES: &[&[&str]] = &[&["build", "preview"], &["build"], &["dist"]];

fn canonical_project_task_artifact_directory(root: &Path, segments: &[&str]) -> Option<PathBuf> {
    let mut lexical = root.to_path_buf();
    for segment in segments {
        lexical.push(segment);
        let metadata = fs::symlink_metadata(&lexical).ok()?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
    }
    let real = fs::canonicalize(&lexical).ok()?;
    path_is_inside(root, &real).then_some(real)
}

fn latest_pdf_in_directory(root: &Path, directory: &Path) -> Option<ProjectPdfArtifact> {
    let mut latest = None;
    let mut pending = vec![(directory.to_path_buf(), 0_usize)];
    let mut seen_entries = 0_usize;

    while let Some((current, depth)) = pending.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            seen_entries = seen_entries.saturating_add(1);
            if seen_entries > MAX_PROJECT_TASK_ARTIFACT_SCAN_ENTRIES {
                return latest;
            }
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if depth < MAX_PROJECT_TASK_ARTIFACT_DEPTH {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file()
                || !path
                    .extension()
                    .and_then(OsStr::to_str)
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
            {
                continue;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata)
                    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
                {
                    metadata
                }
                _ => continue,
            };
            let real = match fs::canonicalize(&path) {
                Ok(real) if path_is_inside(root, &real) && path_is_inside(directory, &real) => real,
                _ => continue,
            };
            let candidate = ProjectPdfArtifact {
                path: real,
                size: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            };
            if latest
                .as_ref()
                .is_none_or(|known: &ProjectPdfArtifact| candidate.modified > known.modified)
            {
                latest = Some(candidate);
            }
        }
    }
    latest
}

fn latest_project_task_pdf(root: &Path) -> Option<ProjectPdfArtifact> {
    for segments in PROJECT_TASK_PDF_DIRECTORIES {
        let Some(directory) = canonical_project_task_artifact_directory(root, segments) else {
            continue;
        };
        if let Some(artifact) = latest_pdf_in_directory(root, &directory) {
            return Some(artifact);
        }
    }
    None
}

fn read_file_up_to(path: &Path, maximum_bytes: u64) -> io::Result<Option<Vec<u8>>> {
    let file = fs::File::open(path)?;
    let mut reader = file.take(maximum_bytes.saturating_add(1));
    let mut data = Vec::new();
    reader.read_to_end(&mut data)?;
    if data.len() as u64 > maximum_bytes {
        return Ok(None);
    }
    Ok(Some(data))
}

fn project_task_pdf_value(root: &Path, artifact: Option<ProjectPdfArtifact>) -> Value {
    let Some(artifact) = artifact else {
        return Value::Null;
    };
    let relative_path = artifact
        .path
        .strip_prefix(root)
        .map(relative_display_path)
        .unwrap_or_else(|_| artifact.path.to_string_lossy().into_owned());
    let (data_uri, omitted) = if artifact.size > MAX_PROJECT_TASK_PDF_DATA_URI_BYTES {
        (None, true)
    } else {
        match read_file_up_to(&artifact.path, MAX_PROJECT_TASK_PDF_DATA_URI_BYTES) {
            Ok(Some(data)) => (
                Some(format!(
                    "data:application/pdf;base64,{}",
                    BASE64.encode(data)
                )),
                false,
            ),
            Ok(None) | Err(_) => (None, true),
        }
    };
    json!({
        "path": artifact.path.to_string_lossy(),
        "relativePath": relative_path,
        "name": artifact.path.file_name().and_then(OsStr::to_str).unwrap_or("output.pdf"),
        "size": artifact.size,
        "dataUri": data_uri,
        "dataUriOmitted": omitted,
    })
}

fn join_task_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_owned(),
        (true, false) => stderr.to_owned(),
        (false, false) if stdout.ends_with('\n') => format!("{stdout}{stderr}"),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn run_project_task_sync(root: String, task_id: String) -> Result<Value, String> {
    let workspace = canonical_workspace(&root)?;
    let task = project_task_by_id(&workspace, &task_id)
        .ok_or_else(|| "That project task is unavailable.".to_owned())?;
    let started_at = Instant::now();
    let result = match &task {
        WorkspaceProjectTask::Script(task) => {
            let script = resolve_project_task_script(&workspace, *task).ok_or_else(|| {
                format!(
                    "{} is not available as a regular project-root script.",
                    task.script_name
                )
            })?;
            run_project_task_script(&script, &workspace)
        }
        WorkspaceProjectTask::Declared(task) => run_command(
            &task.command,
            &task.arguments,
            &task.working_directory,
            &[],
            false,
            PROJECT_TASK_TIMEOUT_MS,
            PROJECT_TASK_OUTPUT_LIMIT_BYTES,
        ),
    };
    let duration_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let artifact = project_task_pdf_value(&workspace, latest_project_task_pdf(&workspace));
    let task_value = workspace_project_task_value(&task);

    match result {
        Ok(output) => Ok(json!({
            "ok": true,
            "task": task_value,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "output": join_task_output(&output.stdout, &output.stderr),
            "exitCode": 0,
            "durationMs": duration_ms,
            "artifact": artifact,
        })),
        Err(error) => {
            let output = join_task_output(&error.stdout, &error.stderr);
            let mut response = json!({
                "ok": false,
                "task": task_value,
                "stdout": error.stdout,
                "stderr": error.stderr,
                "output": output,
                "durationMs": duration_ms,
                "artifact": artifact,
                "timedOut": error.timed_out,
                "outputLimited": error.output_limited,
            });
            if let Some(exit_code) = error.exit_code {
                response["exitCode"] = json!(exit_code);
            }
            if !error.message.is_empty() {
                response["error"] = Value::String(error.message);
            }
            Ok(response)
        }
    }
}

fn is_supported_source_path(path: &Path) -> bool {
    crate::models::source_kind_for_path(path) != "text"
        || path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
}

fn source_type_for_path(path: &Path) -> &'static str {
    crate::models::source_kind_for_path(path)
}

fn relative_display_path(relative_path: &Path) -> String {
    relative_path.to_string_lossy().replace('\\', "/")
}

fn run_build_profile_sync(
    root: String,
    relative_path: String,
    profile_id: String,
) -> Result<Value, String> {
    let workspace = canonical_workspace(&root)?;
    let profile = BUILD_PROFILES
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "That build profile is unavailable.".to_owned())?;
    let (source_path, source_relative_path) =
        resolve_regular_project_file(&workspace, &relative_path)?;
    let source_type = source_type_for_path(&source_path);
    if !is_supported_source_path(&source_path) || !profile.source_types.contains(&source_type) {
        return Err(format!(
            "This build profile only supports {} source files.",
            profile.source_types.join(" or ")
        ));
    }
    let file_name = source_path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The source filename is invalid.".to_owned())?;
    if file_name.starts_with('-') {
        return Err("Source filenames beginning with `-` cannot be compiled by Yedit.".to_owned());
    }
    let source_directory = source_path
        .parent()
        .ok_or_else(|| "The source file has no containing directory.".to_owned())?;
    let source_parent = source_relative_path
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let output_directory = workspace.join(".yedit-build").join(source_parent);
    fs::create_dir_all(&output_directory)
        .map_err(|error| format!("Could not create the build output folder: {error}"))?;
    let real_output_directory = fs::canonicalize(&output_directory)
        .map_err(|error| format!("Could not resolve the build output folder: {error}"))?;
    if !path_is_inside(&workspace, &real_output_directory) {
        return Err("The build output folder resolves outside the current project.".to_owned());
    }
    let base_name = source_path
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The source filename is invalid.".to_owned())?;
    let output_path =
        real_output_directory.join(format!("{base_name}.{}", profile.output_extension));

    if profile.id == "metafont-ttf" {
        let source = fs::read_to_string(&source_path)
            .map_err(|error| format!("Could not read MetaFont source: {error}"))?;
        match convert_metafont_to_ttf(&source, file_name) {
            Ok(conversion) => {
                let copy_result = fs::copy(&conversion.ttf_path, &output_path).map_err(|error| {
                    format!("Could not copy the generated TTF into the project: {error}")
                });
                remove_temp_directory(&conversion.directory);
                copy_result?;
                return Ok(json!({
                    "ok": true,
                    "profile": profile.id,
                    "outputPath": output_path,
                    "outputRelativePath": relative_display_path(output_path.strip_prefix(&workspace).unwrap_or(&output_path)),
                }));
            }
            Err(error) => return Ok(json!({ "ok": false, "profile": profile.id, "error": error })),
        }
    }

    let arguments = vec![
        "-interaction=nonstopmode".to_owned(),
        "-halt-on-error".to_owned(),
        "-no-shell-escape".to_owned(),
        "-file-line-error".to_owned(),
        format!("-output-directory={}", real_output_directory.display()),
        file_name.to_owned(),
    ];
    match run_tex_compiler(profile.compiler, &arguments, source_directory) {
        Ok(_) => {
            if !output_path.is_file() {
                return Ok(json!({
                    "ok": false,
                    "profile": profile.id,
                    "error": format!("{} finished without producing {}.", profile.compiler, output_path.display()),
                }));
            }
            Ok(json!({
                "ok": true,
                "profile": profile.id,
                "outputPath": output_path,
                "outputRelativePath": relative_display_path(output_path.strip_prefix(&workspace).unwrap_or(&output_path)),
            }))
        }
        Err(error) => {
            let log = read_text_tail(
                &real_output_directory.join(format!("{base_name}.log")),
                128 * 1024,
            )
            .unwrap_or_default();
            let missing = missing_compiler_message(&error, profile.compiler).unwrap_or_default();
            Ok(json!({
                "ok": false,
                "profile": profile.id,
                "error": join_error_parts([missing.as_str(), error.stderr.as_str(), error.stdout.as_str(), log.as_str(), error.message.as_str()]),
            }))
        }
    }
}

fn python_scratch_filename(suggested_name: &str) -> String {
    let raw = Path::new(suggested_name)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("script.py")
        .strip_suffix(".py")
        .or_else(|| {
            Path::new(suggested_name)
                .file_name()
                .and_then(OsStr::to_str)
                .and_then(|name| name.strip_suffix(".pyw"))
        })
        .unwrap_or_else(|| {
            Path::new(suggested_name)
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("script")
        });
    let mut stem = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(72)
        .collect::<String>();
    if stem.is_empty() {
        stem = "script".to_owned();
    }
    if !stem
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
    {
        stem = format!("script_{stem}");
    }
    format!("{stem}.py")
}

fn python_options(options: Option<&Value>) -> Result<(String, u64), String> {
    let mode = options
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("run")
        .to_ascii_lowercase();
    if !matches!(mode.as_str(), "run" | "test") {
        return Err("Choose Run or Test for Python source.".to_owned());
    }
    let requested = options
        .and_then(|value| value.get("timeoutMs"))
        .and_then(Value::as_f64)
        .map(|value| value.round() as i64);
    let timeout = requested
        .map(|value| {
            value.clamp(
                MIN_PYTHON_RUN_TIMEOUT_MS as i64,
                MAX_PYTHON_RUN_TIMEOUT_MS as i64,
            ) as u64
        })
        .unwrap_or(DEFAULT_PYTHON_RUN_TIMEOUT_MS);
    Ok((mode, timeout))
}

fn discover_python(working_directory: &Path) -> Result<String, String> {
    if let Some(command) = PYTHON_COMMAND.get() {
        return Ok(command.clone());
    }
    for command in ["python3", "python"] {
        let result = run_command(
            command,
            &["--version".to_owned()],
            working_directory,
            &[
                ("PYTHONNOUSERSITE".to_owned(), "1".to_owned()),
                ("PYTHONDONTWRITEBYTECODE".to_owned(), "1".to_owned()),
            ],
            false,
            PYTHON_DISCOVERY_TIMEOUT_MS,
            8 * 1024,
        );
        if let Ok(output) = result {
            let version = format!("{}\n{}", output.stdout, output.stderr);
            if version.trim_start().starts_with("Python 3") {
                let command = command.to_owned();
                let _ = PYTHON_COMMAND.set(command.clone());
                return Ok(command);
            }
        }
    }
    Err("Python 3 is unavailable. Install Python 3 so `python3` or `python` is on PATH, then restart Yedit.".to_owned())
}

fn python_environment(temp_directory: &Path, project_root: Option<&Path>) -> Vec<(String, String)> {
    let locale = std::env::var("LC_CTYPE")
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_else(|_| "en_US.UTF-8".to_owned());
    let temp = temp_directory.to_string_lossy().into_owned();
    let mut environment = vec![
        ("PATH".to_owned(), tool_path()),
        ("HOME".to_owned(), temp.clone()),
        ("TMPDIR".to_owned(), temp.clone()),
        ("TMP".to_owned(), temp.clone()),
        ("TEMP".to_owned(), temp),
        ("LANG".to_owned(), locale.clone()),
        ("LC_CTYPE".to_owned(), locale),
        ("PYTHONNOUSERSITE".to_owned(), "1".to_owned()),
        ("PYTHONDONTWRITEBYTECODE".to_owned(), "1".to_owned()),
        ("PYTHONUNBUFFERED".to_owned(), "1".to_owned()),
        ("PYTHONSAFEPATH".to_owned(), "1".to_owned()),
        ("PIP_NO_INPUT".to_owned(), "1".to_owned()),
        ("PIP_DISABLE_PIP_VERSION_CHECK".to_owned(), "1".to_owned()),
        ("PIP_NO_INDEX".to_owned(), "1".to_owned()),
    ];
    if let Some(root) = project_root {
        environment.push(("PYTHONPATH".to_owned(), root.to_string_lossy().into_owned()));
    }
    environment
}

fn run_python_sync(source: String, suggested_name: String, options: Option<Value>) -> Value {
    if source.len() > MAX_PYTHON_SOURCE_BYTES {
        return json!({
            "ok": false,
            "output": "",
            "error": format!("Python source is limited to {} MB per run.", MAX_PYTHON_SOURCE_BYTES / (1024 * 1024)),
        });
    }
    let (mode, timeout) = match python_options(options.as_ref()) {
        Ok(options) => options,
        Err(error) => return json!({ "ok": false, "output": "", "error": error }),
    };
    let directory = match make_temp_directory("python-run") {
        Ok(directory) => directory,
        Err(error) => return json!({ "ok": false, "output": "", "error": error }),
    };
    let result = (|| -> Result<Value, String> {
        let mut project_root = None;
        let mut saved_source_path = None;
        if let Some(options) = options.as_ref() {
            if let Some(root) = options
                .get("projectRoot")
                .and_then(Value::as_str)
                .filter(|root| !root.trim().is_empty())
            {
                let workspace = canonical_workspace(root)?;
                if let Some(relative_path) = options
                    .get("relativePath")
                    .and_then(Value::as_str)
                    .filter(|path| !path.trim().is_empty())
                {
                    let (path, _) = resolve_regular_project_file(&workspace, relative_path)?;
                    if source_type_for_path(&path) != "python" {
                        return Err("The selected project file is not Python source.".to_owned());
                    }
                    saved_source_path = Some(path);
                }
                project_root = Some(workspace);
            }
        }
        let command = discover_python(&directory)?;
        let scratch_name = python_scratch_filename(&suggested_name);
        let source_path = match saved_source_path {
            Some(path) if fs::read_to_string(&path).ok().as_deref() == Some(source.as_str()) => {
                path
            }
            _ => {
                let path = directory.join(&scratch_name);
                fs::write(&path, &source)
                    .map_err(|error| format!("Could not write the Python scratch file: {error}"))?;
                path
            }
        };
        let source_parent = source_path.parent().unwrap_or(&directory);
        let source_filename = source_path
            .file_name()
            .unwrap_or_else(|| OsStr::new("script.py"))
            .to_string_lossy()
            .into_owned();
        let arguments = if mode == "test" {
            vec![
                "-u".to_owned(),
                "-B".to_owned(),
                "-s".to_owned(),
                "-m".to_owned(),
                "unittest".to_owned(),
                "discover".to_owned(),
                "-s".to_owned(),
                source_parent.to_string_lossy().into_owned(),
                "-p".to_owned(),
                source_filename.clone(),
            ]
        } else {
            vec![
                "-u".to_owned(),
                "-B".to_owned(),
                "-s".to_owned(),
                source_path.to_string_lossy().into_owned(),
            ]
        };
        let display_command = if mode == "test" {
            format!(
                "{} -u -B -s -m unittest discover -p {source_filename}",
                command
            )
        } else {
            format!("{} -u -B -s {source_filename}", command)
        };
        let working_directory = project_root.as_deref().unwrap_or(&directory);
        match run_command(
            &command,
            &arguments,
            working_directory,
            &python_environment(&directory, project_root.as_deref()),
            true,
            timeout,
            MAX_PYTHON_RUN_OUTPUT_BYTES,
        ) {
            Ok(output) => Ok(json!({
                "ok": true,
                "output": output.stdout,
                "stderr": output.stderr,
                "exitCode": 0,
                "command": display_command,
            })),
            Err(error) => {
                let message = if error.not_found {
                    "Python 3 is unavailable. Install Python 3 so `python3` or `python` is on PATH, then restart Yedit.".to_owned()
                } else if error.timed_out {
                    format!("Python stopped after {} seconds.", timeout.div_ceil(1_000))
                } else if error.output_limited {
                    format!(
                        "Python produced more than {} MB of output and was stopped.",
                        MAX_PYTHON_RUN_OUTPUT_BYTES / (1024 * 1024)
                    )
                } else if error.stderr.trim().is_empty() {
                    error.message.clone()
                } else {
                    String::new()
                };
                let mut response = json!({
                    "ok": false,
                    "output": error.stdout,
                    "stderr": error.stderr,
                    "command": display_command,
                });
                if let Some(exit_code) = error.exit_code {
                    response["exitCode"] = json!(exit_code);
                }
                if !message.is_empty() {
                    response["error"] = Value::String(message);
                }
                Ok(response)
            }
        }
    })();
    remove_temp_directory(&directory);
    match result {
        Ok(value) => value,
        Err(error) => json!({ "ok": false, "output": "", "error": error }),
    }
}

fn git_error_message(error: &ToolError) -> String {
    if error.not_found {
        return "Git is not installed or is unavailable on PATH.".to_owned();
    }
    let output = error.combined();
    if output.to_ascii_lowercase().contains("not a git repository") {
        "This folder is not inside a Git repository.".to_owned()
    } else if output.is_empty() {
        "Git could not inspect this project.".to_owned()
    } else {
        output
    }
}

fn run_git(root: &Path, arguments: &[String]) -> Result<ToolOutput, ToolError> {
    let mut full_arguments = vec![
        "--no-pager".to_owned(),
        "-C".to_owned(),
        root.to_string_lossy().into_owned(),
    ];
    full_arguments.extend(arguments.iter().cloned());
    run_command(
        "git",
        &full_arguments,
        root,
        &[
            ("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned()),
            ("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned()),
        ],
        false,
        DEFAULT_TOOL_TIMEOUT_MS,
        DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
    )
}

fn git_context(root: &str) -> Result<(PathBuf, Option<String>), String> {
    let workspace = canonical_workspace(root)?;
    let result = run_git(
        &workspace,
        &["rev-parse".to_owned(), "--is-inside-work-tree".to_owned()],
    );
    match result {
        Ok(output) if output.stdout.trim() == "true" => Ok((workspace, None)),
        Ok(_) => Ok((
            workspace,
            Some("This Git repository does not have a working tree.".to_owned()),
        )),
        Err(error) => Ok((workspace, Some(git_error_message(&error)))),
    }
}

fn unavailable_git_response(root: &Path, error: String) -> Value {
    json!({
        "available": false,
        "isRepository": false,
        "root": root,
        "error": error,
    })
}

fn git_relative_path(relative_path: Option<&str>) -> Result<String, String> {
    match relative_path.filter(|value| !value.trim().is_empty()) {
        None => Ok(".".to_owned()),
        Some(path) => Ok(relative_display_path(&checked_relative_path(path, "path")?)),
    }
}

fn parse_git_status(output: &str) -> (String, Vec<Value>) {
    let records = output
        .split('\0')
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut branch = String::new();
    let mut changes = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let entry = records[index];
        if let Some(value) = entry.strip_prefix("## ") {
            branch = value.to_owned();
            index += 1;
            continue;
        }
        if entry.len() >= 3 {
            let status = &entry[..2];
            let mut item = json!({
                "status": status,
                "indexStatus": &status[..1],
                "workTreeStatus": &status[1..2],
                "path": &entry[3..],
            });
            if status.contains('R') || status.contains('C') {
                index += 1;
                if let Some(original) = records.get(index) {
                    item["originalPath"] = Value::String((*original).to_owned());
                }
            }
            changes.push(item);
        }
        index += 1;
    }
    (branch, changes)
}

fn git_status_sync(root: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_response(&workspace, error));
    }
    match run_git(
        &workspace,
        &[
            "status".to_owned(),
            "--porcelain=v1".to_owned(),
            "--branch".to_owned(),
            "-z".to_owned(),
            "--".to_owned(),
            ".".to_owned(),
        ],
    ) {
        Ok(output) => {
            let (branch, changes) = parse_git_status(&output.stdout);
            Ok(json!({
                "available": true,
                "isRepository": true,
                "root": workspace,
                "branch": branch,
                "clean": changes.is_empty(),
                "changes": changes,
            }))
        }
        Err(error) => Ok(json!({
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": git_error_message(&error),
            "changes": [],
        })),
    }
}

fn git_diff_sync(
    root: String,
    relative_path: Option<String>,
    options: Option<Value>,
) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_response(&workspace, error));
    }
    let project_path = git_relative_path(relative_path.as_deref())?;
    let staged = options
        .as_ref()
        .and_then(|value| value.get("staged"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut arguments = vec![
        "diff".to_owned(),
        "--no-ext-diff".to_owned(),
        "--no-color".to_owned(),
        "--unified=3".to_owned(),
    ];
    if staged {
        arguments.push("--cached".to_owned());
    }
    arguments.extend(["--".to_owned(), project_path.clone()]);
    match run_git(&workspace, &arguments) {
        Ok(output) => Ok(json!({
            "available": true,
            "isRepository": true,
            "root": workspace,
            "relativePath": if project_path == "." { Value::Null } else { Value::String(project_path) },
            "staged": staged,
            "hasChanges": !output.stdout.is_empty(),
            "diff": output.stdout,
        })),
        Err(error) => Ok(json!({
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": git_error_message(&error),
            "diff": "",
        })),
    }
}

fn parse_git_log(output: &str) -> Vec<Value> {
    output
        .split('\x1e')
        .filter(|record| !record.is_empty())
        .map(|record| {
            let fields = record.split('\x1f').collect::<Vec<_>>();
            json!({
                "hash": fields.first().copied().unwrap_or_default(),
                "shortHash": fields.get(1).copied().unwrap_or_default(),
                "author": fields.get(2).copied().unwrap_or_default(),
                "date": fields.get(3).copied().unwrap_or_default(),
                "subject": fields.get(4).copied().unwrap_or_default(),
            })
        })
        .collect()
}

fn git_log_sync(
    root: String,
    relative_path: Option<String>,
    options: Option<Value>,
) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_response(&workspace, error));
    }
    let project_path = git_relative_path(relative_path.as_deref())?;
    let limit = options
        .as_ref()
        .and_then(|value| value.get("limit"))
        .and_then(Value::as_f64)
        .map(|value| value.round().clamp(1.0, 100.0) as u32)
        .unwrap_or(30);
    let arguments = vec![
        "log".to_owned(),
        "--no-color".to_owned(),
        "--date=iso-strict".to_owned(),
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e".to_owned(),
        format!("-n{limit}"),
        "--".to_owned(),
        project_path.clone(),
    ];
    match run_git(&workspace, &arguments) {
        Ok(output) => Ok(json!({
            "available": true,
            "isRepository": true,
            "root": workspace,
            "relativePath": if project_path == "." { Value::Null } else { Value::String(project_path) },
            "entries": parse_git_log(&output.stdout),
        })),
        Err(error) => {
            let message = git_error_message(&error);
            if message
                .to_ascii_lowercase()
                .contains("does not have any commits yet")
            {
                Ok(
                    json!({ "available": true, "isRepository": true, "root": workspace, "entries": [] }),
                )
            } else {
                Ok(
                    json!({ "available": true, "isRepository": true, "root": workspace, "error": message, "entries": [] }),
                )
            }
        }
    }
}

fn unavailable_git_mutation(root: &Path, error: String) -> Value {
    json!({
        "ok": false,
        "available": false,
        "isRepository": false,
        "root": root,
        "error": error,
    })
}

fn git_mutation_result(workspace: &Path, result: Result<ToolOutput, ToolError>) -> Value {
    match result {
        Ok(_) => json!({
            "ok": true,
            "available": true,
            "isRepository": true,
            "root": workspace,
        }),
        Err(error) => json!({
            "ok": false,
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": git_error_message(&error),
        }),
    }
}

fn git_stage_sync(root: String, relative_path: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_mutation(&workspace, error));
    }
    let path = git_relative_path(Some(&relative_path))?;
    Ok(git_mutation_result(
        &workspace,
        run_git(&workspace, &["add".to_owned(), "--".to_owned(), path]),
    ))
}

fn git_unstage_sync(root: String, relative_path: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_mutation(&workspace, error));
    }
    let path = git_relative_path(Some(&relative_path))?;
    // `restore --staged` changes only the index. It never discards the
    // working copy, which is the least surprising unstage operation here.
    Ok(git_mutation_result(
        &workspace,
        run_git(
            &workspace,
            &[
                "restore".to_owned(),
                "--staged".to_owned(),
                "--".to_owned(),
                path,
            ],
        ),
    ))
}

fn git_commit_sync(root: String, message: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_mutation(&workspace, error));
    }
    let message = message.trim();
    if message.is_empty() {
        return Ok(json!({
            "ok": false,
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": "Enter a commit message before committing.",
        }));
    }
    if message.chars().count() > 240 || message.contains('\0') {
        return Ok(json!({
            "ok": false,
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": "Commit messages must be at most 240 characters and cannot contain NUL characters.",
        }));
    }
    // A click in Yedit should not execute repository hooks or open a signing
    // prompt. Users who rely on hooks or signing can still commit in a shell.
    Ok(git_mutation_result(
        &workspace,
        run_git(
            &workspace,
            &[
                "-c".to_owned(),
                "commit.gpgsign=false".to_owned(),
                "commit".to_owned(),
                "--no-verify".to_owned(),
                "-m".to_owned(),
                message.to_owned(),
            ],
        ),
    ))
}

fn git_branch_names(output: &str) -> (Option<String>, Vec<String>) {
    let mut current = None;
    let mut branches = Vec::new();
    for record in output.lines() {
        let Some((marker, branch)) = record.split_once('\x1f') else {
            continue;
        };
        let branch = branch.trim();
        if branch.is_empty() || branch == "HEAD" {
            continue;
        }
        if marker.trim() == "*" {
            current = Some(branch.to_owned());
        }
        branches.push(branch.to_owned());
    }
    branches.sort_unstable();
    branches.dedup();
    (current, branches)
}

fn git_branches_sync(root: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_response(&workspace, error));
    }
    match run_git(
        &workspace,
        &[
            "branch".to_owned(),
            "--no-color".to_owned(),
            "--format=%(HEAD)%x1f%(refname:short)".to_owned(),
        ],
    ) {
        Ok(output) => {
            let (current, branches) = git_branch_names(&output.stdout);
            Ok(json!({
                "available": true,
                "isRepository": true,
                "root": workspace,
                "current": current,
                "branches": branches,
            }))
        }
        Err(error) => Ok(json!({
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": git_error_message(&error),
            "branches": [],
        })),
    }
}

fn git_switch_branch_sync(root: String, branch: String) -> Result<Value, String> {
    let (workspace, unavailable) = git_context(&root)?;
    if let Some(error) = unavailable {
        return Ok(unavailable_git_mutation(&workspace, error));
    }
    let requested = branch.trim();
    let listed = run_git(
        &workspace,
        &[
            "branch".to_owned(),
            "--no-color".to_owned(),
            "--format=%(HEAD)%x1f%(refname:short)".to_owned(),
        ],
    );
    let available = match listed {
        Ok(output) => git_branch_names(&output.stdout).1,
        Err(error) => return Ok(git_mutation_result(&workspace, Err(error))),
    };
    if !available.iter().any(|candidate| candidate == requested) {
        return Ok(json!({
            "ok": false,
            "available": true,
            "isRepository": true,
            "root": workspace,
            "error": "That local branch is no longer available. Refresh Git status and try again.",
        }));
    }
    // The branch name was obtained from Git itself. Disabling hooks keeps the
    // switch passive with respect to project-owned hook scripts.
    Ok(git_mutation_result(
        &workspace,
        run_git(
            &workspace,
            &[
                "-c".to_owned(),
                "core.hooksPath=/dev/null".to_owned(),
                "switch".to_owned(),
                requested.to_owned(),
            ],
        ),
    ))
}

async fn run_blocking<F>(work: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("The native task stopped unexpectedly: {error}"))?
}

/// Compile an unsaved TikZ buffer into a PDF data URI for the editor preview.
#[tauri::command]
pub async fn render_tikz(
    source: String,
    name: String,
    engine: Option<String>,
) -> Result<Value, String> {
    run_blocking(move || match compile_tikz_to_temp(&source, &name, engine.as_deref()) {
        Ok(artifact) => match fs::read(&artifact.output_path) {
            Ok(data) => Ok(json!({
                "ok": true,
                "dataUri": format!("data:application/pdf;base64,{}", BASE64.encode(data)),
                "pdfPath": artifact.output_path,
                "directory": artifact.directory,
                "engine": artifact.engine,
            })),
            Err(error) => {
                remove_temp_directory(&artifact.directory);
                Ok(json!({ "ok": false, "error": format!("Could not read the compiled PDF: {error}") }))
            }
        },
        Err(error) => Ok(json!({ "ok": false, "error": error })),
    })
    .await
}

/// Compile an unsaved LaTeX buffer into either a PDF data URI or a DVI/SVG
/// preview, matching the renderer contract response shape.
#[tauri::command]
pub async fn render_latex(
    source: String,
    name: String,
    mode: Option<String>,
    engine: Option<String>,
) -> Result<Value, String> {
    run_blocking(move || {
        let mode = mode.unwrap_or_else(|| "pdf".to_owned()).to_ascii_lowercase();
        if !matches!(mode.as_str(), "pdf" | "dvi") {
            return Ok(json!({ "ok": false, "error": "LaTeX preview supports PDF or DVI output." }));
        }
        let artifact = match compile_latex_to_temp(&source, &name, &mode, engine.as_deref()) {
            Ok(artifact) => artifact,
            Err(error) => return Ok(json!({ "ok": false, "error": error })),
        };
        if mode == "pdf" {
            return match fs::read(&artifact.output_path) {
                Ok(data) => Ok(json!({
                    "ok": true,
                    "format": "pdf",
                    "dataUri": format!("data:application/pdf;base64,{}", BASE64.encode(data)),
                    "pdfPath": artifact.output_path,
                    "directory": artifact.directory,
                    "engine": artifact.engine,
                })),
                Err(error) => {
                    remove_temp_directory(&artifact.directory);
                    Ok(json!({ "ok": false, "error": format!("Could not read the compiled PDF: {error}") }))
                }
            };
        }
        let svg_path = artifact.directory.join(format!("{}.svg", artifact.base_name));
        let arguments = vec![
            "--page=1".to_owned(),
            "--no-fonts".to_owned(),
            format!("--output={}", svg_path.display()),
            artifact.output_path.to_string_lossy().into_owned(),
        ];
        match run_command(
            "dvisvgm",
            &arguments,
            &artifact.directory,
            &[],
            false,
            DEFAULT_TOOL_TIMEOUT_MS,
            DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        ) {
            Ok(_) => match fs::read_to_string(&svg_path) {
                Ok(svg) => Ok(json!({
                    "ok": true,
                    "format": "dvi",
                    "dviPath": artifact.output_path,
                    "directory": artifact.directory,
                    "engine": artifact.engine,
                    "previewKind": "svg",
                    "svg": svg,
                })),
                Err(error) => Ok(json!({
                    "ok": true,
                    "format": "dvi",
                    "dviPath": artifact.output_path,
                    "directory": artifact.directory,
                    "engine": artifact.engine,
                    "previewKind": "none",
                    "warning": format!("DVI compiled successfully, but its SVG preview could not be read: {error}"),
                })),
            },
            Err(error) => {
                let detail = if error.not_found {
                    "Install dvisvgm (included with a full TeX Live or MacTeX installation) to preview DVI files here."
                } else {
                    "dvisvgm could not convert the DVI first page to an SVG preview."
                };
                Ok(json!({
                    "ok": true,
                    "format": "dvi",
                    "dviPath": artifact.output_path,
                    "directory": artifact.directory,
                    "engine": artifact.engine,
                    "previewKind": "none",
                    "warning": format!("DVI compiled successfully. {detail} You can still export the DVI build output."),
                }))
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn render_metafont(source: String, name: String) -> Result<Value, String> {
    run_blocking(move || Ok(render_metafont_sync(&source, &name))).await
}

#[tauri::command]
pub async fn render_export(payload: Value) -> Result<Value, String> {
    run_blocking(move || Ok(export_payload_sync(payload))).await
}

#[tauri::command]
pub fn project_build_profiles() -> Value {
    Value::Array(
        BUILD_PROFILES
            .iter()
            .map(|profile| {
                json!({
                    "id": profile.id,
                    "label": profile.label,
                    "sourceTypes": profile.source_types,
                    "outputExtension": profile.output_extension,
                    "compiler": profile.compiler,
                    "engine": profile.engine,
                })
            })
            .collect(),
    )
}

/// Lists fixed root scripts and checked tasks in `yedit.tasks.json`. A task
/// never carries a shell string across the webview boundary.
#[tauri::command]
pub async fn project_list_tasks(root: String) -> Result<Value, String> {
    run_blocking(move || {
        let workspace = canonical_workspace(&root)?;
        Ok(json!({
            "root": workspace.to_string_lossy(),
            "tasks": project_tasks_for_workspace(&workspace)
                .into_iter()
                .map(|task| workspace_project_task_value(&task))
                .collect::<Vec<_>>(),
        }))
    })
    .await
}

/// Executes a backend-discovered task selected by id. Declarative tasks have
/// already passed allow-list and argv validation; the renderer supplies no
/// command or path.
#[tauri::command]
pub async fn project_run_task(root: String, task_id: String) -> Result<Value, String> {
    run_blocking(move || run_project_task_sync(root, task_id)).await
}

#[tauri::command]
pub async fn project_run_build(
    root: String,
    relative_path: String,
    profile_id: String,
) -> Result<Value, String> {
    run_blocking(move || run_build_profile_sync(root, relative_path, profile_id)).await
}

#[tauri::command]
pub async fn project_run_python(
    source: String,
    name: String,
    options: Option<Value>,
) -> Result<Value, String> {
    run_blocking(move || Ok(run_python_sync(source, name, options))).await
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<Value, String> {
    run_blocking(move || git_status_sync(root)).await
}

#[tauri::command]
pub async fn git_diff(
    root: String,
    relative_path: Option<String>,
    options: Option<Value>,
) -> Result<Value, String> {
    run_blocking(move || git_diff_sync(root, relative_path, options)).await
}

#[tauri::command]
pub async fn git_log(
    root: String,
    relative_path: Option<String>,
    options: Option<Value>,
) -> Result<Value, String> {
    run_blocking(move || git_log_sync(root, relative_path, options)).await
}

#[tauri::command]
pub async fn git_stage(root: String, relative_path: String) -> Result<Value, String> {
    run_blocking(move || git_stage_sync(root, relative_path)).await
}

#[tauri::command]
pub async fn git_unstage(root: String, relative_path: String) -> Result<Value, String> {
    run_blocking(move || git_unstage_sync(root, relative_path)).await
}

#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Result<Value, String> {
    run_blocking(move || git_commit_sync(root, message)).await
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Value, String> {
    run_blocking(move || git_branches_sync(root)).await
}

#[tauri::command]
pub async fn git_switch_branch(root: String, branch: String) -> Result<Value, String> {
    run_blocking(move || git_switch_branch_sync(root, branch)).await
}

#[tauri::command]
pub async fn clipboard_write_svg(svg: String) -> Result<Value, String> {
    run_blocking(move || {
        if svg.trim().is_empty() {
            return Err("There is no SVG to copy.".to_owned());
        }
        if svg.len() > 5 * 1024 * 1024 {
            return Err("That SVG is too large to copy to the clipboard.".to_owned());
        }
        let mut clipboard =
            Clipboard::new().map_err(|error| format!("Could not access the clipboard: {error}"))?;
        clipboard
            .set_text(svg)
            .map_err(|error| format!("Could not copy SVG to the clipboard: {error}"))?;
        Ok(json!({ "ok": true }))
    })
    .await
}

#[tauri::command]
pub async fn clipboard_write_data_uri_image(data_uri: String) -> Result<Value, String> {
    run_blocking(move || {
        if data_uri.len() > 30 * 1024 * 1024 {
            return Err("That image is too large to copy to the clipboard.".to_owned());
        }
        let (header, encoded) = data_uri
            .split_once(',')
            .ok_or_else(|| "Copy Image expects a PNG, JPEG, GIF, or WebP data URI.".to_owned())?;
        let header = header.to_ascii_lowercase();
        if !matches!(
            header.as_str(),
            "data:image/png;base64"
                | "data:image/jpeg;base64"
                | "data:image/jpg;base64"
                | "data:image/gif;base64"
                | "data:image/webp;base64"
        ) {
            return Err("Copy Image expects a PNG, JPEG, GIF, or WebP data URI.".to_owned());
        }
        let bytes = BASE64
            .decode(encoded)
            .map_err(|_| "The preview image could not be decoded.".to_owned())?;
        let rgba = image::load_from_memory(&bytes)
            .map_err(|_| "The preview image could not be decoded.".to_owned())?
            .to_rgba8();
        let width = rgba.width();
        let height = rgba.height();
        let mut clipboard =
            Clipboard::new().map_err(|error| format!("Could not access the clipboard: {error}"))?;
        clipboard
            .set_image(ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            })
            .map_err(|error| format!("The preview image could not be copied: {error}"))?;
        Ok(json!({ "ok": true, "size": { "width": width, "height": height } }))
    })
    .await
}

#[tauri::command]
pub async fn shell_reveal(target: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(target);
        if !path.exists() {
            return Err("That file is no longer available to reveal.".to_owned());
        }
        #[cfg(target_os = "macos")]
        {
            let working_directory = path.parent().unwrap_or_else(|| Path::new("/"));
            run_command(
                "open",
                &["-R".to_owned(), path.to_string_lossy().into_owned()],
                working_directory,
                &[],
                false,
                8_000,
                64 * 1024,
            )
            .map_err(|error| error.combined())?;
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Err("Reveal in Finder is currently available on macOS only.".to_owned())
        }
    })
    .await
    .map_err(|error| format!("The native task stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod project_task_tests {
    use super::*;

    #[test]
    fn added_code_sources_export_as_escaped_text_without_build_profiles() {
        for kind in crate::models::EXTRA_SOURCE_TYPE_IDS {
            let name = format!("source.{}", crate::models::extension_for_source_type(kind));
            assert!(is_supported_source_path(Path::new(&name)));
            assert_eq!(source_type_for_path(Path::new(&name)), *kind);
            let preview = source_text_preview_html("<script>alert(1)</script>", kind);
            assert!(preview.contains("&lt;script&gt;"));
            assert!(!preview.contains("<script>alert(1)</script>"));
            assert!(BUILD_PROFILES
                .iter()
                .all(|profile| !profile.source_types.contains(kind)));
        }
        assert!(!is_supported_source_path(Path::new("source.cpp.bak")));
    }

    #[test]
    fn php_sources_are_supported_and_previewed_as_escaped_text() {
        for extension in [
            "php", "phtml", "php3", "php4", "php5", "php6", "php7", "php8", "PHP", "PHTML",
        ] {
            let name = format!("index.{extension}");
            assert!(is_supported_source_path(Path::new(&name)));
            assert_eq!(source_type_for_path(Path::new(&name)), "php");
        }
        let preview = source_text_preview_html("<?php echo '<script>alert(1)</script>'; ?>", "php");
        assert!(preview.contains("&lt;?php"));
        assert!(!preview.contains("<script>alert(1)</script>"));
    }

    fn temporary_project(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("yedit-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn discovers_only_regular_root_task_scripts() {
        let root = temporary_project("task-discovery");
        fs::write(root.join("build.sh"), "printf build\n").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/build-preview.sh"), "printf preview\n").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(
            root.join("nested/build-preview.sh"),
            root.join("build-preview.sh"),
        )
        .unwrap();

        let canonical_root = fs::canonicalize(&root).unwrap();
        let task_ids = project_tasks_for_workspace(&canonical_root)
            .into_iter()
            .map(|task| match task {
                WorkspaceProjectTask::Script(task) => task.id.to_owned(),
                WorkspaceProjectTask::Declared(task) => task.id,
            })
            .collect::<Vec<_>>();
        assert_eq!(task_ids, vec!["build"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovers_only_allowlisted_declarative_tasks() {
        let root = temporary_project("declared-task-discovery");
        fs::write(
            root.join(PROJECT_TASK_CONFIG_NAME),
            r#"{
              "tasks": [
                { "id": "check", "label": "Check", "kind": "test", "command": "python3", "args": ["--version"] },
                { "id": "unsafe-shell", "command": "/bin/sh", "args": ["-c", "echo no"] },
                { "id": "Bad-id", "command": "node" }
              ]
            }"#,
        )
        .unwrap();

        let canonical_root = fs::canonicalize(&root).unwrap();
        let task_ids = project_tasks_for_workspace(&canonical_root)
            .into_iter()
            .map(|task| match task {
                WorkspaceProjectTask::Script(task) => task.id.to_owned(),
                WorkspaceProjectTask::Declared(task) => task.id,
            })
            .collect::<Vec<_>>();
        assert_eq!(task_ids, vec!["task:check"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prefers_preview_pdf_before_other_build_artifacts() {
        let root = temporary_project("task-artifact");
        fs::create_dir_all(root.join("build/preview")).unwrap();
        fs::create_dir_all(root.join("build/other")).unwrap();
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(root.join("build/preview/book.pdf"), b"%PDF-preview").unwrap();
        fs::write(root.join("build/other/newer.pdf"), b"%PDF-build").unwrap();
        fs::write(root.join("dist/release.pdf"), b"%PDF-dist").unwrap();

        let canonical_root = fs::canonicalize(&root).unwrap();
        let artifact =
            latest_project_task_pdf(&canonical_root).expect("preview PDF should be found");
        assert_eq!(
            artifact.path,
            fs::canonicalize(root.join("build/preview/book.pdf")).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runs_only_the_fixed_root_task_and_returns_a_preview_artifact() {
        let root = temporary_project("task-run");
        fs::write(
            root.join("build.sh"),
            "printf 'build output\\n'\nprintf 'build warning\\n' >&2\nmkdir -p build/preview\nprintf '%s' '%PDF-1.0' > build/preview/book.pdf\n",
        )
        .unwrap();

        let result = run_project_task_sync(root.to_string_lossy().into_owned(), "build".to_owned())
            .expect("fixed build task should run");
        assert_eq!(result["ok"], Value::Bool(true));
        assert_eq!(result["task"]["id"], Value::String("build".to_owned()));
        assert!(result["output"].as_str().is_some_and(
            |output| output.contains("build output") && output.contains("build warning")
        ));
        assert_eq!(
            result["artifact"]["relativePath"],
            Value::String("build/preview/book.pdf".to_owned())
        );
        assert!(result["artifact"]["dataUri"]
            .as_str()
            .is_some_and(|uri| uri.starts_with("data:application/pdf;base64,")));
        fs::remove_dir_all(root).unwrap();
    }
}
