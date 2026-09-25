//! Lokalna polityka Workera i kanoniczna walidacja ścieżek (warstwa 2 — broker robi walidację leksykalną).
//!
//! Zasada: ścieżka jest dozwolona, gdy jej KANONICZNA postać (po rozwiązaniu symlinków i junctions)
//! leży w części wspólnej: katalog lokalny udostępniony przez właściciela urządzenia ∩ podpisany grant serwera.

use std::path::{Component, Path, PathBuf};

use serde::Deserialize;

use crate::protocol::Grant;

#[derive(Debug, Clone, Deserialize)]
pub struct LocalRoot {
    pub path: PathBuf,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LocalPolicy {
    #[serde(default)]
    pub roots: Vec<LocalRoot>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Deny {
    #[error("path_not_allowed")]
    PathNotAllowed,
    #[error("capability_not_in_local_policy")]
    CapabilityNotInLocalPolicy,
    #[error("no_grant_for_capability")]
    NoGrantForCapability,
    #[error("path_outside_root")]
    PathOutsideRoot,
    #[error("symlink_target")]
    SymlinkTarget,
    #[error("parent_missing")]
    ParentMissing,
    #[error("not_found")]
    NotFound,
    #[error("unknown_capability")]
    UnknownCapability,
}

/// Nazwy zarezerwowane Windows (CON, NUL, COM1…) — także z rozszerzeniem.
pub fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Reguły nazw segmentów obowiązujące na Windows (testowalne na każdej platformie).
pub fn windows_segment_ok(seg: &str) -> bool {
    !(seg.contains(':') || is_windows_reserved(seg) || seg.ends_with('.') || seg.ends_with(' '))
}

/// Walidacja leksykalna: ścieżka bezwzględna, bez `..`, na Windows tylko zwykła litera dysku
/// (bez `\\?\`, `\\.\`, UNC), bez strumieni ADS i nazw zarezerwowanych.
pub fn lexical_check(input: &str) -> Result<(), Deny> {
    if input.is_empty() || input.len() > 1024 || input.contains('\0') {
        return Err(Deny::PathNotAllowed);
    }
    let p = Path::new(input);
    if !p.is_absolute() {
        return Err(Deny::PathNotAllowed);
    }
    for c in p.components() {
        match c {
            Component::ParentDir => return Err(Deny::PathNotAllowed),
            #[cfg(windows)]
            Component::Prefix(prefix) => {
                use std::path::Prefix;
                if !matches!(prefix.kind(), Prefix::Disk(_)) {
                    return Err(Deny::PathNotAllowed);
                }
            }
            #[cfg(windows)]
            Component::Normal(seg) => {
                if !windows_segment_ok(&seg.to_string_lossy()) {
                    return Err(Deny::PathNotAllowed);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn canonical(p: &Path) -> Option<PathBuf> {
    // dunce: na Windows usuwa prefiks \\?\ tam, gdzie to bezpieczne; rozwiązuje symlinki i junctions.
    dunce::canonicalize(p).ok()
}

/// Porównanie po komponentach (C:\a nie obejmuje C:\ab). Na Windows bez rozróżniania wielkości liter.
pub fn within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let p = path.to_string_lossy().to_lowercase();
        let r = root.to_string_lossy().to_lowercase();
        Path::new(&p).starts_with(Path::new(&r))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

#[cfg(windows)]
fn is_link_or_reparse(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

impl LocalPolicy {
    /// Katalogi dozwolone dla grantu: lokalne ∩ serwerowe, w postaci kanonicznej.
    pub fn allowed_roots(
        &self,
        grant: &str,
        server_grants: &[Grant],
    ) -> Result<Vec<PathBuf>, Deny> {
        let locals: Vec<PathBuf> = self
            .roots
            .iter()
            .filter(|r| r.capabilities.iter().any(|c| c == grant))
            .filter_map(|r| canonical(&r.path))
            .collect();
        if locals.is_empty() {
            return Err(Deny::CapabilityNotInLocalPolicy);
        }
        let mut out = Vec::new();
        for g in server_grants.iter().filter(|g| g.capability == grant) {
            if lexical_check(&g.root).is_err() {
                continue;
            }
            let Some(s) = canonical(Path::new(&g.root)) else {
                continue;
            };
            for l in &locals {
                if within(&s, l) {
                    out.push(s.clone());
                } else if within(l, &s) {
                    out.push(l.clone());
                }
            }
        }
        if out.is_empty() {
            return Err(Deny::NoGrantForCapability);
        }
        Ok(out)
    }

    /// Rozwiązuje ścieżkę do postaci kanonicznej i sprawdza, czy nie ucieka z dozwolonych katalogów.
    pub fn resolve(
        &self,
        input: &str,
        grant: &str,
        server_grants: &[Grant],
        for_write: bool,
    ) -> Result<PathBuf, Deny> {
        lexical_check(input)?;
        let roots = self.allowed_roots(grant, server_grants)?;
        let p = Path::new(input);
        let real = if for_write {
            let parent = p.parent().ok_or(Deny::PathNotAllowed)?;
            let name = p.file_name().ok_or(Deny::PathNotAllowed)?;
            let parent = canonical(parent).ok_or(Deny::ParentMissing)?;
            let target = parent.join(name);
            if let Ok(meta) = std::fs::symlink_metadata(&target)
                && is_link_or_reparse(&meta)
            {
                return Err(Deny::SymlinkTarget);
            }
            target
        } else {
            canonical(p).ok_or(Deny::NotFound)?
        };
        if roots.iter().any(|r| within(&real, r)) {
            Ok(real)
        } else {
            Err(Deny::PathOutsideRoot)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, LocalPolicy, Vec<Grant>) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("projekt");
        let outside = tmp.path().join("poza");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("src/a.txt"), "a").unwrap();
        fs::write(outside.join("tajne.txt"), "sekret").unwrap();
        let policy = LocalPolicy {
            roots: vec![LocalRoot {
                path: root.clone(),
                capabilities: vec!["device.files.read".into(), "device.files.write".into()],
            }],
        };
        let grants = vec![
            Grant {
                capability: "device.files.read".into(),
                root: root.to_string_lossy().into(),
            },
            Grant {
                capability: "device.files.write".into(),
                root: root.join("src").to_string_lossy().into(),
            },
        ];
        (tmp, root, outside, policy, grants)
    }

    #[test]
    fn allows_paths_inside_intersection() {
        let (_t, root, _o, policy, grants) = setup();
        let p = root.join("src/a.txt");
        let r = policy
            .resolve(&p.to_string_lossy(), "device.files.read", &grants, false)
            .unwrap();
        assert!(r.ends_with("src/a.txt"));
        // Zapis: grant serwera węższy (src) niż lokalny korzeń — w katalogu głównym odmowa.
        let top = root.join("nowy.txt");
        assert_eq!(
            policy.resolve(&top.to_string_lossy(), "device.files.write", &grants, true),
            Err(Deny::PathOutsideRoot)
        );
        let inside = root.join("src/nowy.txt");
        assert!(
            policy
                .resolve(
                    &inside.to_string_lossy(),
                    "device.files.write",
                    &grants,
                    true
                )
                .is_ok()
        );
    }

    #[test]
    fn rejects_traversal_and_relative() {
        let (_t, root, _o, policy, grants) = setup();
        let bad = format!("{}/../poza/tajne.txt", root.to_string_lossy());
        assert_eq!(
            policy.resolve(&bad, "device.files.read", &grants, false),
            Err(Deny::PathNotAllowed)
        );
        assert_eq!(
            policy.resolve("src/a.txt", "device.files.read", &grants, false),
            Err(Deny::PathNotAllowed)
        );
    }

    #[test]
    fn rejects_outside_and_missing_grants() {
        let (_t, _root, outside, policy, grants) = setup();
        let p = outside.join("tajne.txt");
        assert_eq!(
            policy.resolve(&p.to_string_lossy(), "device.files.read", &grants, false),
            Err(Deny::PathOutsideRoot)
        );
        assert_eq!(
            policy.resolve(&p.to_string_lossy(), "device.git.read", &grants, false),
            Err(Deny::CapabilityNotInLocalPolicy)
        );
        let no_server: Vec<Grant> = vec![];
        let (_t2, root2, _o2, policy2, _) = setup();
        let q = root2.join("src/a.txt");
        assert_eq!(
            policy2.resolve(&q.to_string_lossy(), "device.files.read", &no_server, false),
            Err(Deny::NoGrantForCapability)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (_t, root, outside, policy, grants) = setup();
        std::os::unix::fs::symlink(outside.join("tajne.txt"), root.join("src/link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("src/dir-link")).unwrap();
        let l = root.join("src/link.txt");
        assert_eq!(
            policy.resolve(&l.to_string_lossy(), "device.files.read", &grants, false),
            Err(Deny::PathOutsideRoot)
        );
        let d = root.join("src/dir-link/tajne.txt");
        assert_eq!(
            policy.resolve(&d.to_string_lossy(), "device.files.read", &grants, false),
            Err(Deny::PathOutsideRoot)
        );
        // Zapis przez symlink (nawet wewnątrz) jest odrzucany.
        assert_eq!(
            policy.resolve(&l.to_string_lossy(), "device.files.write", &grants, true),
            Err(Deny::SymlinkTarget)
        );
        // Zapis w katalogu-linku prowadzącym na zewnątrz — rodzic kanonicznie poza korzeniem.
        let w = root.join("src/dir-link/nowy.txt");
        assert_eq!(
            policy.resolve(&w.to_string_lossy(), "device.files.write", &grants, true),
            Err(Deny::PathOutsideRoot)
        );
    }

    #[test]
    fn windows_segment_rules() {
        assert!(!windows_segment_ok("plik.txt:ukryty"));
        assert!(!windows_segment_ok("CON"));
        assert!(!windows_segment_ok("nul.txt"));
        assert!(!windows_segment_ok("com1"));
        assert!(!windows_segment_ok("trik."));
        assert!(!windows_segment_ok("trik "));
        assert!(windows_segment_ok("console.log"));
        assert!(windows_segment_ok("com10"));
        assert!(windows_segment_ok("notatka.txt"));
    }

    #[test]
    fn within_is_component_wise() {
        assert!(within(Path::new("/a/b/c"), Path::new("/a/b")));
        assert!(!within(Path::new("/a/bc"), Path::new("/a/b")));
    }

    /// Junction (Windows) prowadzący poza katalog — test ręczny/CI Windows (tutaj nieuruchamiany).
    #[cfg(windows)]
    #[test]
    fn rejects_junction_escape() {
        let (_t, root, outside, policy, grants) = setup();
        let link = root.join("src").join("junction");
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &outside.to_string_lossy(),
            ])
            .status()
            .unwrap();
        assert!(status.success());
        let p = link.join("tajne.txt");
        assert_eq!(
            policy.resolve(&p.to_string_lossy(), "device.files.read", &grants, false),
            Err(Deny::PathOutsideRoot)
        );
    }
}
