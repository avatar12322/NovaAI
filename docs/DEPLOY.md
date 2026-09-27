# Wdrożenie na VPS — lista zebranych rzeczy

Zbierane punkt po punkcie przed pierwszym wdrożeniem. **Bez sekretów** — klucze i hasła są wyłącznie w `.env`
na serwerze właściciela.

## 1. Domena i serwer — gotowe (2026-09-27)

- Domena `novaai.pl` (OVH); aplikacja pod `https://novaai.pl`, `www.novaai.pl` → przekierowanie.
  DNS: `A novaai.pl → 57.128.208.117`, `A www.novaai.pl → 57.128.208.117`; bez AAAA (IPv6 serwera
  `2001:41d0:601:1100::1c25` działa w systemie — AAAA dopiero po sprawdzeniu połączenia przez IPv6).
- VPS OVH VPS-1 (2 vCPU, 4 GB RAM, 40 GB), Warszawa, Ubuntu 24.04 LTS, automatyczna kopia OVH „Standard”.
  Logowanie: `ssh ubuntu@novaai.pl` kluczem ED25519 (bez hasła). Odnowienie VPS: ręczne — pilnować terminu.
- Przy wdrożeniu: `NOVA_WEB_ORIGIN=https://novaai.pl`, `NOVA_RP_ID=novaai.pl` (klucze dostępu przypisane do
  domeny), `NOVA_TRUST_PROXY=1`; Caddy z certyfikatem Let's Encrypt; zapora: 22, 80, 443.

## 2. Budżet — gotowe (2026-09-27)

- Modele (Anthropic): ostrzeżenie 40 zł, twardy limit 50 zł miesięcznie — ustawiane w aplikacji
  (Ustawienia → Koszt modeli), osobno na serwerze po wdrożeniu (inna baza niż lokalna).
- ElevenLabs: plan Creator (121 000 kredytów miesięcznie, wspólna pula dla wszystkich usług ElevenLabs).
  Wg cennika ElevenLabs: Flash v2.5 ok. 0,5 kredytu za znak (w API 0,5–1), rozpoznawanie mowy 330 kredytów
  za minutę. W `.env`: `ELEVENLABS_MONTHLY_CHARS=100000` (≤ 100 000 kredytów nawet przy 1 kredycie za znak),
  `ELEVENLABS_STT_MONTHLY_MINUTES=60` (≈ 19 800 kredytów). Razem w najgorszym razie ok. 120 000 kredytów.

## Dalej (do zebrania)

- [ ] Google: klient OAuth (Gmail, Kalendarz) — redirect `https://novaai.pl/api/connections/google/callback`
- [ ] Microsoft: aplikacja w Entra — redirect `https://novaai.pl/api/connections/microsoft/callback`
- [ ] Slack: aplikacja wewnętrzna — redirect `https://novaai.pl/api/connections/slack/callback`
- [ ] Home Assistant (adres i token) — jeśli jest
- [ ] Wyszukiwanie w internecie — decyzja (płatne)
- [ ] Worker na Windows, słowo wybudzające
- [ ] Spotify (opcjonalnie)
