import type { Task } from '@nova/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useEventEffect } from '../lib/events';
import { prefersReducedMotion, revealDuration, revealedText } from '../lib/reveal';
import { stageOf } from '../lib/stage';

/**
 * Obecność asystenta w rozmowie: „kula” ze stanem (spoczynek / myśli / mówi), wskaźnik pracy z etapem
 * pobieranym z kroków zadania i odsłanianie nowej odpowiedzi. Ruch wyłącza ustawienie „ogranicz ruch”.
 */
type OrbState = 'idle' | 'thinking' | 'speaking';

export function AgentOrb({ state, size = 28 }: { state: OrbState; size?: number }) {
  return (
    <span className={`orb orb-${state}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="orb-core" />
    </span>
  );
}

/**
 * Wskaźnik pracy asystenta: etap aktualizowany na żywo zdarzeniami kroków zadania (bez odpytywania co chwilę).
 */
export function AssistantActivity({ taskId, agentName }: { taskId: string; agentName: string }) {
  const [task, setTask] = useState<Task | null>(null);
  const refresh = useCallback(() => {
    api
      .task(taskId)
      .then(setTask)
      .catch(() => undefined);
  }, [taskId]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEventEffect(
    (e) =>
      e.taskId === taskId &&
      (e.type === 'step.status' || e.type === 'task.status' || e.type === 'task.progress'),
    refresh,
  );
  const { label, detail } = stageOf(task);
  return (
    <div className="ai-activity msg-enter" role="status" aria-live="polite">
      <AgentOrb state="thinking" />
      <div className="ai-activity-text">
        <span className="ai-activity-label">
          <span className="sr-only">{agentName}: </span>
          {label}
          <span className="dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </span>
        {detail && <span className="ai-activity-detail">{detail}</span>}
        <span className="shimmer" aria-hidden="true">
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}

/**
 * Tekst nowej odpowiedzi odsłaniany słowo po słowie. Czytnik ekranu dostaje od razu całość (a odsłaniany tekst
 * jest dla niego ukryty); kliknięcie pokazuje wszystko od razu. Po zakończeniu — zwykły tekst.
 */
export function RevealText({ text, animate }: { text: string; animate: boolean }) {
  const [shown, setShown] = useState(() => (animate && !prefersReducedMotion() ? '' : text));
  const done = useRef(!animate || prefersReducedMotion());
  useEffect(() => {
    if (done.current) {
      setShown(text);
      return;
    }
    const duration = revealDuration(text);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = revealedText(text, now - start, duration);
      setShown(next);
      if (next.length < text.length) frame = requestAnimationFrame(tick);
      else done.current = true;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);

  if (shown.length >= text.length) return <>{text}</>;
  return (
    <span
      className="revealing"
      onClick={() => {
        done.current = true;
        setShown(text);
      }}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {shown}
        <span className="caret" />
      </span>
    </span>
  );
}
