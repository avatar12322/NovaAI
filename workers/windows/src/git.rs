//! Git tylko do odczytu, stałe argumenty, bez powłoki, z limitem czasu i rozmiaru wyjścia.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 256 * 1024;

pub async fn run(repo: &Path, kind: &str) -> Result<Value, String> {
    let repo_s = repo.to_string_lossy().into_owned();
    let args: Vec<&str> = match kind {
        "device.git.status" => vec!["-C", &repo_s, "status", "--porcelain=v1", "--branch"],
        "device.git.diff" => vec!["-C", &repo_s, "diff", "--no-color", "--no-ext-diff"],
        _ => return Err("unknown_git_command".into()),
    };
    let mut cmd = Command::new("git");
    cmd.args(&args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // Bez okna konsoli; SystemRoot potrzebny części narzędzi Windows.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Some(v) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", v);
        }
    }
    let out = tokio::time::timeout(TIMEOUT, cmd.output())
        .await
        .map_err(|_| "git_timeout".to_string())?
        .map_err(|_| "git_not_available".to_string())?;
    if !out.status.success() {
        return Err(format!(
            "git_failed: {}",
            String::from_utf8_lossy(&out.stderr)
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if s.len() > MAX_OUTPUT {
        s.truncate(MAX_OUTPUT);
        s.push_str("\n… (skrócono)");
    }
    Ok(json!({ "output": s }))
}
