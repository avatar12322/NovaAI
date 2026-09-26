import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Błąd renderowania w jednym widoku nie może wywrócić całej aplikacji (pusty/czarny ekran). Pokazujemy czytelny
 * komunikat z możliwością ponowienia; zmiana `resetKey` (np. przejście do innego widoku) czyści błąd.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; fullScreen?: boolean },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Błąd widoku:', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const panel = (
      <section className="panel view-error" role="alert">
        <h2 className="h-sub">Ten widok nie mógł się wyświetlić</h2>
        <p className="muted small">
          Wystąpił błąd w przeglądarce. Twoje dane nie zostały utracone — spróbuj ponownie albo
          odśwież stronę.
        </p>
        <pre className="small">{error.message.slice(0, 300)}</pre>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => this.setState({ error: null })}
          >
            Spróbuj ponownie
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => window.location.reload()}
          >
            Odśwież stronę
          </button>
        </div>
      </section>
    );
    return this.props.fullScreen ? <div className="center-screen">{panel}</div> : panel;
  }
}
