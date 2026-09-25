import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a crash in one view instead of taking the window with it.
 *
 * Without this, a single throw anywhere in the tree unmounts everything and
 * leaves a black window with no explanation and no way back — which is exactly
 * what it looks like from the outside when something goes wrong.
 */
interface Props {
  /** Shown in the fallback and in the log, e.g. "office". */
  area: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Persisted by the main process: an intermittent crash is only diagnosable
    // if the evidence outlives the session it happened in.
    void window.atrium.log?.error({
      area: this.props.area,
      message: error.message,
      stack: error.stack ?? '',
      componentStack: info.componentStack ?? '',
    });
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash__body">
          <h2>The {this.props.area} stopped drawing</h2>
          <p>
            Nothing was lost — Atrium only ever reads. The details are in <code>errors.log</code> next to your
            settings.
          </p>
          <pre>{error.message}</pre>
          <button onClick={this.retry}>Try again</button>
        </div>
      </div>
    );
  }
}
