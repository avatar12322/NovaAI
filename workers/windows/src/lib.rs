//! NovaAI Worker — rdzeń niezależny od platformy + elementy specyficzne dla Windows (cfg(windows)).
pub mod client;
pub mod config;
pub mod executor;
pub mod fsops;
pub mod git;
pub mod policy;
pub mod protocol;
pub mod state;
