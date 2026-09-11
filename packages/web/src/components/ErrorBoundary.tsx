import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches a render error so one broken screen doesn't blank the whole app.
 *
 * Without this, React 18's response to an exception during render is to unmount
 * the entire tree — the user gets a white page with no explanation, no way back
 * and, if they were mid-edit, no idea whether their work was saved. A white
 * page is indistinguishable from "the system is gone", which is exactly the
 * impression this application cannot afford to give.
 *
 * The recovery offered is deliberately in two steps. "Try again" re-renders in
 * place: if the cause was transient — a half-loaded record, a bad response —
 * the screen comes back and nothing is lost. Only if that fails is reloading
 * suggested, because a reload throws away anything typed and not yet saved.
 */

interface Props {
  children: ReactNode;
  /** Shown instead of the screen name when the boundary wraps a single panel. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack that matters for a React error is the component stack, not the
    // JS one — it names the screen. Kept in the console so a support call can
    // start with "open the console and read me the last red line".
    console.error('[render error]', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <div className="w-full max-w-lg rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            {this.props.label ?? 'This screen'} ran into a problem
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Nothing has been lost — your saved work is in the database. This is a
            display problem on this screen only.
          </p>
          <p className="mt-3 rounded bg-slate-50 p-3 font-mono text-xs text-slate-700">
            {error.message || 'Unknown error'}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Reload the page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
