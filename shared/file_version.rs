//! Versions describe the exact bytes read from one file descriptor.
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};

pub const SAVE_CONFLICT: &str =
    "SAVE_CONFLICT: This file changed on disk. Compare the versions before saving.";

pub fn identity(file: &File) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(format!("{}:{}:{}:{}:{}", info.dwVolumeSerialNumber,
            info.nFileIndexHigh, info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime, info.ftCreationTime.dwLowDateTime))
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = file; Err("File identity is unavailable on this platform.".to_owned()) }
}

pub fn version(bytes: &[u8], file: &File) -> Result<String, String> {
    Ok(format!("{}:{:x}", identity(file)?, Sha256::digest(bytes)))
}

pub fn check(file: &mut File, expected: &str) -> Result<(), String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let actual = version(&bytes, file)?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if actual != expected {
        return Err(SAVE_CONFLICT.to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_bytes_in_a_replacement_are_a_different_version() {
        let directory = std::env::temp_dir().join(format!("editor-file-version-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("source.txt");
        std::fs::write(&path, b"unchanged bytes").unwrap();
        let expected = version(b"unchanged bytes", &File::open(&path).unwrap()).unwrap();
        std::fs::rename(&path, directory.join("original.txt")).unwrap();
        std::fs::write(&path, b"unchanged bytes").unwrap();
        let mut replacement = File::open(&path).unwrap();
        assert_eq!(check(&mut replacement, &expected).unwrap_err(), SAVE_CONFLICT);
        drop(replacement);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
