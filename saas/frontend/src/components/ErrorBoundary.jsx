import { Component } from 'react';
import { recordBoundaryError } from '../lib/diagnostics.js';

// Catches render-time exceptions so one broken component shows a recovery panel
// instead of white-screening the whole app. (lazyWithReload handles stale-chunk
// import failures; this handles everything else.)
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('react_error_boundary', error, info?.componentStack);
    try { recordBoundaryError(error, info); } catch { /* ignore */ }
  }

  // The boundary has unmounted the app tree, so hand off to the freshly-mounted
  // FaultReporter across a reload via sessionStorage (it opens pre-filled).
  reportProblem() {
    try { sessionStorage.setItem('dm_fault_pending', '1'); } catch { /* ignore */ }
    window.location.reload();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-raised px-4 text-center">
        <div className="max-w-md">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-red-100 dark:bg-red-500/15 text-2xl">⚠️</div>
          <h1 className="mt-4 text-xl font-bold text-strong">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted">An unexpected error broke this page. Reloading usually fixes it.</p>
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={() => window.location.reload()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Reload</button>
            <button onClick={this.reportProblem} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-dim hover:bg-surface">Report this problem</button>
            <a href="/" className="rounded-lg border border-line px-4 py-2 text-sm font-semibold text-dim hover:bg-surface">Go home</a>
          </div>
        </div>
      </div>
    );
  }
}
