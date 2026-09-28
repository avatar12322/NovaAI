import type { FastifyPluginAsync } from 'fastify';
import type { AppDeps } from '../deps';

/**
 * Polityka prywatności i warunki korzystania — publiczne strony pod /privacy i /terms (bez logowania).
 * Google wymaga ich przy publikacji aplikacji OAuth: ta sama domena co strona główna, link z ekranu zgody
 * i ze strony głównej, opis dostępu do danych Google i oświadczenie „Limited Use”. Treść musi zgadzać się
 * z tym, co aplikacja naprawdę robi — przy zmianie integracji (np. włączeniu Microsoft/Slack) zaktualizuj
 * treść i UPDATED.
 */
const UPDATED = '27 września 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function contact(email: string): string {
  return email
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : 'właściciel domu (osoba, która zaprosiła Cię do NovaAI)';
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — NovaAI</title>
<style>
  :root { color-scheme: light dark; --bg: #fbfaf7; --text: #1d1d1b; --muted: #5d5b55; --link: #2451c4; --line: #e3e0d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #171716; --text: #ecebe6; --muted: #a9a79f; --link: #8fb0ff; --line: #33322f; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.75rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  p, li { color: var(--text); }
  .muted { color: var(--muted); font-size: .9rem; }
  a { color: var(--link); }
  nav { display: flex; gap: .25rem 1rem; flex-wrap: wrap; padding-bottom: 1rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
  section[lang="en"] { border-top: 1px solid var(--line); margin-top: 2.5rem; }
</style>
</head>
<body>
<main>
<nav><a href="/">NovaAI</a><a href="/privacy">Polityka prywatności</a><a href="/terms">Warunki korzystania</a></nav>
${body}
</main>
</body>
</html>`;
}

function privacy(publicUrl: string, email: string): string {
  const who = contact(email);
  return page(
    'Polityka prywatności',
    `<h1>Polityka prywatności</h1>
<p class="muted">Ostatnia aktualizacja: ${UPDATED}</p>

<h2>Kto przetwarza dane</h2>
<p>NovaAI (${esc(publicUrl)}) to prywatna aplikacja asystenta AI dla członków jednego gospodarstwa domowego.
Prowadzi ją osoba prywatna — właściciel domu — która jest administratorem danych. To nie jest usługa
komercyjna ani publiczna: konta powstają wyłącznie z zaproszenia właściciela. Kontakt: ${who}.</p>

<h2>Jakie dane przetwarzamy</h2>
<ul>
  <li><strong>Konto:</strong> imię, adres e-mail (identyfikator konta) i klucze dostępu (passkey) — serwer
    przechowuje tylko ich część publiczną; aplikacja nie używa haseł.</li>
  <li><strong>Treści w aplikacji:</strong> rozmowy z asystentem, pamięć, dokumenty, przypomnienia, zadania,
    kalendarz lokalny i wgrany plan zajęć.</li>
  <li><strong>Połączone konto Google</strong> — opisane niżej.</li>
  <li><strong>Dane techniczne:</strong> ciasteczko sesji (niezbędne do logowania) i dziennik zdarzeń
    bezpieczeństwa (np. logowanie, zatwierdzenia) bez treści wiadomości. Aplikacja nie używa narzędzi
    analitycznych, reklam ani śledzenia.</li>
</ul>

<h2>Dane z Google (Gmail i Kalendarz)</h2>
<p>Połączenie konta Google jest dobrowolne i dotyczy tylko osoby, która je połączyła. Aplikacja prosi
o uprawnienia:</p>
<ul>
  <li><code>gmail.readonly</code> — wyszukanie i odczyt wiadomości, <strong>tylko gdy poprosisz o to
    asystenta</strong> (np. „co nowego w poczcie?”). Aplikacja nie skanuje skrzynki w tle i jej nie
    synchronizuje.</li>
  <li><code>gmail.send</code> — wysłanie e-maila w Twoim imieniu, <strong>zawsze dopiero po Twoim
    zatwierdzeniu</strong> treści w aplikacji.</li>
  <li><code>calendar.freebusy</code> — przedziały zajętości (bez tytułów i szczegółów wydarzeń), gdy
    o nie poprosisz albo włączysz udostępnianie zajętości domownikom.</li>
</ul>
<p><strong>Przechowywanie.</strong> Tokeny dostępu Google są zaszyfrowane (AES-256-GCM) w bazie danych na
serwerze w Polsce. Fragmenty wiadomości, które asystent odczytał na Twoją prośbę, zostają zapisane w tej
rozmowie — widzisz je tylko Ty (inni domownicy nie mają do nich dostępu).</p>
<p><strong>Przekazywanie.</strong> Aby odpowiedzieć, asystent przesyła potrzebną treść do dostawcy modelu AI
(Anthropic, USA). Jeśli włączysz odczyt odpowiedzi na głos, tekst odpowiedzi trafia do usługi syntezy mowy
(ElevenLabs). Dane Google nie są sprzedawane, używane do reklam, do trenowania modeli AI przez NovaAI ani
przekazywane nikomu innemu. Nikt nie czyta Twoich danych, chyba że wyrazisz na to zgodę, wymaga tego
bezpieczeństwo (np. wyjaśnienie nadużycia) albo prawo.</p>
<p><strong>Odłączenie.</strong> W aplikacji: Integracje → Odłącz — token jest unieważniany w Google
i usuwany z serwera. Dostęp możesz też cofnąć w <a href="https://myaccount.google.com/permissions">ustawieniach
konta Google</a>.</p>
<p>Wykorzystanie i przekazywanie przez NovaAI informacji otrzymanych z interfejsów API Google jest zgodne
z <a href="https://developers.google.com/terms/api-services-user-data-policy">Zasadami dotyczącymi danych
użytkownika w usługach Google API</a>, w tym z wymaganiami dotyczącymi ograniczonego użytkowania
(Limited Use).</p>

<h2>Inne usługi zewnętrzne</h2>
<ul>
  <li><strong>Anthropic</strong> — model AI generujący odpowiedzi; także wyszukiwanie w internecie, gdy
    asystent potrzebuje aktualnych informacji (do wyszukiwarki trafia samo zapytanie).</li>
  <li><strong>ElevenLabs</strong> — odczyt odpowiedzi na głos oraz rozpoznawanie mowy, gdy przeglądarka
    nie rozpoznaje jej sama (nagranie wypowiedzi jest wtedy wysyłane do ElevenLabs).</li>
  <li><strong>OVH</strong> — serwer i kopie zapasowe (centrum danych w Polsce).</li>
</ul>

<h2>Bezpieczeństwo</h2>
<p>Połączenie szyfrowane (HTTPS), logowanie kluczem dostępu, oddzielenie danych każdej osoby na poziomie
bazy danych, szyfrowanie tokenów i kluczy, zatwierdzanie działań wysyłających dane (np. e-mail).</p>

<h2>Jak długo przechowujemy dane</h2>
<p>Dane są przechowywane do czasu ich usunięcia albo usunięcia konta. Kopie zapasowe bazy są usuwane
automatycznie po 14 dniach. Usunięcie konta i danych — na prośbę: ${who}.</p>

<h2>Twoje prawa</h2>
<p>Masz prawo dostępu do swoich danych, ich sprostowania, usunięcia, ograniczenia przetwarzania,
przeniesienia oraz sprzeciwu — napisz: ${who}. Możesz też złożyć skargę do Prezesa Urzędu Ochrony Danych
Osobowych (<a href="https://uodo.gov.pl">uodo.gov.pl</a>).</p>

<h2>Zmiany</h2>
<p>O istotnych zmianach tej polityki domowników informuje właściciel domu. Data ostatniej zmiany jest na górze
strony.</p>

<section lang="en">
<h2>Summary in English</h2>
<p>NovaAI is a private, invite-only AI assistant for a single household, run by an individual (the household
owner). Contact: ${who}. With your permission it uses Google data as follows: <code>gmail.readonly</code> to
search and read messages only when you ask the assistant; <code>gmail.send</code> to send an email only after
you approve it in the app; <code>calendar.freebusy</code> to read busy intervals (no event details). Google
OAuth tokens are stored encrypted (AES-256-GCM) on a server in Poland; message excerpts the assistant read for
you stay in that conversation, visible only to you. Content needed to answer is sent to the AI model provider
(Anthropic) and, if you enable read-aloud, the reply text to ElevenLabs. Google user data is not sold, not used
for advertising, not used by NovaAI to train AI models and not shared with anyone else. You can disconnect in
the app (Integrations → Disconnect, which revokes the token) or at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>
<p>NovaAI's use and transfer to any other app of information received from Google APIs will adhere to
<a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data
Policy</a>, including the Limited Use requirements.</p>
</section>`,
  );
}

function terms(publicUrl: string, email: string): string {
  const who = contact(email);
  return page(
    'Warunki korzystania',
    `<h1>Warunki korzystania</h1>
<p class="muted">Ostatnia aktualizacja: ${UPDATED}</p>

<h2>Czym jest NovaAI</h2>
<p>NovaAI (${esc(publicUrl)}) to prywatna aplikacja asystenta AI dla członków jednego gospodarstwa domowego,
prowadzona przez osobę prywatną (właściciela domu). Konta powstają wyłącznie z zaproszenia; korzystanie jest
bezpłatne dla zaproszonych osób.</p>

<h2>Zasady</h2>
<ul>
  <li>Konto jest osobiste — nie udostępniaj swojego klucza dostępu ani linku z zaproszenia innym osobom.</li>
  <li>Nie używaj aplikacji niezgodnie z prawem ani do szkodzenia innym.</li>
  <li>Działania wysyłające coś w Twoim imieniu (np. e-mail) wykonują się dopiero po Twoim zatwierdzeniu —
    zanim zatwierdzisz, sprawdź treść.</li>
  <li>Właściciel domu może usunąć konto z domu (np. na prośbę albo przy naruszeniu tych zasad).</li>
</ul>

<h2>Odpowiedzi asystenta</h2>
<p>Odpowiedzi generuje model AI i mogą zawierać błędy. Nie traktuj ich jako porady medycznej, prawnej ani
finansowej; ważne informacje sprawdzaj u źródła.</p>

<h2>Dostępność</h2>
<p>Aplikacja jest udostępniana „tak jak jest”, bez gwarancji ciągłego działania. Mogą zdarzać się przerwy
(np. aktualizacje) i zmiany funkcji. Rób własne kopie ważnych informacji.</p>

<h2>Dane</h2>
<p>Zasady przetwarzania danych, w tym danych z połączonego konta Google, opisuje
<a href="/privacy">Polityka prywatności</a>.</p>

<h2>Kontakt</h2>
<p>${who}</p>`,
  );
}

export const legalRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const { publicUrl, contactEmail } = deps.config;
    const privacyHtml = privacy(publicUrl, contactEmail);
    const termsHtml = terms(publicUrl, contactEmail);
    app.get('/privacy', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(privacyHtml),
    );
    app.get('/terms', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(termsHtml),
    );
  };
