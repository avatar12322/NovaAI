//! Weryfikacja i wykonanie poleceń: podpis serwera, urządzenie, termin, idempotencja,
//! zdolność (lokalna polityka ∩ podpisane granty), kanoniczna ścieżka, operacja, podpisany wynik.

use chrono::{DateTime, Utc};
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde_json::{Value, json};

use crate::fsops;
use crate::git;
use crate::policy::{Deny, LocalPolicy};
use crate::protocol::{
    self, CommandPayload, Grant, GrantsPayload, PROTOCOL_VERSION, ResultPayload,
};
use crate::state::IdempotencyCache;

pub struct Executor {
    pub device_id: String,
    pub device_key: SigningKey,
    pub server_key: VerifyingKey,
    pub policy: LocalPolicy,
    pub grants: Vec<Grant>,
    pub backup_dir: std::path::PathBuf,
    pub idem: IdempotencyCache,
    /// Odrzucone ramki (diagnostyka/testy) — bez treści.
    pub rejected: Vec<String>,
}

pub enum Outcome {
    /// Podpisana ramka wyniku do odesłania.
    Reply(String),
    /// Ramka odrzucona bez odpowiedzi (np. zły podpis serwera).
    Ignored,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Executor {
    /// Aktualizacja grantów tylko z ważnym podpisem serwera i dla tego urządzenia.
    pub fn handle_grants(&mut self, payload: &str, sig: &str) -> bool {
        if !protocol::verify_text(&self.server_key, payload, sig) {
            self.rejected.push("grants_bad_signature".into());
            return false;
        }
        match serde_json::from_str::<GrantsPayload>(payload) {
            Ok(g) if g.v == PROTOCOL_VERSION && g.device_id == self.device_id => {
                self.grants = g.grants;
                true
            }
            _ => {
                self.rejected.push("grants_bad_payload".into());
                false
            }
        }
    }

    pub async fn handle_command(&mut self, payload: &str, sig: &str) -> Outcome {
        if !protocol::verify_text(&self.server_key, payload, sig) {
            self.rejected.push("bad_signature".into());
            return Outcome::Ignored;
        }
        let cmd: CommandPayload = match serde_json::from_str(payload) {
            Ok(c) => c,
            Err(_) => {
                self.rejected.push("bad_payload".into());
                return Outcome::Ignored;
            }
        };
        let result = self.execute(&cmd).await;
        let (status, output, error) = match result {
            Ok(out) => ("ok", Some(out), None),
            Err(ExecError::Denied(reason)) => {
                self.rejected.push(reason.clone());
                ("denied", None, Some(reason))
            }
            Err(ExecError::Failed(e)) => ("error", None, Some(e)),
            Err(ExecError::Replay(prev)) => {
                let mut out = prev.output.clone().unwrap_or_else(|| json!({}));
                if let Some(o) = out.as_object_mut() {
                    o.insert("replay".into(), Value::Bool(true));
                }
                (
                    if prev.status == "ok" { "ok" } else { "error" },
                    Some(out),
                    prev.error.clone(),
                )
            }
        };
        let res = ResultPayload {
            v: PROTOCOL_VERSION,
            command_id: cmd.command_id.clone(),
            idempotency_key: cmd.idempotency_key.clone(),
            status: status.into(),
            output,
            error,
            completed_at: now_iso(),
        };
        if res.status == "ok" && res.output.as_ref().and_then(|o| o.get("replay")).is_none() {
            self.idem.put(cmd.idempotency_key.clone(), res.clone());
        }
        let text = serde_json::to_string(&res).expect("serializacja wyniku");
        let sig = protocol::sign_text(&self.device_key, &text);
        let frame = serde_json::to_string(&protocol::WorkerFrame::Result { payload: text, sig })
            .expect("ramka");
        Outcome::Reply(frame)
    }

    async fn execute(&mut self, cmd: &CommandPayload) -> Result<Value, ExecError> {
        if cmd.v != PROTOCOL_VERSION {
            return Err(ExecError::Denied("protocol_version".into()));
        }
        if cmd.device_id != self.device_id {
            return Err(ExecError::Denied("wrong_device".into()));
        }
        let deadline = DateTime::parse_from_rfc3339(&cmd.deadline)
            .map_err(|_| ExecError::Denied("bad_deadline".into()))?;
        if deadline.with_timezone(&Utc) < Utc::now() {
            return Err(ExecError::Denied("expired".into()));
        }
        if cmd.idempotency_key.len() < 8 {
            return Err(ExecError::Denied("bad_idempotency_key".into()));
        }
        if let Some(prev) = self.idem.get(&cmd.idempotency_key) {
            return Err(ExecError::Replay(Box::new(prev.clone())));
        }
        let grant = protocol::grant_for(&cmd.capability)
            .ok_or_else(|| ExecError::Denied("unknown_capability".into()))?;
        let p = &cmd.params;
        let str_param = |k: &str| {
            p.get(k)
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .ok_or_else(|| ExecError::Denied("invalid_params".into()))
        };
        match cmd.capability.as_str() {
            "device.files.list" => {
                let dir = self.resolve(&str_param("path")?, grant, false)?;
                fsops::list(&dir).map_err(|e| ExecError::Failed(e.to_string()))
            }
            "device.files.read" => {
                let file = self.resolve(&str_param("path")?, grant, false)?;
                fsops::read(&file).map_err(fs_to_exec)
            }
            "device.files.write" => {
                let path = str_param("path")?;
                let content = str_param("content")?;
                let base = match p.get("baseSha256") {
                    Some(Value::Null) => None,
                    Some(Value::String(s))
                        if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) =>
                    {
                        Some(s.clone())
                    }
                    _ => return Err(ExecError::Denied("invalid_params".into())),
                };
                let file = self.resolve(&path, grant, true)?;
                fsops::write(&file, &content, base.as_deref(), &self.backup_dir).map_err(fs_to_exec)
            }
            "device.git.status" | "device.git.diff" => {
                let repo = self.resolve(&str_param("repoPath")?, grant, false)?;
                git::run(&repo, &cmd.capability)
                    .await
                    .map_err(ExecError::Failed)
            }
            _ => Err(ExecError::Denied("unknown_capability".into())),
        }
    }

