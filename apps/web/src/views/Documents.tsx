import type { DocumentChunk, DocumentInfo, DocumentSearchHit, Space } from '@nova/contracts';
import { DOCUMENT_LIMITS } from '@nova/contracts/limits';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Badge, EmptyState, ErrorNote, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { formatSize, locatorLabel, timeAgo } from '../lib/format';
import { href } from '../lib/router';

const FORMAT_PL: Record<DocumentInfo['format'], string> = {
  pdf: 'PDF',
  txt: 'TXT',
  md: 'Markdown',
};
const MAX_MB = Math.round(DOCUMENT_LIMITS.maxBytes / 1024 / 1024);
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Nieoczekiwany błąd');

/** Przełącznik między wpisami pamięci a dokumentami (dokumenty to „wiedza” w pamięci). */
export function MemoryTabs({ current }: { current: 'entries' | 'documents' }) {
  return (
    <nav className="space-switch" aria-label="Rodzaj pamięci">
      <a
        className={current === 'entries' ? 'active' : ''}
        aria-current={current === 'entries' ? 'page' : undefined}
        href={href({ view: 'memory', space: 'private' })}
      >
        Wpisy
      </a>
      <a
        className={current === 'documents' ? 'active' : ''}
        aria-current={current === 'documents' ? 'page' : undefined}
        href={href({ view: 'documents', space: 'private' })}
      >
        Dokumenty
      </a>
    </nav>
  );
}

