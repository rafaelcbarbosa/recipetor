import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

type Report = {
  id: string;
  recipeId: string;
  recipeTitle: string;
  recipeVisibility: "private" | "class" | "public" | null;
  reporterEmail: string | null;
  reason: string;
  details: string;
  status: string;
  createdAt: string;
};

const REASON_LABELS: Record<string, string> = {
  inappropriate: "Inappropriate content",
  "not-a-recipe": "Not a recipe",
  privacy: "Private information",
  copyright: "Copyright",
  spam: "Spam",
  other: "Something else",
};

export function AdminReportsScreen({
  token,
  onBack,
  onOpenRecipe,
}: {
  token: string | null;
  onBack: () => void;
  onOpenRecipe: (recipeId: string) => void;
}) {
  const [reports, setReports] = useState<Report[]>([]);
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ reports: Report[] }>(`/api/admin/reports?status=${status}`, { token });
      setReports(data.reports);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load reports.");
    } finally {
      setLoading(false);
    }
  }, [status, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(report: Report, action: "dismiss" | "unpublish") {
    const question =
      action === "unpublish"
        ? "Make this recipe private and close the report?"
        : "Dismiss this report?";
    if (!window.confirm(question)) return;
    try {
      await apiFetch(`/api/admin/reports/${report.id}/resolve`, {
        method: "POST",
        token,
        body: JSON.stringify({ action }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update that report.");
    }
  }

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader title="Reported recipes" subtitle="Site admin review" onBack={onBack} />

        <div className="segmented" role="tablist" aria-label="Report status">
          {(
            [
              ["open", "Open"],
              ["resolved", "Resolved"],
              ["all", "All"],
            ] as Array<[typeof status, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={status === value}
              className={`segmented-btn${status === value ? " active" : ""}`}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <ErrorNote>{error}</ErrorNote>
        {loading ? (
          <Loading label="Loading reports…" />
        ) : reports.length === 0 ? (
          <EmptyNote title="Nothing to review" body="Reports from the public feed show up here." />
        ) : (
          <div className="report-list">
            {reports.map((report) => (
              <article key={report.id} className="feature-card">
                <div className="feature-card-head">
                  <h2>{report.recipeTitle}</h2>
                  <span className={`report-status ${report.status}`}>{report.status}</span>
                </div>
                <p className="helper">
                  {REASON_LABELS[report.reason] ?? report.reason}
                  {report.reporterEmail ? ` · reported by ${report.reporterEmail}` : " · reporter unknown"}
                </p>
                {report.details && <p className="report-details">{report.details}</p>}
                <p className="helper">
                  {report.recipeVisibility ? `Currently ${report.recipeVisibility}` : "Recipe deleted"} ·{" "}
                  {new Date(report.createdAt).toLocaleString()}
                </p>
                <div className="feature-actions">
                  {report.recipeVisibility && (
                    <button type="button" className="secondary-btn small" onClick={() => onOpenRecipe(report.recipeId)}>
                      View recipe
                    </button>
                  )}
                  {report.status === "open" && (
                    <>
                      <button
                        type="button"
                        className="secondary-btn small"
                        onClick={() => void resolve(report, "dismiss")}
                      >
                        Dismiss
                      </button>
                      {report.recipeVisibility === "public" && (
                        <button
                          type="button"
                          className="primary-btn small"
                          onClick={() => void resolve(report, "unpublish")}
                        >
                          Make private
                        </button>
                      )}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
