import type { MeResponse } from '@nova/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useEventEffect, useEvents } from '../lib/events';
import { href, type Route } from '../lib/router';
import { ActivityStrip } from './ActivityStrip';
import { Icon } from './Icon';

interface NavItem {
  label: string;
  icon: string;
  to: Route;
  match: (r: Route) => boolean;
  mobile?: boolean;
  badge?: number;
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
  useEventEffect(
    (e) => e.type.startsWith('approval.') || e.type === 'notification.created',
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

  const nav: NavItem[] = [
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
      mobile: true,
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
      label: 'Pamięć',
      icon: 'memory',
      to: { view: 'memory', space: 'private' },
      match: (r) => r.view === 'memory',
      mobile: true,
    },
    {
      label: 'Dokumenty',
      icon: 'doc',
      to: { view: 'documents', space: 'private' },
      match: (r) => r.view === 'documents' || r.view === 'document',
    },
    {
      label: 'Ustawienia',
      icon: 'settings',
      to: { view: 'settings' },
      match: (r) => r.view === 'settings',
    },
  ];

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
        <a
          href={href({ view: 'approvals' })}
          className="icon-btn"
          aria-label={`Zgody${pending ? `: ${pending} oczekujące` : ''}`}
        >
          <Icon name="shield" />
          {pending ? <span className="count">{pending}</span> : null}
        </a>
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

      <ActivityStrip />

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
                (n.label === 'Pamięć' && (route.view === 'documents' || route.view === 'document'))
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
    </div>
  );
}
