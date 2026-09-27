import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, ErrorNote, Spinner } from '../components/ui';
import { api, errorText, type HouseholdMember } from '../lib/api';

const untilLabel = (iso: string) =>
  new Date(iso).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Domownicy: konta tylko z zaproszenia. Właściciel tworzy jednorazowy link (ważny 7 dni) i sam go wysyła —
 * osoba otwiera link i tworzy klucz dostępu. „Nowy link” — gdy zaproszenie wygasło albo zgubiono urządzenie.
 */
export function HouseholdPanel() {
  const [data, setData] = useState<{ canManage: boolean; members: HouseholdMember[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ who: string; url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    api
      .householdMembers()
      .then(setData)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    const who = name.trim();
    void run(async () => {
      const r = await api.inviteMember({ email: email.trim(), displayName: who });
      setLink({ who, url: r.link, expiresAt: r.expiresAt });
      setCopied(false);
      setName('');
      setEmail('');
    });
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="panel household" aria-labelledby="household-title">
      <h2 id="household-title" className="h-sub">
        Domownicy
      </h2>
      <p className="small muted">
        Konta tylko z zaproszenia. Każda osoba loguje się własnym kluczem dostępu i ma prywatnego
        asystenta; wspólne są tylko rzeczy udostępnione domownikom.
      </p>
      {error && <ErrorNote error={error} />}
      {!data && !error && <Spinner />}
      {data && (
        <ul className="grants" aria-label="Osoby w domu">
          {data.members.map((m) => (
            <li key={m.id} className="member">
              <div>
                <strong>{m.displayName}</strong>
                {m.me && <span className="muted"> (Ty)</span>}
                {m.email && <div className="small muted">{m.email}</div>}
                <div className="row small">
                  {m.role === 'owner' ? (
                    <Badge tone="ok">właściciel</Badge>
                  ) : (
                    <Badge>domownik</Badge>
                  )}
                  {m.status === 'invited' &&
                    (m.inviteExpiresAt ? (
                      <Badge tone="warn">
                        zaproszony — link ważny do {untilLabel(m.inviteExpiresAt)}
                      </Badge>
                    ) : (
                      <Badge tone="danger">zaproszenie wygasło</Badge>
                    ))}
                </div>
              </div>
              {data.canManage && !m.me && (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.memberLink(m.id);
                        setLink({ who: m.displayName, url: r.link, expiresAt: r.expiresAt });
                        setCopied(false);
                      })
                    }
                  >
                    Nowy link
                  </button>
                  {m.role === 'member' && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Usunąć ${m.displayName} z domu? Straci dostęp od razu (wylogowanie na wszystkich urządzeniach). Prywatne dane tej osoby zostają.`,
                          )
                        )
                          void run(() => api.removeMember(m.id));
                      }}
                    >
                      Usuń z domu
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {link && (
        <div className="note invite-link" role="status">
          <p>
            Wyślij ten link osobie <strong>{link.who}</strong> (np. SMS-em lub komunikatorem).
            Działa raz, do {untilLabel(link.expiresAt)}; po otwarciu utworzy klucz dostępu na swoim
            urządzeniu.
          </p>
          <div className="row">
            <input
              readOnly
              value={link.url}
              aria-label="Link zaproszenia"
              onFocus={(e) => e.target.select()}
            />
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              {copied ? 'Skopiowano' : 'Kopiuj'}
            </button>
          </div>
        </div>
      )}
      {data?.canManage && (
        <form className="grant-form" onSubmit={invite} aria-label="Zaproś domownika">
          <label htmlFor="inv-name" className="sr-only">
            Imię
          </label>
          <input
            id="inv-name"
            placeholder="Imię"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <label htmlFor="inv-email" className="sr-only">
            E-mail
          </label>
          <input
            id="inv-email"
            type="email"
            placeholder="E-mail"
            value={email}
            maxLength={200}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <button
            type="submit"
            className="btn btn-sm"
            disabled={busy || !name.trim() || !email.trim()}
          >
            Zaproś
          </button>
        </form>
      )}
    </section>
  );
}
