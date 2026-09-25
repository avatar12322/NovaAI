# Prompt startowy do Claude Code

Otwórz w Claude Code repozytorium, w którym znajduje się `MASTER_SPEC.md`, i wklej **całą poniższą wiadomość**. Najpierw wybierz środowisko `Remote` dla pracy po wyłączeniu PC (repo musi być dostępne w sesji zdalnej) albo `Local`, jeśli komputer pozostanie włączony i nie przejdzie w uśpienie. Nie wybieraj trybu `Plan`, jeżeli chcesz, aby od razu edytował kod. Nie obchodź pytań o uprawnienia ustawieniami typu bypass.

--- POCZĄTEK PROMPTU ---

Jesteś agentem implementującym NovaAI. Przeczytaj w całości `MASTER_SPEC.md`, następnie instrukcje repo i jego aktualny stan. To zadanie ma zająć wiele iteracji, nie tylko przygotowanie planu lub jednego ekranu. Zacznij implementację TERAZ i pracuj samodzielnie przez tę sesję: wykonuj kolejno M0, M1, M2, M3 i dalsze etapy, jeśli pozwala środowisko. Po każdym etapie i każdej pionowej funkcji uruchom testy, usuń usterki, aktualizuj `docs/PROGRESS.md` i przechodź do następnej rzeczy bez pytania mnie o małe decyzje. Celem jest maksymalna liczba ukończonych, działających funkcji, a nie liczba plików ani długość sesji.

Jestem teraz niedostępny i idę spać. Nie czekaj na odpowiedź. Jeśli brakuje kluczy, OAuth, infrastruktury lub Windowsa w sesji zdalnej, wdrażaj poprawny lokalny rdzeń, adaptery i testy, oznacz te części jako nieuruchomione i wykonuj pozostałe zadania. Nie wymyślaj tokenów ani nie wstawiaj placeholdera tak, żeby udawał działającą integrację. Nie uruchamiaj płatnych API ani nie podejmuj działań na moich kontach. Pracuj tylko wewnątrz projektu, na nowej gałęzi Git jeśli repo na to pozwala. Nie pushuj, nie wdrażaj i nie wysyłaj nic do osób trzecich. Zachowaj wszystkie zastane zmiany.

Najpierw wykonaj rozpoznanie w kilku minutach i zanotuj decyzje. Następnie buduj, zamiast pisać kolejne spekulatywne specyfikacje. Priorytet: działający backend i UI, trwałość danych, udowodniona izolacja prywatnych/wspólnych danych, trwałe zadania i zgody; integracje i Windows Worker po bezpiecznym rdzeniu. Jeśli poprzednia architektura ma nieaktualne lub niewykonalne szczegóły, zweryfikuj je w oficjalnych dokumentach i zapisz uzasadnioną zmianę w `docs/DECISIONS.md`.

Prowadź czytelny dziennik w `docs/PROGRESS.md`: ukończone funkcje, uruchomione komendy i ich wyniki, błędy, blokady, następne kroki. Kiedy kontekst się skompaktuje, najpierw odczytaj ten dziennik i `MASTER_SPEC.md`, a potem kontynuuj. Nie kończ po pierwszym sukcesie; zakończ dopiero po rzeczywistej blokadzie, limicie sesji albo ukończeniu możliwego zakresu. Końcowy raport ma jasno odróżniać uruchomione i przetestowane elementy od szkieletów oraz wskazać jak odpalić projekt.

--- KONIEC PROMPTU ---

## Ważne przed uruchomieniem

- `Remote`: projekt musi być w repozytorium dostępnym dla zdalnej sesji; pliki istniejące tylko na lokalnym dysku Windows nie będą tam widoczne. Taka sesja może pracować po zamknięciu aplikacji/wyłączeniu PC.
- `Local`: Claude pracuje na lokalnych plikach; komputer musi pozostać włączony i nieuśpiony, a sesja nie może zostać przerwana.
- Długiej pracy nie da się zagwarantować samym promptem: ograniczają ją limity planu, uprawnienia, dostępne środowisko i faktyczne blokady. `docs/PROGRESS.md` umożliwia wznowienie bez zgadywania, co zostało zrobione.
