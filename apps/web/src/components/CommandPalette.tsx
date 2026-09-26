import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorText } from '../lib/api';
import { matchCommands, type Command } from '../lib/commands';
import { setPendingTurn } from '../lib/pending';
import { navigate } from '../lib/router';
import { applyTheme } from '../views/Settings';
import { Icon } from './Icon';
import { speakNow } from './Voice';

/**
 * Paleta poleceń (Ctrl+K): przejście do dowolnego widoku, nowa rozmowa, pytanie do asystenta prosto z palety,
 * odczyt przeglądu dnia, zmiana motywu. Pełna obsługa klawiaturą (↑ ↓ Enter Esc).
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const items = matchCommands(q);
  useEffect(() => {
    input.current?.focus();
  }, []);

  const run = async (c: Command | undefined) => {
    if (!c || busy) return;
    if ('route' in c.run) {
      navigate(c.run.route);
      onClose();
      return;
    }
    const action = c.run.action;
    if (action === 'theme-light' || action === 'theme-dark') {
      applyTheme(action === 'theme-light' ? 'light' : 'dark');
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (action === 'briefing') {
        navigate({ view: 'home' });
        const b = await api.briefing();
        speakNow(b.summary, { briefing: true });
      } else {
        const conv = await api.createConversation('private');
        if (action === 'ask' && q.trim()) {
          const r = await api.sendMessage(conv.id, q.trim());
          if (r.taskId) setPendingTurn(conv.id, r.taskId);
        }
        navigate({ view: 'chat', space: 'private', id: conv.id });
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(items[sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Polecenia"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[sel] ? `cmd-${items[sel].id}` : undefined}
          aria-label="Polecenie albo pytanie do asystenta"
          placeholder="Dokąd przejść albo o co zapytać asystenta…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
          disabled={busy}
        />
        <ul id="palette-list" className="palette-list" role="listbox" aria-label="Polecenia">
          {items.map((c, i) => (
            <li
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'active' : undefined}
              onMouseEnter={() => setSel(i)}
              onClick={() => void run(c)}
            >
              <Icon name={c.icon} size={16} />
              <span className="palette-label">{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </li>
          ))}
        </ul>
        {error && (
          <p className="note note-danger" role="alert">
            {error}
          </p>
        )}
        <p className="palette-foot small muted">↑ ↓ wybór · Enter wykonaj · Esc zamknij</p>
      </div>
    </div>
  );
}
