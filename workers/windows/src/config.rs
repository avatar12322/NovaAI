//! Konfiguracja Workera (`worker.toml`) — ustawiana lokalnie przez właściciela urządzenia.

use std::path::PathBuf;

use serde::Deserialize;

use crate::policy::{LocalPolicy, LocalRoot};

#[derive(Debug, Deserialize)]
pub struct Config {
    /// Adres serwera NovaAI, np. https://nova.example.com (http tylko dla localhost).
    pub server: String,
    #[serde(default = "default_name")]
    pub name: String,
    pub state_dir: Option<PathBuf>,
    /// Katalogi udostępnione lokalnie; serwer może jedynie ZAWĘZIĆ dostęp grantem.
    #[serde(default)]
    pub roots: Vec<LocalRoot>,
}

fn default_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Worker".into())
}

impl Config {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let s = std::fs::read_to_string(path)?;
        Ok(toml::from_str(&s)?)
    }

    pub fn policy(&self) -> LocalPolicy {
        LocalPolicy {
            roots: self.roots.clone(),
        }
    }

    pub fn state_dir(&self) -> PathBuf {
        self.state_dir.clone().unwrap_or_else(default_state_dir)
    }
}

pub fn default_state_dir() -> PathBuf {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local).join("NovaWorker");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local/share/nova-worker");
    }
    PathBuf::from(".nova-worker")
}

/// Wymuszenie TLS poza pętlą zwrotną.
pub fn check_server_url(server: &str) -> anyhow::Result<()> {
    let lower = server.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', ':']).next().unwrap_or("");
        if matches!(host, "localhost" | "127.0.0.1" | "[") || rest.starts_with("[::1]") {
            return Ok(());
        }
    }
    anyhow::bail!("Serwer musi używać https:// (http dozwolony tylko dla localhost)")
}

pub fn ws_url(server: &str) -> String {
    let base = server.trim_end_matches('/');
    let ws = if let Some(r) = base.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = base.strip_prefix("http://") {
        format!("ws://{r}")
    } else {
        base.to_string()
    };
    format!("{ws}/api/device-link/connect")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_required_except_loopback() {
        assert!(check_server_url("https://nova.example.com").is_ok());
        assert!(check_server_url("http://127.0.0.1:4000").is_ok());
        assert!(check_server_url("http://localhost:4000").is_ok());
        assert!(check_server_url("http://[::1]:4000").is_ok());
        assert!(check_server_url("http://nova.example.com").is_err());
        assert!(check_server_url("http://127.0.0.1.evil.com").is_err());
        assert_eq!(ws_url("https://a.b/"), "wss://a.b/api/device-link/connect");
    }

    #[test]
    fn parses_example_config() {
        let cfg: Config = toml::from_str(include_str!("../worker.example.toml")).unwrap();
        assert!(!cfg.roots.is_empty());
        assert!(
            cfg.roots[0]
                .capabilities
                .iter()
                .any(|c| c == "device.files.read")
        );
    }
}