    fn resolve(
        &self,
        path: &str,
        grant: &str,
        for_write: bool,
    ) -> Result<std::path::PathBuf, ExecError> {
        self.policy
            .resolve(path, grant, &self.grants, for_write)
            .map_err(|d| match d {
                Deny::NotFound => ExecError::Failed("not_found".into()),
                other => ExecError::Denied(other.to_string()),
            })
    }
}

enum ExecError {
    Denied(String),
    Failed(String),
    Replay(Box<ResultPayload>),
}

fn fs_to_exec(e: fsops::FsError) -> ExecError {
    match e {
        fsops::FsError::BaseChanged | fsops::FsError::FileTooLarge | fsops::FsError::NotAFile => {
            ExecError::Denied(e.to_string())
        }
        other => ExecError::Failed(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::LocalRoot;
    use crate::protocol::sign_text;
    use std::fs;

    struct Fx {
        _t: tempfile::TempDir,
        root: std::path::PathBuf,
        server: SigningKey,
        exec: Executor,
    }

    fn fx(local_caps: &[&str]) -> Fx {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("projekt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "v1").unwrap();
        let server = SigningKey::from_bytes(&[1u8; 32]);
        let exec = Executor {
            device_id: "11111111-1111-4111-8111-111111111111".into(),
            device_key: SigningKey::from_bytes(&[2u8; 32]),
            server_key: server.verifying_key(),
            policy: LocalPolicy {
                roots: vec![LocalRoot {
                    path: root.clone(),
                    capabilities: local_caps.iter().map(|s| s.to_string()).collect(),
                }],
            },
            grants: vec![],
            backup_dir: t.path().join("state/backups"),
            idem: IdempotencyCache::default(),
            rejected: vec![],
        };
        Fx {
            _t: t,
            root,
            server,
            exec,
        }
    }

    fn grants(f: &mut Fx, caps: &[&str]) {
        let payload = serde_json::json!({
            "v": 1, "deviceId": f.exec.device_id, "issuedAt": now_iso(),
            "grants": caps.iter().map(|c| serde_json::json!({"capability": c, "root": f.root.to_string_lossy()})).collect::<Vec<_>>()
        })
        .to_string();
        let sig = sign_text(&f.server, &payload);
        assert!(f.exec.handle_grants(&payload, &sig));
    }

    fn command(
        f: &Fx,
        capability: &str,
        params: Value,
        key: &str,
        deadline_secs: i64,
    ) -> (String, String) {
        let payload = serde_json::json!({
            "v": 1, "commandId": "22222222-2222-4222-8222-222222222222", "deviceId": f.exec.device_id,
            "taskId": null, "capability": capability, "params": params, "idempotencyKey": key,
            "issuedAt": now_iso(),
            "deadline": (Utc::now() + chrono::Duration::seconds(deadline_secs)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .to_string();
        let sig = sign_text(&f.server, &payload);
        (payload, sig)
    }

    async fn result(f: &mut Fx, payload: &str, sig: &str) -> Option<ResultPayload> {
        match f.exec.handle_command(payload, sig).await {
            Outcome::Reply(frame) => {
                let v: Value = serde_json::from_str(&frame).unwrap();
                let text = v["payload"].as_str().unwrap();
                // Wynik podpisany kluczem urządzenia.
                assert!(protocol::verify_text(
                    &f.exec.device_key.verifying_key(),
                    text,
                    v["sig"].as_str().unwrap()
                ));
                Some(serde_json::from_str(text).unwrap())
            }
            Outcome::Ignored => None,
        }
    }

    #[tokio::test]
    async fn reads_file_with_valid_signature_and_grant() {
        let mut f = fx(&["device.files.read"]);
        grants(&mut f, &["device.files.read"]);
        let (p, s) = command(
            &f,
            "device.files.read",
            serde_json::json!({"path": f.root.join("a.txt")}),
            "key-read-0001",
            30,
        );
        let r = result(&mut f, &p, &s).await.unwrap();
        assert_eq!(r.status, "ok");
        assert_eq!(r.output.unwrap()["content"], "v1");
    }

    #[tokio::test]
    async fn ignores_forged_command_and_grants() {
        let mut f = fx(&["device.files.read"]);
        let forged = SigningKey::from_bytes(&[9u8; 32]);
        let (p, _) = command(
            &f,
            "device.files.read",
            serde_json::json!({"path": f.root.join("a.txt")}),
            "key-forged-01",
            30,
        );
        assert!(result(&mut f, &p, &sign_text(&forged, &p)).await.is_none());
        assert!(f.exec.rejected.contains(&"bad_signature".to_string()));
        let gp = serde_json::json!({"v":1,"deviceId":f.exec.device_id,"issuedAt":now_iso(),"grants":[{"capability":"device.files.read","root":"/"}]}).to_string();
        assert!(!f.exec.handle_grants(&gp, &sign_text(&forged, &gp)));
        assert!(f.exec.grants.is_empty());
    }

    #[tokio::test]
    async fn denies_expired_wrong_device_and_ungranted() {
        let mut f = fx(&["device.files.read"]);
        grants(&mut f, &["device.files.read"]);
        let (p, s) = command(
            &f,
            "device.files.read",
            serde_json::json!({"path": f.root.join("a.txt")}),
            "key-expired-1",
            -5,
        );
        assert_eq!(
            result(&mut f, &p, &s).await.unwrap().error.as_deref(),
            Some("expired")
        );
        let other = serde_json::from_str::<Value>(&p).unwrap();
        let mut other = other.as_object().unwrap().clone();
        other.insert(
            "deviceId".into(),
            Value::String("33333333-3333-4333-8333-333333333333".into()),
        );
        other.insert(
            "deadline".into(),
            Value::String((Utc::now() + chrono::Duration::seconds(30)).to_rfc3339()),
        );
        let op = Value::Object(other).to_string();
        let op_sig = sign_text(&f.server, &op);
        let r = result(&mut f, &op, &op_sig).await.unwrap();
        assert_eq!(r.error.as_deref(), Some("wrong_device"));
        // Zapis: grant serwera istnieje? Nie — i lokalna polityka też go nie ma.
        let (p, s) = command(
            &f,
            "device.files.write",
            serde_json::json!({"path": f.root.join("b.txt"), "content": "x", "baseSha256": null}),
            "key-write-01",
            30,
        );
        let r = result(&mut f, &p, &s).await.unwrap();
        assert_eq!(r.status, "denied");
        assert_eq!(r.error.as_deref(), Some("capability_not_in_local_policy"));
    }

    #[tokio::test]
    async fn server_grant_cannot_extend_local_policy() {
        let mut f = fx(&["device.files.read"]);
        grants(&mut f, &["device.files.read", "device.files.write"]);
        let (p, s) = command(
            &f,
            "device.files.write",
            serde_json::json!({"path": f.root.join("b.txt"), "content": "x", "baseSha256": null}),
            "key-write-02",
            30,
        );
        let r = result(&mut f, &p, &s).await.unwrap();
        assert_eq!(r.error.as_deref(), Some("capability_not_in_local_policy"));
        assert!(!f.root.join("b.txt").exists());
    }

    #[tokio::test]
    async fn idempotent_write_is_not_repeated() {
        let mut f = fx(&["device.files.read", "device.files.write"]);
        grants(&mut f, &["device.files.write"]);
        let target = f.root.join("nowy.txt");
        let (p, s) = command(
            &f,
            "device.files.write",
            serde_json::json!({"path": target, "content": "A", "baseSha256": null}),
            "key-idem-0001",
            30,
        );
        assert_eq!(result(&mut f, &p, &s).await.unwrap().status, "ok");
        fs::write(&target, "zmiana ręczna").unwrap();
        let again = result(&mut f, &p, &s).await.unwrap();
        assert_eq!(again.status, "ok");
        assert_eq!(again.output.unwrap()["replay"], true);
        assert_eq!(fs::read_to_string(&target).unwrap(), "zmiana ręczna");
    }
}
