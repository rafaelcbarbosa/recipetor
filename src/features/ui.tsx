import type { ReactNode } from "react";

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  action,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  action?: ReactNode;
}) {
  return (
    <header className="feature-head">
      {onBack ? (
        <button type="button" className="round-btn" aria-label="Back" onClick={onBack}>
          <span aria-hidden="true">←</span>
        </button>
      ) : (
        <span className="feature-head-spacer" aria-hidden="true" />
      )}
      <div className="feature-head-text">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action ?? <span className="feature-head-spacer" aria-hidden="true" />}
    </header>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="feature-loading" role="status" aria-live="polite">
      <span className="offline-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="feature-error" role="alert">
      {children}
    </p>
  );
}

export function EmptyNote({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      <p className="empty-body">{body}</p>
    </div>
  );
}
