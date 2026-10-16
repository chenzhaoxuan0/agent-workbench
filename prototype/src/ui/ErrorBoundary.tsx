import React, { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-canvas p-6 text-ink">
          <div className="w-full max-w-xl rounded-card border border-loss/30 bg-surface p-6 shadow-elevation">
            <h2 className="text-body font-semibold text-loss">界面渲染出现异常</h2>
            <p className="mt-2 text-body-sm text-ash">
              工作台组件在渲染时抛出未捕获的错误：
            </p>
            <pre className="mt-3 max-h-60 overflow-auto rounded bg-rail p-3 font-mono text-caption text-graphite whitespace-pre-wrap break-all">
              {this.state.error?.stack || this.state.error?.message || "未知错误"}
            </pre>
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="rounded-btn border border-line bg-surface px-4 py-1.5 text-body-sm text-ink hover:bg-hover transition"
              >
                重试渲染
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="rounded-btn bg-teal px-4 py-1.5 text-body-sm font-medium text-white hover:bg-teal/90 transition"
              >
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
