//! Trwały stan Workera: klucz urządzenia (generowany lokalnie, nigdy nie opuszcza urządzenia),
//! identyfikator urządzenia, przypięty klucz serwera i pamięć idempotencji.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};

use crate::protocol::ResultPayload;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub server: String,
    pub device_id: String,
    pub server_public_key: String,
}

pub struct StateDir {
    pub dir: PathBuf,
}

const IDEM_MAX: usize = 500;

impl StateDir {
    pub fn new(dir: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    pub fn backups(&self) -> PathBuf {
        self.dir.join("backups")
    }

    /// Klucz urządzenia: 32 losowe bajty zapisane z uprawnieniami tylko dla właściciela (Unix: 0600).
    /// TODO(Windows): ochrona DPAPI zamiast zwykłego pliku w profilu użytkownika.
    pub fn device_key(&self) -> std::io::Result<SigningKey> {
        let path = self.dir.join("device.key");
        if let Ok(hexed) = fs::read_to_string(&path) {
            let raw = hex::decode(hexed.trim())
                .map_err(|_| std::io::Error::other("uszkodzony device.key"))?;
            let seed: [u8; 32] = raw
                .try_into()
                .map_err(|_| std::io::Error::other("uszkodzony device.key"))?;
            return Ok(SigningKey::from_bytes(&seed));
        }
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|_| std::io::Error::other("brak entropii"))?;
        write_private(&path, hex::encode(seed).as_bytes())?;
        Ok(SigningKey::from_bytes(&seed))
    }

    pub fn pairing(&self) -> Option<Pairing> {
        let s = fs::read_to_string(self.dir.join("pairing.json")).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save_pairing(&self, p: &Pairing) -> std::io::Result<()> {
        write_private(
            &self.dir.join("pairing.json"),
            serde_json::to_string_pretty(p)?.as_bytes(),
        )
    }
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data)
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    fs::write(path, data)
}

/// Pamięć wyników wg klucza idempotencji — powtórzone polecenie nie wykonuje efektu drugi raz.
#[derive(Default, Serialize, Deserialize)]
pub struct IdempotencyCache {
    entries: VecDeque<(String, ResultPayload)>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

impl IdempotencyCache {
    pub fn load(path: PathBuf) -> Self {
        let mut c: IdempotencyCache = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        c.path = Some(path);
        c
    }

    pub fn get(&self, key: &str) -> Option<&ResultPayload> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn put(&mut self, key: String, result: ResultPayload) {
        self.entries.retain(|(k, _)| k != &key);
        self.entries.push_back((key, result));
        while self.entries.len() > IDEM_MAX {
            self.entries.pop_front();
        }
        if let Some(p) = &self.path
            && let Ok(s) = serde_json::to_string(self)
        {
            let _ = fs::write(p, s);
        }
    }
}
