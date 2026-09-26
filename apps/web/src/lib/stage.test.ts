import type { Task, TaskStep } from '@nova/contracts';
import { describe, expect, it } from 'vitest';
import { stageOf } from './stage';

const step = (over: Partial<TaskStep>): TaskStep => ({
  id: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  key: 'reply',
  title: 'Odpowiedź',
  kind: 'model',
  tool: null,
  dependsOn: [],
  requiresApproval: false,
  status: 'pending',
  approvalId: null,
  progress: null,
  output: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const task = (status: Task['status'], steps: TaskStep[]): Task => ({
  id: '00000000-0000-4000-8000-000000000002',
  kind: 'agent.turn',
  title: 'Odpowiedź',
  status,
  visibility: 'private',
  ownerUserId: '00000000-0000-4000-8000-000000000003',
  isMine: true,
  conversationId: null,
  progress: null,
  attempts: 1,
  error: null,
  createdAt: '2026-09-26T10:00:00Z',
  updatedAt: '2026-09-26T10:00:00Z',
  finishedAt: null,
  steps,
});

describe('etap pracy asystenta', () => {
  it('kolejka, myślenie, narzędzie z opisem, odpowiedź uzupełniająca', () => {
    expect(stageOf(null).label).toBe('Zaczyna');
    expect(stageOf(task('queued', [])).label).toBe('Zaczyna');
    expect(stageOf(task('running', [step({ status: 'running' })]))).toEqual({
      label: 'Myśli',
      detail: null,
    });
    const read = step({
      key: 'tool_1',
      kind: 'tool',
      tool: 'documents.read',
      title: 'Odczyt dokumentu „Umowa”',
      status: 'running',
    });
    expect(stageOf(task('running', [step({ status: 'completed' }), read]))).toEqual({
      label: 'Czyta dokument',
      detail: 'Odczyt dokumentu „Umowa”',
    });
    expect(
      stageOf(
        task('running', [
          step({ key: 'tool_1', kind: 'tool', tool: 'mail.search', status: 'running' }),
        ]),
      ).label,
    ).toBe('Przeszukuje pocztę');
    expect(
      stageOf(
        task('running', [
          step({ key: 'tool_1', kind: 'tool', tool: 'nieznane.x', status: 'running' }),
        ]),
      ).label,
    ).toBe('Wykonuje akcję');
    // Między narzędziem a odpowiedzią uzupełniającą.
    expect(
      stageOf(
        task('running', [
          { ...read, status: 'completed' },
          step({ key: 'followup', status: 'pending' }),
        ]),
      ).label,
    ).toBe('Układa odpowiedź');
    expect(stageOf(task('running', [step({ key: 'followup', status: 'running' })])).label).toBe(
      'Układa odpowiedź',
    );
  });
});
