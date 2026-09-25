use std::path::PathBuf;

use clap::{Parser, Subcommand};
use nova_worker::{client, config, state::StateDir};

/// NovaAI Worker: wychodzące połączenie z serwerem NovaAI i wykonywanie wyłącznie dozwolonych poleceń.
#[derive(Parser)]
#[command(name = "nova-worker", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Sparuj urządzenie jednorazowym kodem z aplikacji (Ustawienia → Urządzenia).
    Pair {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        code: String,
    },
    /// Połącz się i obsługuj polecenia (z ponownym łączeniem).
    Run {
        #[arg(long)]
        config: PathBuf,
        /// Zakończ po pierwszym rozłączeniu (testy/diagnostyka).
        #[arg(long)]
        once: bool,
    },
    /// Sprawdź lokalnie, czy ścieżka jest dozwolona przez politykę (bez serwera).
    Check {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        path: String,
        #[arg(long, default_value = "device.files.read")]
        capability: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    match Cli::parse().cmd {
        Cmd::Pair { config: c, code } => {
            let cfg = config::Config::load(&c)?;
            let state = StateDir::new(cfg.state_dir())?;
            let p = client::pair(&cfg.server, &code, &cfg.name, &state).await?;
            println!("Sparowano urządzenie {}", p.device_id);
        }
        Cmd::Run { config: c, once } => client::run(config::Config::load(&c)?, once).await?,
        Cmd::Check {
            config: c,
            path,
            capability,
        } => {
            let cfg = config::Config::load(&c)?;
            let policy = cfg.policy();
            let grant = nova_worker::protocol::grant_for(&capability).unwrap_or("?");
            // Bez serwera: przyjmujemy granty równe katalogom lokalnym.
            let grants: Vec<_> = cfg
                .roots
                .iter()
                .flat_map(|r| {
                    r.capabilities.iter().map(|c| nova_worker::protocol::Grant {
                        capability: c.clone(),
                        root: r.path.to_string_lossy().into(),
                    })
                })
                .collect();
            match policy.resolve(&path, grant, &grants, capability == "device.files.write") {
                Ok(p) => println!("DOZWOLONE: {}", p.display()),
                Err(e) => println!("ODMOWA: {e}"),
            }
        }
    }
    Ok(())
}
