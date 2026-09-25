# NovaAI Worker (Windows)

Program działający na komputerze domownika. Łączy się **wychodząco** z serwerem NovaAI (WebSocket, TLS),
nie wystawia żadnego portu i wykonuje wyłącznie podpisane polecenia z listy:

| Zdolność                                | Wymagany grant       | Opis                                                                                                                        |
| --------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `device.files.list`                     | `device.files.read`  | lista katalogu (maks. 1000 pozycji)                                                                                         |
| `device.files.read`                     | `device.files.read`  | odczyt pliku ≤ 256 KB, z SHA-256                                                                                            |
| `device.files.write`                    | `device.files.write` | zapis ≤ 512 KB **tylko po zgodzie w aplikacji**, z kontrolą `baseSha256`, kopią zapasową w katalogu stanu i atomową zamianą |
| `device.git.status` / `device.git.diff` | `device.git.read`    | `git status --porcelain` / `git diff` bez powłoki, limit 10 s                                                               |

Brak: dowolnych poleceń, PowerShell, uruchamiania programów, zrzutów ekranu, UI Automation (kolejne etapy
specyfikacji — każdy wymaga osobnej polityki i zgody).

## Model bezpieczeństwa

- Klucz Ed25519 urządzenia jest generowany lokalnie (`state_dir/device.key`) i nigdy nie opuszcza urządzenia.
  Parowanie jednorazowym kodem z aplikacji (10 min); serwer zapisuje tylko klucz publiczny.
- Klucz publiczny serwera jest przypinany przy parowaniu; polecenia i granty bez ważnego podpisu są ignorowane.
- Polecenie jest wykonywane, gdy: podpis serwera OK, `deviceId` zgodny, termin nieminiony, klucz idempotencji
  nowy (powtórka zwraca zapisany wynik), a **kanoniczna** ścieżka (po rozwiązaniu symlinków/junctions) leży
  w części wspólnej: katalog z `worker.toml` (z daną zdolnością) ∩ podpisany grant serwera. Serwer może tylko
  zawęzić dostęp. Odrzucane są: `..`, ścieżki względne, `\\?\`, `\\.\`, UNC, strumienie ADS (`plik:ads`),
  nazwy zarezerwowane (`CON`, `NUL`, `COM1`…), segmenty kończące się kropką/spacją, zapis przez symlink/reparse point.
- Serwer (DeviceBroker) sprawdza właściciela, grant i katalog **przed wysłaniem**; odłączenie urządzenia w aplikacji
  zamyka połączenie (kod 4403) i Worker kończy działanie bez ponownego łączenia.
- Znane ograniczenie: `device.key` to zwykły plik w profilu użytkownika — do zrobienia ochrona DPAPI.

## Budowanie

```powershell
# Windows (MSVC toolchain): rustup default stable-x86_64-pc-windows-msvc
cargo build --release
# wynik: target\release\nova-worker.exe
```

Linux/macOS (rozwój): `cargo build`, `cargo test`, `cargo clippy --all-targets -- -D warnings`.
Kontrola kompilacji kodu Windows z Linuksa (bez TLS, bez kompilatora C):
`cargo check --target x86_64-pc-windows-gnu --all-targets --no-default-features`.

## Uruchomienie

1. Skopiuj `worker.example.toml` do `worker.toml`, ustaw `server` (https) i katalogi `[[roots]]`.
2. W aplikacji: Ustawienia → Urządzenia → „Sparuj urządzenie” → skopiuj kod.
3. `nova-worker.exe pair --config worker.toml --code ABCD-EFGH`
4. `nova-worker.exe run --config worker.toml`
5. W aplikacji nadaj granty (katalog + zdolność). Sprawdzenie lokalne: `nova-worker.exe check --config worker.toml --path C:\...`

## Test ręczny na Windows (niewykonany w sesji deweloperskiej — brak Windows)

Wykonaj na katalogu testowym, np. `C:\nova-test\projekt` (utwórz też `C:\nova-test\poza\tajne.txt`):

1. `cargo test` — w tym `policy::tests::rejects_junction_escape` (tworzy junction `mklink /J`), oczekiwany wynik: ok.
2. Sparuj i uruchom Workera jak wyżej; nadaj grant `device.files.read` na `C:\nova-test\projekt`.
3. W czacie prywatnym (tryb demo): `pliki: C:\nova-test\projekt` → lista plików w rozmowie.
4. Junction: `mklink /J C:\nova-test\projekt\wyjscie C:\nova-test\poza`, potem `przeczytaj: C:\nova-test\projekt\wyjscie\tajne.txt`
   → oczekiwana odmowa `worker:path_outside_root`.
5. ADS: `przeczytaj: C:\nova-test\projekt\a.txt:ukryty` → odmowa już w brokerze (`path_outside_grant`/400).
6. Nadaj `device.files.write`, w czacie: `zapisz C:\nova-test\projekt\a.txt: nowa treść` → w Zgodach widoczny diff;
   zatwierdź → plik zmieniony, kopia w `%LOCALAPPDATA%\NovaWorker\backups`.
7. Zmień plik ręcznie między podglądem a zatwierdzeniem → oczekiwana odmowa `base_changed`, plik nietknięty.
8. Ustawienia → Urządzenia → „Odłącz” → proces Workera kończy się komunikatem o kodzie 4403.
