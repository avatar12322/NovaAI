//! Protokół Worker ↔ DeviceBroker, wersja 1 (lustrzany do `packages/contracts/src/worker.ts`).
//!
//! Podpis Ed25519 obejmuje DOKŁADNE bajty pola `payload` (string JSON) — bez kanonikalizacji.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::ed25519::Signature;
use ed25519_dalek::ed25519::signature::Signer;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerFrame {
    Challenge {
        nonce: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    Welcome {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
    Command {
        payload: String,
        sig: String,
    },
    Grants {
        payload: String,
        sig: String,
    },
    Ack {
        #[serde(rename = "commandId")]
        command_id: String,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkerFrame {
    Hello {
        #[serde(rename = "deviceId")]
        device_id: String,
        nonce: String,
        sig: String,
        #[serde(rename = "workerVersion")]
        worker_version: String,
        platform: String,
    },
    Result {
        payload: String,
        sig: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPayload {
    pub v: u32,
    pub command_id: String,
    pub device_id: String,
    pub task_id: Option<String>,
    pub capability: String,
    pub params: serde_json::Value,
    pub idempotency_key: String,
    pub issued_at: String,
    pub deadline: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Grant {
    pub capability: String,
    pub root: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantsPayload {
    pub v: u32,
    pub device_id: String,
    pub issued_at: String,
    pub grants: Vec<Grant>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultPayload {
    pub v: u32,
    pub command_id: String,
    pub idempotency_key: String,
    pub status: String,
    pub output: Option<serde_json::Value>,
    pub error: Option<String>,
    pub completed_at: String,
}

pub fn hello_message(device_id: &str, nonce: &str) -> String {
    format!("nova-worker-hello-v1|{device_id}|{nonce}")
}

pub fn sign_text(key: &SigningKey, text: &str) -> String {
    let sig: Signature = key.sign(text.as_bytes());
    B64.encode(sig.to_bytes())
}

/// Weryfikacja ścisła (verify_strict) — odrzuca słabe klucze i niekanoniczne podpisy.
pub fn verify_text(key: &VerifyingKey, text: &str, sig_b64: &str) -> bool {
    let Ok(raw) = B64.decode(sig_b64) else {
        return false;
    };
    let Ok(bytes): Result<[u8; 64], _> = raw.try_into() else {
        return false;
    };
    let sig = Signature::from_bytes(&bytes);
    key.verify_strict(text.as_bytes(), &sig).is_ok()
}

pub fn verifying_key_from_b64(b64: &str) -> Option<VerifyingKey> {
    let raw = B64.decode(b64).ok()?;
    let bytes: [u8; 32] = raw.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

pub fn public_key_b64(key: &SigningKey) -> String {
    B64.encode(key.verifying_key().to_bytes())
}

/// Grant wymagany przez zdolność (jak `GRANT_FOR` w kontraktach TS).
pub fn grant_for(capability: &str) -> Option<&'static str> {
    match capability {
        "device.files.list" | "device.files.read" => Some("device.files.read"),
        "device.files.write" => Some("device.files.write"),
        "device.git.status" | "device.git.diff" => Some("device.git.read"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_roundtrip_and_tamper() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let sig = sign_text(&key, "{\"a\":1}");
        let vk = key.verifying_key();
        assert!(verify_text(&vk, "{\"a\":1}", &sig));
        assert!(!verify_text(&vk, "{\"a\":2}", &sig));
        assert!(!verify_text(&vk, "{\"a\":1}", "AAAA"));
        let other = SigningKey::from_bytes(&[8u8; 32]).verifying_key();
        assert!(!verify_text(&other, "{\"a\":1}", &sig));
    }

    #[test]
    fn parses_server_frames() {
        let f: ServerFrame =
            serde_json::from_str(r#"{"type":"challenge","nonce":"abc","protocolVersion":1}"#)
                .unwrap();
        assert!(matches!(
            f,
            ServerFrame::Challenge {
                protocol_version: 1,
                ..
            }
        ));
        let f: ServerFrame =
            serde_json::from_str(r#"{"type":"command","payload":"{}","sig":"x"}"#).unwrap();
        assert!(matches!(f, ServerFrame::Command { .. }));
    }

    #[test]
    fn hello_frame_serializes_like_ts_contract() {
        let f = WorkerFrame::Hello {
            device_id: "d".into(),
            nonce: "n".into(),
            sig: "s".into(),
            worker_version: "1".into(),
            platform: "windows".into(),
        };
        let v: serde_json::Value = serde_json::to_value(&f).unwrap();
        assert_eq!(v["type"], "hello");
        assert_eq!(v["deviceId"], "d");
        assert_eq!(v["workerVersion"], "1");
    }
}
