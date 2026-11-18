import { useCallback, useEffect, useState } from "react";
import { apiFetch, type ClassSummary } from "../lib/api";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

type Lookup = {
  id: string;
  name: string;
  description: string;
  joinMode: "approve" | "open";
  accepting: boolean;
  archived: boolean;
};

export function JoinScreen({
  code,
  token,
  onNeedAuth,
  onOpenClass,
  onBack,
}: {
  code: string;
  token: string | null;
  onNeedAuth: () => void;
  onOpenClass: (classId: string) => void;
  onBack: () => void;
}) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [membership, setMembership] = useState<{ status: string; role: string; children?: Array<{ displayName: string }> } | null>(
    null,
  );
  const [names, setNames] = useState<string[]>([""]);
  const [parentName, setParentName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [result, setResult] = useState<{ pending: boolean; class?: ClassSummary } | null>(null);

  useEffect(() => {
    if (!token) return;
    apiFetch<{ user: { displayName?: string | null; email: string } }>("/api/auth/me", { token })
      .then((data) => setParentName((current) => current || data.user.displayName || ""))
      .catch(() => undefined);
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ class: Lookup; membership: { status: string; role: string } | null }>(
      `/api/classes/lookup?code=${encodeURIComponent(code)}`,
      { token },
    )
      .then((data) => {
        if (cancelled) return;
        setLookup(data.class);
        setMembership(data.membership);
        setError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, token, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  async function join() {
    const children = names.map((name) => name.trim()).filter(Boolean);
    if (children.length === 0) {
      setError("Enter your child's first name or nickname.");
      return;
    }
    setJoining(true);
    setError("");
    try {
      if (parentName.trim()) {
        await apiFetch("/api/auth/profile", {
          method: "PATCH",
          token,
          body: JSON.stringify({ displayName: parentName.trim() }),
        }).catch(() => undefined);
      }
      const data = await apiFetch<{ pending: boolean; class: ClassSummary }>("/api/classes/join", {
        method: "POST",
        token,
        body: JSON.stringify({ code, children }),
      });
      setResult({ pending: data.pending, class: data.class });
      if (!data.pending && data.class?.id) onOpenClass(data.class.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't join that class.");
    } finally {
      setJoining(false);
    }
  }

  async function cancelRequest() {
    if (!lookup) return;
    if (!window.confirm("Cancel your request to join this class?")) return;
    setCancelling(true);
    setError("");
    try {
      await apiFetch(`/api/classes/${lookup.id}/cancel-request`, { method: "POST", token });
      setResult(null);
      setMembership(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't cancel that request.");
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Join a class" onBack={onBack} />
          <Loading label="Looking up the class…" />
        </div>
      </div>
    );
  }

  if (!lookup) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Join a class" onBack={onBack} />
          <ErrorNote>{error || "That class code doesn't work."}</ErrorNote>
          <p className="helper">Ask your child's teacher for a new link or code.</p>
        </div>
      </div>
    );
  }

  if (membership?.status === "approved") {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title={lookup.name} onBack={onBack} />
          <p>You're already in this class.</p>
          <button type="button" className="primary-btn" onClick={() => onOpenClass(lookup.id)}>
            Open {lookup.name}
          </button>
        </div>
      </div>
    );
  }

  if (result?.pending || membership?.status === "pending") {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title={lookup.name} onBack={onBack} />
          <div className="pending-card">
            <span className="pending-icon" aria-hidden="true">
              ⏳
            </span>
            <h2>Waiting for approval</h2>
            <p>
              An admin of <strong>{lookup.name}</strong> will review your request. You'll get an email when
              you're approved.
            </p>
            {(parentName.trim() || names.some((name) => name.trim())) && (
              <dl className="pending-summary">
                {parentName.trim() && (
                  <>
                    <dt>Your name</dt>
                    <dd>{parentName.trim()}</dd>
                  </>
                )}
                {names.some((name) => name.trim()) && (
                  <>
                    <dt>{names.filter((name) => name.trim()).length === 1 ? "Child" : "Children"}</dt>
                    <dd>{names.map((name) => name.trim()).filter(Boolean).join(", ")}</dd>
                  </>
                )}
              </dl>
            )}
            <ErrorNote>{error}</ErrorNote>
            <button type="button" className="secondary-btn" onClick={refresh}>
              Check again
            </button>
            <button type="button" className="link-btn danger" disabled={cancelling} onClick={() => void cancelRequest()}>
              {cancelling ? "Cancelling…" : "Cancel request"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!lookup.accepting) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title={lookup.name} onBack={onBack} />
          <EmptyNote
            title="This class isn't taking new families"
            body="The admin may have paused joining or archived the class."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader
          title={lookup.name}
          subtitle={lookup.joinMode === "open" ? "Anyone with this code can join." : "A class admin reviews each request."}
          onBack={onBack}
        />
        {lookup.description && <p className="feature-lede">{lookup.description}</p>}

        {!token ? (
          <>
            <div className="signin-gate compact">
              <h2>Sign in to join</h2>
              <p>Parents hold the account. Your child's name is only visible to this class.</p>
              <button type="button" className="primary-btn" onClick={onNeedAuth}>
                Sign in or create an account
              </button>
            </div>
          </>
        ) : (
          <div className="feature-card">
            <h2>Who is joining?</h2>
            <p className="helper">
              Use your own name so the class admin knows who is asking, then add your child's first name or a
              nickname. Only this class can see the child's name, and it never appears on public pages.
            </p>
            <label className="field">
              <span>Your name</span>
              <input
                type="text"
                value={parentName}
                maxLength={80}
                autoComplete="name"
                onChange={(event) => setParentName(event.target.value)}
                placeholder="e.g. Alex"
              />
            </label>
            {names.map((name, index) => (
              <label key={index} className="field">
                <span>Child {index + 1}</span>
                <input
                  type="text"
                  value={name}
                  maxLength={60}
                  autoComplete="off"
                  onChange={(event) =>
                    setNames((current) => current.map((value, i) => (i === index ? event.target.value : value)))
                  }
                  placeholder="e.g. Mia"
                />
              </label>
            ))}
            {names.length < 5 && (
              <button type="button" className="link-btn" onClick={() => setNames((current) => [...current, ""])}>
                + Add another child
              </button>
            )}
            <ErrorNote>{error}</ErrorNote>
            <button type="button" className="primary-btn" disabled={joining} onClick={() => void join()}>
              {joining ? "Joining…" : lookup.joinMode === "open" ? "Join class" : "Request to join"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
