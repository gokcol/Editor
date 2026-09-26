//! Versions describe the exact bytes read from one file descriptor.
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

pub const SAVE_CONFLICT: &str =
    "SAVE_CONFLICT: This file changed on disk. Compare the versions before saving.";

pub fn version(bytes: &[u8], metadata: &std::fs::Metadata) -> String {
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = {
        let _ = metadata;
        String::new()
    };
    format!("{identity}:{:x}", Sha256::digest(bytes))
}

pub fn check(file: &mut File, expected: &str) -> Result<(), String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let actual = version(&bytes, &file.metadata().map_err(|e| e.to_string())?);
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if actual != expected {
        return Err(SAVE_CONFLICT.to_owned());
    }
    Ok(())
}
