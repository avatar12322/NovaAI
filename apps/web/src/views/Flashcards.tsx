import { useCallback, useEffect, useState } from 'react';
import { Badge, ErrorNote } from '../components/ui';
import { api, errorText, type FlashCard, type FlashDeck } from '../lib/api';
import { plural } from '../lib/format';

/**
 * Fiszki (metoda Leitnera): talie tworzy asystent z Twoich notatek („zrób fiszki z dokumentu …”).
 * Nauka: pytanie → „Pokaż odpowiedź” → „Umiem” (dłuższa przerwa) albo „Jeszcze nie” (jutro znowu).
 */
export function FlashcardsPanel() {
  const [decks, setDecks] = useState<FlashDeck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [study, setStudy] = useState<{ deck: FlashDeck; cards: FlashCard[]; i: number } | null>(
    null,
  );
  const [shown, setShown] = useState(false);

  const load = useCallback(() => {
    api
      .decks()
      .then((r) => {
        setDecks(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const start = (deck: FlashDeck) =>
    api
      .dueCards(deck.id)
      .then((r) => {
        setStudy({ deck, cards: r.items, i: 0 });
        setShown(false);
      })
      .catch((e: unknown) => setError(errorText(e)));

  const answer = (known: boolean) => {
    if (!study) return;
    const card = study.cards[study.i]!;
    api
      .reviewCard(card.id, known)
      .then(() => {
        setShown(false);
        setStudy({ ...study, i: study.i + 1 });
      })
      .catch((e: unknown) => setError(errorText(e)));
  };

  if (decks && !decks.length && !error) {
    return (
      <section className="panel flashcards" aria-labelledby="flash-title">
        <h2 id="flash-title" className="h-sub">
          Fiszki
        </h2>
        <p className="small muted">
          Poproś asystenta: „zrób fiszki z notatek z …” — przeczyta dokument i przygotuje pytania do
          nauki. Powtórki podpowiem w porannym przeglądzie dnia.
        </p>
      </section>
    );
  }

  const card = study ? study.cards[study.i] : undefined;
  return (
    <section className="panel flashcards" aria-labelledby="flash-title">
      <h2 id="flash-title" className="h-sub">
        Fiszki
      </h2>
      {error && <ErrorNote error={error} onRetry={load} />}
      {study ? (
        <div className="study" role="region" aria-label={`Nauka: ${study.deck.title}`}>
          <div className="row between">
            <strong>{study.deck.title}</strong>
            <span className="small muted">
              {Math.min(study.i + 1, study.cards.length)} / {study.cards.length}
            </span>
          </div>
          {card ? (
            <>
              <div className="flash-card" aria-live="polite">
                <p className="flash-front">{card.front}</p>
                {shown && <p className="flash-back">{card.back}</p>}
              </div>
              {shown ? (
                <div className="row">
                  <button type="button" className="btn btn-primary" onClick={() => answer(true)}>
                    Umiem
                  </button>
                  <button type="button" className="btn" onClick={() => answer(false)}>
                    Jeszcze nie
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-primary" onClick={() => setShown(true)}>
                  Pokaż odpowiedź
                </button>
              )}
            </>
          ) : (
            <p role="status">
              {study.cards.length ? 'Koniec powtórki na dziś. Brawo!' : 'Na dziś nic do powtórki.'}
            </p>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setStudy(null);
              load();
            }}
          >
            Wróć do talii
          </button>
        </div>
      ) : (
        <ul className="deck-list" aria-label="Talie">
          {decks?.map((d) => (
            <li key={d.id} className="deck-item">
              <div>
                <strong>{d.title}</strong>
                <div className="small muted">
                  {plural(d.cards, 'karta', 'karty', 'kart')} · opanowane: {d.learned}
                </div>
              </div>
              <div className="row">
                {d.due > 0 ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => void start(d)}
                  >
                    Ucz się ({d.due})
                  </button>
                ) : (
                  <Badge tone="ok">na dziś gotowe</Badge>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(`Usunąć talię „${d.title}”?`))
                      void api
                        .deleteDeck(d.id)
                        .then(load)
                        .catch((e: unknown) => setError(errorText(e)));
                  }}
                >
                  Usuń
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
