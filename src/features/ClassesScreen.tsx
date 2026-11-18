import { useEffect, useState } from "react";
import { apiFetch, type ClassSummary } from "../lib/api";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

export function ClassesScreen({
  token,
  onOpenClass,
  onJoin,
  onOpenNotifications,
  onOpenReports,
  onBack,
}: {
  token: string | null;
  onOpenClass: (classId: string) => void;
  onJoin: (code: string) => void;
  onOpenNotifications: () => void;
  onOpenReports: () => void;
  onBack: () => void;
}) {
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [joinMode, setJoinMode] = useState<"approve" | "open">("approve");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const [reportsCount, setReportsCount] = useState<number | null>(null);

  function load() {
    setLoading(true);
    apiFetch<{ classes: ClassSummary[]; unread: number }>("/api/classes", { token })
      .then((data) => {
        setClasses(data.classes);
        setUnread(data.unread);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    load();
    apiFetch<{ reports: unknown[] }>("/api/admin/reports?status=open", { token })
      .then((data) => setReportsCount(data.reports.length))
      .catch(() => setReportsCount(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function createClass() {
    if (!name.trim()) {
      setError("Give the class a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch<{ class: ClassSummary }>("/api/classes", {
        method: "POST",
        token,
        body: JSON.stringify({ name, description, joinMode }),
      });
      setShowCreate(false);
      setName("");
      setDescription("");
      onOpenClass(data.class.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the class.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Classes" onBack={onBack} />
          <div className="signin-gate">
            <span className="signin-gate-icon" aria-hidden="true">
              🍳
            </span>
            <h2>Cook together</h2>
            <p>Sign in to join a class, share a Cook-Along photo, and keep a class cookbook.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader
          title="Classes"
          onBack={onBack}
          action={
            <button type="button" className="round-btn bell-btn" aria-label="Notifications" onClick={onOpenNotifications}>
              <span aria-hidden="true">🔔</span>
              {unread > 0 && <span className="badge-dot">{unread > 9 ? "9+" : unread}</span>}
            </button>
          }
        />

        <div className="feature-actions">
          <button type="button" className="primary-btn" onClick={() => setShowCreate(true)}>
            Create a class
          </button>
          <button type="button" className="secondary-btn" onClick={() => setShowJoin(true)}>
            Join with a code
          </button>
        </div>

        <ErrorNote>{error}</ErrorNote>
        {loading ? (
          <Loading label="Loading your classes…" />
        ) : classes.length === 0 ? (
          <EmptyNote
            title="No classes yet"
            body="Create a class for your cooking group, or join one with the code your teacher shared."
          />
        ) : (
          <div className="group">
            {classes.map((item) => (
              <button
                type="button"
                key={item.id}
                className="class-row"
                onClick={() => (item.status === "pending" ? onJoin(item.joinCode ?? "") : onOpenClass(item.id))}
              >
                <span className="class-row-mark" aria-hidden="true">
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="class-row-text">
                  <span className="class-row-title">{item.name}</span>
                  <span className="class-row-sub">
                    {item.status === "pending"
                      ? "Waiting for approval"
                      : `${item.memberCount} ${item.memberCount === 1 ? "family" : "families"} · ${
                          item.openCookAlongs
                        } open Cook-Along${item.openCookAlongs === 1 ? "" : "s"}`}
                  </span>
                </span>
                {item.role === "admin" && item.pendingApprovals > 0 && (
                  <span className="pill-count">{item.pendingApprovals} to review</span>
                )}
                <span aria-hidden="true" className="chev">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}

        {reportsCount !== null && (
          <button type="button" className="secondary-btn" onClick={onOpenReports}>
            Review reported recipes{reportsCount > 0 ? ` (${reportsCount})` : ""}
          </button>
        )}
      </div>

      {showCreate && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowCreate(false)}>
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="create-class-title">
            <div className="sheet-head">
              <h2 id="create-class-title">Create a class</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowCreate(false)}>
                ✕
              </button>
            </div>
            <label className="field">
              <span>Class name</span>
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Thursday cooking club" />
            </label>
            <label className="field">
              <span>For families (optional)</span>
              <textarea
                value={description}
                maxLength={300}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this class is about"
              />
            </label>
            <fieldset className="field">
              <legend>Joining</legend>
              <label className="radio-row">
                <input
                  type="radio"
                  name="joinMode"
                  checked={joinMode === "approve"}
                  onChange={() => setJoinMode("approve")}
                />
                <span>
                  <strong>Review each request</strong>
                  <span className="helper">Recommended. You approve families before they see anything.</span>
                </span>
              </label>
              <label className="radio-row">
                <input type="radio" name="joinMode" checked={joinMode === "open"} onChange={() => setJoinMode("open")} />
                <span>
                  <strong>Anyone with the code</strong>
                  <span className="helper">Families join instantly with the class code.</span>
                </span>
              </label>
            </fieldset>
            <p className="helper">You become the class Admin. Parents add their child's name when they join.</p>
            <button type="button" className="primary-btn" disabled={busy} onClick={() => void createClass()}>
              {busy ? "Creating…" : "Create class"}
            </button>
          </section>
        </div>
      )}

      {showJoin && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowJoin(false)}>
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="join-class-title">
            <div className="sheet-head">
              <h2 id="join-class-title">Join a class</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowJoin(false)}>
                ✕
              </button>
            </div>
            <label className="field">
              <span>Class code</span>
              <input
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                placeholder="ABCD-2345"
                autoCapitalize="characters"
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              className="primary-btn"
              disabled={!joinCode.trim()}
              onClick={() => {
                setShowJoin(false);
                onJoin(joinCode.trim());
              }}
            >
              Continue
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
