import React from 'react';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  backLabel?: string;
  onBackToList?: () => void;
  title?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ErrorBoundary caught render error:', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const errorMessage =
        this.state.error?.message || 'An unexpected rendering error occurred.';
      return (
        <div className="bg-white border border-rose-200 rounded-xl p-6 sm:p-8 max-w-2xl mx-auto my-4 space-y-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-rose-50 text-rose-600 shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                {this.props.title || 'Unable to display this view'}
              </h3>
              <p className="text-sm text-rose-700 break-words font-mono bg-rose-50/70 border border-rose-100 rounded-lg px-3 py-2">
                {errorMessage}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {this.props.onBackToList && (
              <button
                type="button"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  this.props.onBackToList?.();
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>{this.props.backLabel || 'Back to Student List'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={this.handleRetry}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-stone-300 hover:bg-stone-50 rounded-lg cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
