import type { MeResponse } from '@nova/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useEventEffect, useEvents } from '../lib/events';
import { setAppBadge, syncPush } from '../lib/push';
import { href, type Route } from '../lib/router';
import { CommandPalette } from './CommandPalette';
import { Icon } from './Icon';

interface NavItem {
  label: string;
  icon: string;
  to: Route;
  match: (r: Route) => boolean;
  mobile?: boolean;
  badge?: number;
  /** Widoczne tylko dla właściciela domu (ustawienia administracyjne, techniczne widoki). */
  ownerOnly?: boolean;
}

export function Shell({
  me,
  route,
  children,
  onLogout,
}: {
  me: MeResponse;
  route: Route;
  children: ReactNode;
  onLogout: () => void;
}) {
  const [pending, setPending] = useState(0);
  const [unread, setUnread] = useState(0);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const { connected } = useEvents();
  const [palette, setPalette] = useState(false);
  // Domownik ma prosty widok: rozmowy, pamięć, dokumenty, dom. Modele, usługi i zadania — właściciel domu.
  const isOwner = me.household?.role === 'owner';
  // Ctrl+K / Cmd+K — paleta poleceń z każdego miejsca aplikacji.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refreshCounts = () => {
    api
      .approvals('pending')
      .then((r) => setPending(r.items.length))
      .catch(() => undefined);
    api
      .notifications()
      .then((r) => setUnread(r.unread))
      .catch(() => undefined);
  };
  useEffect(refreshCounts, []);
  // Urządzenie z włączonymi powiadomieniami zgłasza się serwerowi ponownie, jeśli ten je „zgubił”.
  useEffect(() => {
    void syncPush(me.user.id).catch(() => undefined);
  }, [me.user.id]);
  // Liczba nieprzeczytanych także na ikonie aplikacji (ekran główny telefonu, pasek zadań).
  useEffect(() => {
    setAppBadge(unread);
  }, [unread]);
  useEventEffect(
    (e) => e.type.startsWith('approval.') || e.type.startsWith('notification.'),
    refreshCounts,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const allNav: NavItem[] = [
    {
      label: 'Czat',
      icon: 'chat',
      to: { view: 'chat', space: 'private', id: null },
      match: (r) => r.view === 'chat' && r.space === 'private',
      mobile: true,
    },
    {
      label: 'NovaAI (wspólne)',
      icon: 'users',
      to: { view: 'chat', space: 'shared', id: null },
      match: (r) => r.view === 'chat' && r.space === 'shared',
    },
    {
      label: 'Zadania',
      icon: 'tasks',
      to: { view: 'tasks', id: null },
      match: (r) => r.view === 'tasks',
      ownerOnly: true,
    },
    {
      label: 'Zgody',
      icon: 'shield',
      to: { view: 'approvals' },
      match: (r) => r.view === 'approvals',
      badge: pending,
    },
    {
      label: 'Dom',
      icon: 'home',
      to: { view: 'home' },
      match: (r) => r.view === 'home',
      mobile: true,
      badge: unread,
    },
    {
      label: 'Zakupy',
      icon: 'cart',
      to: { view: 'shopping' },
      match: (r) => r.view === 'shopping',
      mobile: true,
    },
    {
      label: 'Wydatki',
      icon: 'receipt',
      to: { view: 'expenses' },
      match: (r) => r.view === 'expenses',
      mobile: true,
    },
    {
      label: 'Pamięć',
      icon: 'memory',
      to: { view: 'memory', space: 'private' },
      match: (r) => r.view === 'memory',
      // Dolny pasek mieści 5 pozycji: właściciel — Pamięć (z niej Dokumenty), domownik — Dokumenty (fiszki).
      mobile: isOwner,
    },
    {
      label: 'Dokumenty',
      icon: 'doc',
      to: { view: 'documents', space: 'private' },
      match: (r) => r.view === 'documents' || r.view === 'document',
      mobile: !isOwner,
    },
    {
      label: 'Usługi i koszty',
      icon: 'wallet',
      to: { view: 'services', id: null },
      match: (r) => r.view === 'services',
      ownerOnly: true,
    },
    {
      label: 'Modele AI',
      icon: 'key',
      to: { view: 'models' },
      match: (r) => r.view === 'models',
      ownerOnly: true,
    },
    {
      label: 'Ustawienia',
      icon: 'settings',
      to: { view: 'settings' },
      match: (r) => r.view === 'settings',
    },
  ];
  const nav = allNav.filter(
    (n) =>
      (isOwner || !n.ownerOnly) &&
      // Zgody: domownik widzi je tylko wtedy, gdy coś czeka na jego decyzję.
      (isOwner || n.label !== 'Zgody' || pending > 0 || route.view === 'approvals'),
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Przejdź do treści
      </a>
      <nav className="sidenav" aria-label="Nawigacja główna">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>NovaAI</span>
        </div>
        <ul>
          {nav.map((n) => (
            <li key={n.label}>
              <a
                href={href(n.to)}
                className={n.match(route) ? 'active' : undefined}
                aria-current={n.match(route) ? 'page' : undefined}
              >
                <Icon name={n.icon} />
                <span>{n.label}</span>
                {n.badge ? (
                  <span className="count" aria-label={`${n.badge} nowych`}>
                    {n.badge}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        <button type="button" className="palette-open" onClick={() => setPalette(true)}>
          <Icon name="search" size={16} />
          <span>Polecenia</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="sidenav-foot">
          <div className="me">
            <span className="avatar" aria-hidden="true">
              {me.user.displayName.slice(0, 1)}
            </span>
            <span className="me-name">{me.user.displayName}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
            <Icon name="logout" /> Wyloguj
          </button>
        </div>
      </nav>

      <header className="topbar">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span className="topbar-title">NovaAI</span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Polecenia i pytania (Ctrl+K)"
          onClick={() => setPalette(true)}
        >
          <Icon name="search" />
        </button>
        {(isOwner || pending > 0) && (
          <a
            href={href({ view: 'approvals' })}
            className="icon-btn"
            aria-label={`Zgody${pending ? `: ${pending} oczekujące` : ''}`}
          >
            <Icon name="shield" />
            {pending ? <span className="count">{pending}</span> : null}
          </a>
        )}
        <a href={href({ view: 'settings' })} className="icon-btn" aria-label="Ustawienia">
          <Icon name="settings" />
        </a>
      </header>

      <div className="main-wrap">
        {me.env !== 'production' && (
          <div className="envbar" role="note">
            Środowisko <strong>{me.env}</strong> · konto testowe {me.user.displayName}
          </div>
        )}
        {!online && (
          <div className="note note-warn banner" role="status">
            Jesteś offline. Zmiany nie zostaną zapisane do czasu powrotu połączenia.
          </div>
        )}
        {online && !connected && (
          <div className="note note-muted banner" role="status">
            Brak połączenia na żywo z serwerem — widoki odświeżysz ręcznie.
          </div>
        )}
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>

      <nav className="bottomnav" aria-label="Nawigacja mobilna">
        {nav
          .filter((n) => n.mobile)
          .map((n) => (
            <a
              key={n.label}
              href={href(n.to)}
              className={
                n.match(route) ||
                (n.label === 'Czat' && route.view === 'chat') ||
                (isOwner &&
                  n.label === 'Pamięć' &&
                  (route.view === 'documents' || route.view === 'document'))
                  ? 'active'
                  : undefined
              }
              aria-current={n.match(route) ? 'page' : undefined}
            >
              <Icon name={n.icon} size={20} />
              <span>{n.label}</span>
              {n.badge ? <span className="count">{n.badge}</span> : null}
            </a>
          ))}
      </nav>
      {palette && <CommandPalette isOwner={isOwner} onClose={() => setPalette(false)} />}
    </div>
  );
}
