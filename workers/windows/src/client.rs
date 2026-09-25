//! Połączenie wychodzące z serwerem: parowanie (HTTPS) i pętla WebSocket z ponownym łączeniem.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::config::{self, Config};
use crate::executor::{Executor, Outcome};
use crate::protocol::{self, PROTOCOL_VERSION, ServerFrame, WorkerFrame};
use crate::state::{IdempotencyCache, Pairing, StateDir};

pub const WORKER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    code: &'a str,
    name: &'a str,
    platform: &'a str,
    public_key: String,
    protocol_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    device_id: String,
    server_public_key: String,
    protocol_version: u32,
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub async fn pair(
    server: &str,
    code: &str,
    name: &str,
    state: &StateDir,
) -> anyhow::Result<Pairing> {
    config::check_server_url(server)?;
    let key = state.device_key()?;
    let url = format!("{}/api/device-link/pair", server.trim_end_matches('/'));
    let res = reqwest::Client::new()
        .post(url)
        .json(&PairRequest {
            code,
            name,
            platform: platform(),
            public_key: protocol::public_key_b64(&key),
            protocol_version: PROTOCOL_VERSION,
        })
        .send()
        .await?;
    if res.status().as_u16() != 201 {
        anyhow::bail!(
            "Parowanie odrzucone przez serwer (HTTP {})",
            res.status().as_u16()
        );
    }
    let body: PairResponse = res.json().await?;
    if body.protocol_version != PROTOCOL_VERSION {
        anyhow::bail!("Niezgodna wersja protokołu");
    }
    if protocol::verifying_key_from_b64(&body.server_public_key).is_none() {
        anyhow::bail!("Nieprawidłowy klucz serwera");
    }
    let p = Pairing {
        server: server.to_string(),
        device_id: body.device_id,
        server_public_key: body.server_public_key,
    };
    state.save_pairing(&p)?;
    Ok(p)
}

pub enum Disconnect {
    /// Dostęp odebrany (4403) lub uwierzytelnienie nieudane (4401) — nie łączymy ponownie.
    Fatal(String),
    Retry(String),
}

/// Jedna sesja połączenia. Zwraca powód rozłączenia.
pub async fn connect_once(cfg: &Config, state: &StateDir, exec: &mut Executor) -> Disconnect {
    let url = config::ws_url(&cfg.server);
    let (ws, _) = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok(x) => x,
        Err(e) => return Disconnect::Retry(format!("connect: {e}")),
    };
    let (mut tx, mut rx) = ws.split();
    let _ = state;
    while let Some(msg) = rx.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => return Disconnect::Retry(format!("ws: {e}")),
        };
        match msg {
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<ServerFrame>(text.as_str()) else {
                    continue;
                };
                match frame {
                    ServerFrame::Challenge {
                        nonce,
                        protocol_version,
                    } => {
                        if protocol_version != PROTOCOL_VERSION {
                            return Disconnect::Fatal("niezgodna wersja protokołu".into());
                        }
                        let hello = WorkerFrame::Hello {
                            device_id: exec.device_id.clone(),
                            sig: protocol::sign_text(
                                &exec.device_key,
                                &protocol::hello_message(&exec.device_id, &nonce),
                            ),
                            nonce,
                            worker_version: WORKER_VERSION.into(),
                            platform: platform().into(),
                        };
                        let text = serde_json::to_string(&hello).expect("hello");
                        if tx.send(Message::Text(text.into())).await.is_err() {
                            return Disconnect::Retry("send".into());
                        }
                    }
                    ServerFrame::Welcome { .. } => eprintln!("[nova-worker] połączono"),
                    ServerFrame::Grants { payload, sig } => {
                        exec.handle_grants(&payload, &sig);
                    }
                    ServerFrame::Command { payload, sig } => {
                        if let Outcome::Reply(frame) = exec.handle_command(&payload, &sig).await
                            && tx.send(Message::Text(frame.into())).await.is_err()
                        {
                            return Disconnect::Retry("send".into());
                        }
                    }
                    ServerFrame::Ack { .. } => {}
                    ServerFrame::Error { code, .. } => {
                        eprintln!("[nova-worker] błąd serwera: {code}")
                    }
                }
            }
            Message::Ping(p) => {
                let _ = tx.send(Message::Pong(p)).await;
            }
            Message::Close(frame) => {
                let code = frame.as_ref().map(|f| f.code);
                return match code {
                    Some(CloseCode::Library(4401)) => {
                        Disconnect::Fatal("uwierzytelnienie odrzucone (4401)".into())
                    }
                    Some(CloseCode::Library(4403)) => {
                        Disconnect::Fatal("urządzenie odłączone przez właściciela (4403)".into())
                    }
                    _ => Disconnect::Retry("zamknięto".into()),
                };
            }
            _ => {}
        }
    }
    Disconnect::Retry("koniec strumienia".into())
}

pub fn executor(cfg: &Config, state: &StateDir) -> anyhow::Result<Executor> {
    let pairing = state.pairing().ok_or_else(|| {
        anyhow::anyhow!("Urządzenie nie jest sparowane — użyj `nova-worker pair`")
    })?;
    let server_key = protocol::verifying_key_from_b64(&pairing.server_public_key)
        .ok_or_else(|| anyhow::anyhow!("Uszkodzony klucz serwera"))?;
    Ok(Executor {
        device_id: pairing.device_id,
        device_key: state.device_key()?,
        server_key,
        policy: cfg.policy(),
        grants: Vec::new(),
        backup_dir: state.backups(),
        idem: IdempotencyCache::load(state.dir.join("idempotency.json")),
        rejected: Vec::new(),
    })
}

pub async fn run(cfg: Config, once: bool) -> anyhow::Result<()> {
    config::check_server_url(&cfg.server)?;
    let state = StateDir::new(cfg.state_dir())?;
    let mut exec = executor(&cfg, &state)?;
    let mut backoff = 1u64;
    loop {
        // Granty są zawsze odświeżane przez serwer po połączeniu — nie ufamy starym.
        exec.grants.clear();
        match connect_once(&cfg, &state, &mut exec).await {
            Disconnect::Fatal(reason) => anyhow::bail!(reason),
            Disconnect::Retry(reason) => {
                eprintln!("[nova-worker] rozłączono: {reason}; ponowienie za {backoff}s");
                if once {
                    return Ok(());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}
