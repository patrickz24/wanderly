import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

/**
 * Last-resort boundary around the whole app: a render bug shows a recoverable message
 * instead of a blank page. Feature-level boundaries can be added inside it later.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div role="alert" className="mx-auto max-w-xl p-6 text-center">
        <h1 className="text-xl font-semibold">Something went wrong.</h1>
        <p className="mt-2 text-fg-muted">Reload the page to try again.</p>
        <button
          type="button"
          onClick={reloadPage}
          className="mt-4 rounded-md bg-accent px-4 py-2 font-medium text-surface hover:opacity-90"
        >
          Reload
        </button>
      </div>
    );
  }
}

function reloadPage(): void {
  window.location.reload();
}
