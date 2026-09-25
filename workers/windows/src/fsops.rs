//! Operacje na plikach: lista, odczyt (limit), zapis z kontrolą `baseSha256`, kopią zapasową
//! POZA udostępnionym katalogiem i atomową zamianą (plik tymczasowy w tym samym katalogu + rename).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MAX_READ: u64 = 256 * 1024;
pub const MAX_WRITE: usize = 512 * 1024;
const MAX_ENTRIES: usize = 1000;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FsError {
    #[error("not_a_file")]
    NotAFile,
    #[error("not_a_directory")]
    NotADirectory,
    #[error("file_too_large")]
    FileTooLarge,
    #[error("base_changed")]
    BaseChanged,
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for FsError {
    fn from(e: std::io::Error) -> Self {
        FsError::Io(e.kind().to_string())
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn list(dir: &Path) -> Result<Value, FsError> {
    if !dir.is_dir() {
        return Err(FsError::NotADirectory);
    }
    let mut entries = Vec::new();
    for e in fs::read_dir(dir)?.take(MAX_ENTRIES) {
        let e = e?;
        let meta = fs::symlink_metadata(e.path())?;
        let kind = if meta.file_type().is_symlink() {
            "link"
        } else if meta.is_dir() {
            "dir"
        } else {
            "file"
        };
        let modified = meta.modified().ok().map(|t| {
            chrono::DateTime::<chrono::Utc>::from(t)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        entries.push(json!({
            "name": e.file_name().to_string_lossy(),
            "kind": kind,
            "size": meta.len(),
            "modified": modified,
        }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({ "path": dir.to_string_lossy(), "entries": entries }))
}

pub fn read(file: &Path) -> Result<Value, FsError> {
    let meta = fs::metadata(file)?;
    if !meta.is_file() {
        return Err(FsError::NotAFile);
    }
    if meta.len() > MAX_READ {
        return Err(FsError::FileTooLarge);
    }
    let buf = fs::read(file)?;
    Ok(json!({
        "content": String::from_utf8_lossy(&buf),
        "sha256": sha256_hex(&buf),
        "size": meta.len(),
    }))
}

/// Zapis: `base_sha256 = None` => plik nie może istnieć; `Some(h)` => bieżąca treść musi mieć skrót `h`.
pub fn write(
    file: &Path,
    content: &str,
    base_sha256: Option<&str>,
    backup_dir: &Path,
) -> Result<Value, FsError> {
    if content.len() > MAX_WRITE {
        return Err(FsError::FileTooLarge);
    }
    let current = match fs::read(file) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    match (&current, base_sha256) {
        (None, None) => {}
        (Some(cur), Some(h)) if sha256_hex(cur) == h => {}
        _ => return Err(FsError::BaseChanged),
    }
    let mut backup_path: Option<PathBuf> = None;
    if let Some(cur) = &current {
        fs::create_dir_all(backup_dir)?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3f");
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let b = backup_dir.join(format!("{stamp}-{}-{name}", &sha256_hex(cur)[..8]));
        fs::write(&b, cur)?;
        backup_path = Some(b);
    }
    let dir = file.parent().ok_or(FsError::NotAFile)?;
    let mut rnd = [0u8; 4];
    getrandom::fill(&mut rnd).map_err(|_| FsError::Io("rng".into()))?;
    let tmp = dir.join(format!(
        ".{}.nova-tmp-{}",
        file.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        hex::encode(rnd)
    ));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    // Atomowa zamiana (na Windows: MoveFileExW z MOVEFILE_REPLACE_EXISTING).
    if let Err(e) = fs::rename(&tmp, file) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(json!({
        "path": file.to_string_lossy(),
        "size": content.len(),
        "sha256": sha256_hex(content.as_bytes()),
        "backupPath": backup_path.map(|p| p.to_string_lossy().into_owned()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_new_then_update_with_backup_and_no_tmp_left() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("a.txt");
        let backups = t.path().join("state/backups");
        let r = write(&f, "v1", None, &backups).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "v1");
        assert!(r["backupPath"].is_null());
        // Plik istnieje — zapis „nowego” jest odrzucony.
        assert_eq!(write(&f, "x", None, &backups), Err(FsError::BaseChanged));
        let h = sha256_hex(b"v1");
        let r2 = write(&f, "v2", Some(&h), &backups).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "v2");
        let b = r2["backupPath"].as_str().unwrap();
        assert_eq!(fs::read_to_string(b).unwrap(), "v1");
        // Stary skrót już nie pasuje.
        assert_eq!(
            write(&f, "v3", Some(&h), &backups),
            Err(FsError::BaseChanged)
        );
        let leftovers: Vec<_> = fs::read_dir(t.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("nova-tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn read_limits_and_list() {
        let t = tempfile::tempdir().unwrap();
        fs::write(t.path().join("b.txt"), "bb").unwrap();
        fs::create_dir(t.path().join("dir")).unwrap();
        let big = t.path().join("big.bin");
        fs::write(&big, vec![0u8; (MAX_READ + 1) as usize]).unwrap();
        assert_eq!(read(&big), Err(FsError::FileTooLarge));
        assert_eq!(read(t.path()), Err(FsError::NotAFile));
        let r = read(&t.path().join("b.txt")).unwrap();
        assert_eq!(r["sha256"], sha256_hex(b"bb"));
        let l = list(t.path()).unwrap();
        let names: Vec<&str> = l["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["b.txt", "big.bin", "dir"]);
    }
}
