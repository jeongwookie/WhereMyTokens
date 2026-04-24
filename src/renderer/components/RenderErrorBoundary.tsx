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
          background: '#161920',
          color: '#e8eaf0',
          border: '1px solid rgba(248,113,113,0.28)',
          borderRadius: this.props.fill ? 0 : 10,
          fontFamily: "'Noto Sans', 'Noto Sans KR', sans-serif",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: '#f87171' }}>
          Renderer Error
        </div>
        <div style={{ fontSize: 12, fontWeight: 700 }}>
          {this.props.label} rendering failed.
        </div>
        <div style={{ fontSize: 11, color: '#a5acbf', lineHeight: 1.5 }}>
          {this.state.error.message || String(this.state.error)}
        </div>
        <div>
          <button
            onClick={this.handleReload}
            style={{
              background: 'rgba(13,148,136,0.18)',
              color: '#2dd4bf',
              border: '1px solid rgba(45,212,191,0.35)',
              borderRadius: 6,
              padding: '5px 10px',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
