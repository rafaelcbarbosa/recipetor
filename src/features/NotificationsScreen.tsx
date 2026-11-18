import { useEffect, useState } from "react";
import { apiFetch, type Notification } from "../lib/api";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

const LABELS: Record<string, string> = {
  join_request: "New request to join",
  join_approved: "You're approved",
  join_declined: "Request declined",
  member_joined: "A family joined",
  member_removed: "You were removed",
  admin_added: "You're now an admin",
  class_created: "Class created",
};

export function NotificationsScreen({
  token,
  onBack,
  onOpenClass,
}: {
  token: string | null;
  onBack: () => void;
  onOpenClass: (classId: string) => void;
}) {
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ notifications: Notification[] }>("/api/notifications", { token })
      .then((data) => setItems(data.notifications))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function markAll() {
    try {
      await apiFetch("/api/notifications/read", { method: "POST", token, body: JSON.stringify({}) });
      setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't mark notifications read.");
    }
  }

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader
          title="Notifications"
          onBack={onBack}
          action={
            items.some((item) => !item.readAt) ? (
              <button type="button" className="link-btn" onClick={() => void markAll()}>
                Read all
              </button>
            ) : undefined
          }
        />
        <ErrorNote>{error}</ErrorNote>
        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <EmptyNote title="All caught up" body="Class requests and approvals show up here." />
        ) : (
          <div className="group">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`notification-row${item.readAt ? "" : " unread"}`}
                onClick={() => item.classId && onOpenClass(item.classId)}
              >
                <span className="notification-icon" aria-hidden="true">
                  {item.type === "join_request" ? "🙋" : item.type.includes("declined") ? "✉️" : "✅"}
                </span>
                <span className="class-row-text">
                  <span className="class-row-title">{LABELS[item.type] ?? "Class update"}</span>
                  <span className="class-row-sub">
                    {String(item.payload?.className ?? "")}
                    {(item.payload?.parentName as string) ? ` · ${item.payload.parentName}` : ""}
                    {item.payload?.message ? ` · ${item.payload.message}` : ""}
                  </span>
                  <span className="helper">{new Date(item.createdAt).toLocaleString()}</span>
                </span>
                {!item.readAt && <span className="unread-dot" aria-label="Unread" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
