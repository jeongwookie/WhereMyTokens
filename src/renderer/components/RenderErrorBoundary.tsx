import React from 'react';

interface Props {
  label: string;
  children: React.ReactNode;
  fill?: boolean;
}

interface State {
  error: Error | null;
}

export default class RenderErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 렌더러가 통째로 빈 화면이 되지 않도록 오류를 콘솔에 남긴다.
    console.error(`[render-boundary:${this.props.label}]`, error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleMinimize = (): void => {
    window.wmt.minimize().catch(() => {});
  };

  private handleQuit = (): void => {
    window.wmt.quit().catch(() => window.close());
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div
        style={{
          margin: this.props.fill ? 0 : '10px 8px 0',
          minHeight: this.props.fill ? '100vh' : 120,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 8,
          padding: this.props.fill ? '18px 16px' : '14px 12px',
          background: 'var(--wmt-bg-card)',
          color: 'var(--wmt-text)',
          border: '1px solid var(--wmt-border)',
          borderRadius: this.props.fill ? 0 : 10,
          fontFamily: 'var(--wmt-font-sans)',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--wmt-bar-red)' }}>
          Renderer Error
        </div>
        <div style={{ fontSize: 12, fontWeight: 700 }}>
          {this.props.label} rendering failed.
        </div>
        <div style={{ fontSize: 11, color: 'var(--wmt-text-muted)', lineHeight: 1.5 }}>
          {this.state.error.message || String(this.state.error)}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={this.handleReload}
            style={{
              background: 'var(--wmt-accent-dim)',
              color: 'var(--wmt-accent)',
              border: '1px solid var(--wmt-border)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Reload
          </button>
          <button
            onClick={this.handleMinimize}
            style={{
              background: 'var(--wmt-bg-row)',
              color: 'var(--wmt-text-dim)',
              border: '1px solid var(--wmt-border)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Minimize
          </button>
          <button
            onClick={this.handleQuit}
            style={{
              background: 'rgba(248,113,113,0.14)',
              color: 'var(--wmt-bar-red)',
              border: '1px solid rgba(248,113,113,0.25)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Quit
          </button>
        </div>
      </div>
    );
  }
}
