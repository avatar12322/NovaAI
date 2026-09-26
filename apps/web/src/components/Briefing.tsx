import type { Briefing } from '@nova/contracts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { formatMoney } from '../lib/format';
import { href } from '../lib/router';
import { AgentOrb } from './Assistant';
import { Icon } from './Icon';
import { ErrorNote, Spinner } from './ui';
import { SpeakButton, useSpeaking } from './Voice';

/**
 * Przegląd dnia („Dzień dobry”): kalendarz, przypomnienia, zgody, zadania, wiadomości, odnowienia i koszt
 * modeli — z możliwością odczytu na głos. Dane z /api/briefing (uprawnienia jak w pozostałych widokach).
 */
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Item({
  icon,
  title,
  link,
  index,
  children,
}: {
  icon: string;
  title: string;
  link?: string;
  index: number;
  children: ReactNode;
}) {
  return (
    <li className="briefing-item" style={{ ['--i' as string]: index }}>
      <div className="briefing-item-head">
        <Icon name={icon} size={16} />
        {link ? <a href={link}>{title}</a> : <span>{title}</span>}
      </div>
      <div className="briefing-item-body">{children}</div>
    </li>
  );
}

export function BriefingPanel() {
  const [b, setB] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const speaking = useSpeaking();
  const load = useCallback(() => {
    api
      .briefing()
      .then((x) => {
        setB(x);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEventEffect(
    (e) =>
      e.type === 'task.status' ||
      e.type.startsWith('approval.') ||
      e.type === 'notification.created' ||
      e.type.startsWith('budget.'),
    load,
  );

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!b) return <Spinner />;
  return (
    <section className="panel briefing" aria-label="Przegląd dnia">
      <header className="briefing-head">
        <AgentOrb state={speaking ? 'speaking' : 'idle'} size={36} />
        <div className="briefing-title">
          <h2>{b.greeting}</h2>
          <p className="muted small">{capitalize(b.dateLabel)}</p>
        </div>
        <SpeakButton text={b.summary} label="Przeczytaj przegląd" />
      </header>
      <ul className="briefing-items">
        <Item icon="bell" title="Dziś w kalendarzu" index={0}>
          {b.events.length ? (
            b.events.map((e) => (
              <div key={e.id}>
                <span className="mono">{time(e.startsAt)}</span> {e.title}
              </div>
            ))
          ) : (
            <span className="muted">Nic w kalendarzu lokalnym</span>
          )}
        </Item>
        <Item icon="tasks" title="Przypomnienia" index={1}>
          {b.reminders.length ? (
            b.reminders.map((r) => (
              <div key={r.id}>
                <span className="mono">{time(r.dueAt)}</span> {r.text}
                {r.shared && <span className="muted small"> · wspólne</span>}
              </div>
            ))
          ) : (
            <span className="muted">Brak na dziś</span>
          )}
        </Item>
        <Item icon="shield" title="Czeka na zgodę" link={href({ view: 'approvals' })} index={2}>
          <strong className="briefing-count">{b.approvals}</strong>
        </Item>
        <Item
          icon="activity"
          title="Zadania w toku"
          link={href({ view: 'tasks', id: null })}
          index={3}
        >
          <strong className="briefing-count">{b.activeTasks}</strong>
        </Item>
        <Item icon="chat" title="Nieprzeczytane" index={4}>
          <strong className="briefing-count">{b.unread}</strong>
        </Item>
        <Item
          icon="wallet"
          title="Odnowienia (7 dni)"
          link={href({ view: 'services', id: null })}
          index={5}
        >
          {b.renewals.length ? (
            b.renewals.map((r) => (
              <div key={r.serviceId}>
                {r.name}{' '}
                <span className="muted small">
                  {r.daysLeft === 0 ? 'dziś' : r.daysLeft === 1 ? 'jutro' : `za ${r.daysLeft} dni`}
                </span>
              </div>
            ))
          ) : (
            <span className="muted">Brak</span>
          )}
        </Item>
        <Item icon="key" title="Koszt modeli" link={href({ view: 'settings' })} index={6}>
          {formatMoney(b.budget.spent, b.budget.currency)}
          {b.budget.hardLimit !== null && (
            <span className="muted small">
              {' '}
              z {formatMoney(b.budget.hardLimit, b.budget.currency)}
            </span>
          )}
        </Item>
      </ul>
    </section>
  );
}
