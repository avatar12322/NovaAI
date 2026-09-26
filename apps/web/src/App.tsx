import type { MeResponse } from '@nova/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Shell } from './components/Shell';
import { ErrorNote, Spinner } from './components/ui';
import { api, ApiError } from './lib/api';
import { EventsProvider } from './lib/events';
import { useRoute } from './lib/router';
import { ApprovalsView } from './views/Approvals';
import { ChatView } from './views/Chat';
import { DocumentsView, DocumentView } from './views/Documents';
import { HomeView } from './views/Home';
import { LoginView } from './views/Login';
import { MemoryView } from './views/Memory';
import { EnrollView } from './views/Passkeys';
import { SettingsView } from './views/Settings';
import { TasksView } from './views/Tasks';

type State =
  | { kind: 'loading' }
  | { kind: 'anon' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; me: MeResponse };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const route = useRoute();

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    api
      .me()
      .then((me) => setState({ kind: 'ready', me }))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setState({ kind: 'anon' });
        else
          setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'Nieznany błąd' });
      });
  }, []);
  useEffect(load, [load]);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setState({ kind: 'anon' });
  };

  if (route.view === 'enroll') return <EnrollView token={route.token} onDone={load} />;
  if (state.kind === 'loading') {
    return (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="center-screen">
        <div className="panel narrow">
          <h1>NovaAI</h1>
          <ErrorNote error={`Serwer niedostępny: ${state.message}`} onRetry={load} />
        </div>
      </div>
    );
  }
  if (state.kind === 'anon') return <LoginView onLoggedIn={load} />;

  const me = state.me;
  return (
    <EventsProvider>
      <Shell me={me} route={route} onLogout={logout}>
        {route.view === 'chat' && (
          <ChatView key={route.space} me={me} space={route.space} conversationId={route.id} />
        )}
        {route.view === 'tasks' && <TasksView me={me} taskId={route.id} />}
        {route.view === 'approvals' && <ApprovalsView />}
        {route.view === 'memory' && <MemoryView space={route.space} />}
        {route.view === 'documents' && <DocumentsView key={route.space} space={route.space} />}
        {route.view === 'document' && <DocumentView id={route.id} ord={route.ord} />}
        {route.view === 'home' && <HomeView me={me} />}
        {route.view === 'settings' && <SettingsView me={me} onLogout={logout} />}
      </Shell>
    </EventsProvider>
  );
}