export function DocumentsView({ space }: { space: Space }) {
  const [items, setItems] = useState<DocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .documents(space)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [space]);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'document.updated', load);

  return (
    <section className="page" aria-label="Dokumenty">
      <MemoryTabs current="documents" />
      <header className="section-head">
        <div>
          <h1>Dokumenty</h1>
          <p className="muted small">
            Pliki PDF, TXT i Markdown, z których asystent odpowiada, wskazując dokument i stronę lub
            fragment.{' '}
            {space === 'private'
              ? 'Prywatne widzisz tylko Ty i Twój asystent.'
              : 'Wspólne widzą domownicy i NovaAI.'}
          </p>
        </div>
      </header>
      <div className="space-switch" role="tablist" aria-label="Przestrzeń dokumentów">
        <a
          role="tab"
          aria-selected={space === 'private'}
          className={space === 'private' ? 'active' : ''}
          href={href({ view: 'documents', space: 'private' })}
        >
          Prywatne
        </a>
        <a
          role="tab"
          aria-selected={space === 'shared'}
          className={space === 'shared' ? 'active' : ''}
          href={href({ view: 'documents', space: 'shared' })}
        >
          Wspólne
        </a>
      </div>
      <UploadDocuments space={space} onUploaded={load} />
      <SearchDocuments />
      {error && <ErrorNote error={error} onRetry={load} />}
      {!items && !error && <Spinner />}
      {items?.length === 0 && (
        <EmptyState
          title={space === 'private' ? 'Nie masz jeszcze dokumentów' : 'Brak wspólnych dokumentów'}
        >
          {space === 'private'
            ? 'Dodaj plik powyżej — po zindeksowaniu zapytaj o niego w czacie.'
            : 'Dodaj plik w tej zakładce albo udostępnij swój dokument z zakładki „Prywatne”.'}
        </EmptyState>
      )}
      {items && items.length > 0 && (
        <ul className="documents">
          {items.map((d) => (
            <DocumentItem key={d.id} d={d} onChange={load} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Sprawdzenie po stronie przeglądarki (serwer i tak weryfikuje format i rozmiar). */
function precheck(file: File): string | null {
  const ext = /\.[^.]+$/.exec(file.name.toLowerCase())?.[0] ?? '';
  if (!(DOCUMENT_LIMITS.extensions as readonly string[]).includes(ext)) {
    return `${file.name}: nieobsługiwany format — dodaj PDF, TXT lub Markdown (.md)`;
  }
  if (file.size === 0) return `${file.name}: plik jest pusty`;
  if (file.size > DOCUMENT_LIMITS.maxBytes) {
    return `${file.name}: ${formatSize(file.size)} — limit to ${MAX_MB} MB`;
  }
  return null;
}

function UploadDocuments({ space, onUploaded }: { space: Space; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const send = async (files: File[]) => {
    const problems: string[] = [];
    for (const file of files) {
      const bad = precheck(file);
      if (bad) {
        problems.push(bad);
        continue;
      }
      setBusy(file.name);
      try {
        await api.uploadDocument(file, space);
        onUploaded();
      } catch (e) {
        problems.push(`${file.name}: ${errorText(e)}`);
      }
    }
    setBusy(null);
    setErrors(problems);
    if (input.current) input.current.value = '';
  };

  return (
    <div
      className={`upload panel${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className="upload-row">
        <Icon name="upload" size={20} />
        <div className="upload-text">
          <span className="upload-label" id="doc-upload-title">
            Dodaj pliki {space === 'shared' ? 'wspólne' : 'prywatne'}
          </span>
          <span className="small muted" id="doc-upload-hint">
            PDF, TXT lub Markdown, do {MAX_MB} MB. Możesz też upuścić pliki tutaj.
            {space === 'shared' && ' Od razu widoczne dla domowników i NovaAI.'}
          </span>
        </div>
        {/* Natywne pole jest ukryte wizualnie (zostaje dostępne z klawiatury), bo przeglądarka
            opisuje je w języku systemu („Choose Files”). */}
        <input
          ref={input}
          id="doc-file"
          className="sr-only upload-input"
          type="file"
          multiple
          accept={DOCUMENT_LIMITS.extensions.join(',')}
          disabled={busy !== null}
          aria-describedby="doc-upload-hint"
          onChange={(e) => void send([...(e.target.files ?? [])])}
        />
        <label htmlFor="doc-file" className={`btn upload-button${busy ? ' disabled' : ''}`}>
          <Icon name="plus" /> Wybierz pliki
        </label>
      </div>
      {busy && (
        <p className="small muted row" role="status">
          <Spinner label="Wysyłanie" /> Wysyłanie: {busy}
        </p>
      )}
      {errors.map((m) => (
        <ErrorNote key={m} error={m} />
      ))}
    </div>
  );
}

function SearchDocuments() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<DocumentSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setHits((await api.searchDocuments(q.trim())).items);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="doc-search">
      <form className="row" role="search" onSubmit={(e) => void run(e)}>
        <label htmlFor="doc-q" className="sr-only">
          Szukaj w dokumentach
        </label>
        <input
          id="doc-q"
          type="search"
          value={q}
          maxLength={300}
          onChange={(e) => {
            setQ(e.target.value);
            if (!e.target.value) setHits(null);
          }}
          placeholder="Szukaj w dokumentach…"
        />
        <button type="submit" className="btn" disabled={busy || !q.trim()}>
          <Icon name="search" /> Szukaj
        </button>
      </form>
      {error && <ErrorNote error={error} />}
      {hits?.length === 0 && (
        <p className="small muted" role="status">
          Brak trafień. Spróbuj innych słów — wyszukiwanie dopasowuje słowa i ich odmiany, nie
          znaczenie.
        </p>
      )}
      {hits && hits.length > 0 && (
        <ol className="hits" aria-label="Wyniki wyszukiwania">
          {hits.map((h) => (
            <li key={`${h.documentId}-${h.ord}`}>
              <a href={href({ view: 'document', id: h.documentId, ord: h.ord })} className="hit">
                <span className="hit-title">
                  <Icon name="doc" size={14} /> {h.title}
                  <span className="muted"> · {locatorLabel(h)}</span>
                  {h.visibility === 'shared' && <Badge tone="accent">wspólny</Badge>}
                </span>
                <span className="hit-snippet">
                  {h.snippet.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : s.text))}
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function StatusBadge({ d }: { d: DocumentInfo }) {
  if (d.status === 'ready') return <Badge tone="ok">gotowy</Badge>;
  if (d.status === 'failed') return <Badge tone="danger">błąd odczytu</Badge>;
  return <Badge tone="accent">{d.status === 'indexing' ? 'indeksowanie…' : 'w kolejce…'}</Badge>;
}

function DocumentItem({ d, onChange }: { d: DocumentInfo; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const facts = [
    FORMAT_PL[d.format],
    d.pageCount !== null ? `${d.pageCount} str.` : null,
    d.status === 'ready' ? `${d.chunkCount} fragm.` : null,
    formatSize(d.sizeBytes),
    `dodano ${timeAgo(d.createdAt)}`,
    !d.isMine && d.ownerName ? `od: ${d.ownerName}` : null,
  ].filter(Boolean);
  return (
    <li className="document panel">
      <div className="document-head">
        <Icon name="doc" size={20} />
        <div className="document-title">
          <a href={href({ view: 'document', id: d.id, ord: null })}>{d.title}</a>
          <span className="small muted">{facts.join(' · ')}</span>
        </div>
        <StatusBadge d={d} />
      </div>
      {d.status === 'failed' && d.error && (
        <p className="note note-danger" role="alert">
          {d.error}
        </p>
      )}
      <div className="document-actions">
        <a className="btn btn-ghost btn-sm" href={api.documentFileUrl(d.id)} download={d.filename}>
          <Icon name="download" /> Pobierz
        </a>
        {d.isMine && (
          <>
            {d.visibility === 'private' ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void run(() => api.shareDocument(d.id))}
              >
                <Icon name="share" /> Udostępnij domownikom
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void run(() => api.unshareDocument(d.id))}
              >
                <Icon name="lock" /> Cofnij udostępnienie
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy || d.status === 'pending' || d.status === 'indexing'}
              onClick={() => void run(() => api.reindexDocument(d.id))}
            >
              <Icon name="refresh" /> Indeksuj ponownie
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Usunąć „${d.title}” wraz z indeksem? Tego nie można cofnąć.`))
                  void run(() => api.deleteDocument(d.id));
              }}
            >
              <Icon name="trash" /> Usuń
            </button>
          </>
        )}
      </div>
      {error && <ErrorNote error={error} />}
    </li>
  );
}

/** Dokument i wskazany fragment — cel odnośników ze źródeł odpowiedzi i wyników wyszukiwania. */
export function DocumentView({ id, ord }: { id: string; ord: number | null }) {
  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  const [chunk, setChunk] = useState<DocumentChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chunkError, setChunkError] = useState<string | null>(null);
  const current = ord ?? 0;

  const load = useCallback(() => {
    api
      .document(id)
      .then((d) => {
        setDoc(d);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);
  useEventEffect((e) => e.type === 'document.updated' && e.payload.documentId === id, load);

  useEffect(() => {
    if (!doc || doc.status !== 'ready' || doc.chunkCount === 0) return;
    setChunk(null);
    api
      .documentChunk(id, current)
      .then((c) => {
        setChunk(c);
        setChunkError(null);
      })
      .catch((e: unknown) => setChunkError(errorText(e)));
  }, [doc, id, current]);

  const backTo = href({ view: 'documents', space: doc?.visibility ?? 'private' });
  if (error) {
    return (
      <section className="page" aria-label="Dokument">
        <a className="small" href={backTo}>
          <Icon name="back" size={14} /> Dokumenty
        </a>
        <ErrorNote error={error} onRetry={load} />
      </section>
    );
  }
  if (!doc) {
    return (
      <section className="page" aria-label="Dokument">
        <Spinner />
      </section>
    );
  }
  return (
    <section className="page" aria-label={`Dokument: ${doc.title}`}>
      <a className="small" href={backTo}>
        <Icon name="back" size={14} /> Dokumenty
      </a>
      <header className="section-head">
        <div>
          <h1>{doc.title}</h1>
          <p className="muted small">
            {doc.filename} · {FORMAT_PL[doc.format]}
            {doc.pageCount !== null ? ` · ${doc.pageCount} str.` : ''} · {formatSize(doc.sizeBytes)}
            {doc.visibility === 'shared' ? ' · wspólny' : ' · prywatny'}
            {!doc.isMine && doc.ownerName ? ` · od: ${doc.ownerName}` : ''}
          </p>
        </div>
        <a className="btn btn-sm" href={api.documentFileUrl(doc.id)} download={doc.filename}>
          <Icon name="download" /> Pobierz oryginał
        </a>
      </header>
      {doc.status === 'failed' && <ErrorNote error={doc.error ?? 'Nie udało się odczytać pliku'} />}
      {(doc.status === 'pending' || doc.status === 'indexing') && doc.chunkCount === 0 && (
        <p className="note note-muted" role="status">
          <span className="row">
            <Spinner label="Indeksowanie" /> Dokument jest indeksowany — fragmenty pojawią się za
            chwilę.
          </span>
        </p>
      )}
      {doc.status === 'ready' && (
        <article className="fragment panel" aria-live="polite">
          <header className="fragment-head">
            <span>
              Fragment {current + 1} z {doc.chunkCount}
              {chunk ? ` · ${locatorLabel(chunk)}` : ''}
            </span>
            <nav className="row" aria-label="Fragmenty">
              {current > 0 ? (
                <a
                  className="btn btn-ghost btn-sm"
                  href={href({ view: 'document', id, ord: current - 1 })}
                >
                  Poprzedni
                </a>
              ) : null}
              {current + 1 < doc.chunkCount ? (
                <a
                  className="btn btn-ghost btn-sm"
                  href={href({ view: 'document', id, ord: current + 1 })}
                >
                  Następny
                </a>
              ) : null}
            </nav>
          </header>
          {chunkError && <ErrorNote error={chunkError} />}
          {!chunk && !chunkError && <Spinner />}
          {chunk && <div className="fragment-body">{chunk.content}</div>}
        </article>
      )}
    </section>
  );
}
