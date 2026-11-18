import { useEffect, useState } from "react";
import { apiFetch, type PublicRecipe } from "../lib/api";
import { ErrorNote, Loading, ScreenHeader } from "./ui";

const REPORT_REASONS = [
  ["inappropriate", "Inappropriate content"],
  ["not-a-recipe", "Not a recipe"],
  ["privacy", "Shares someone's private information"],
  ["copyright", "Copyright"],
  ["spam", "Spam"],
  ["other", "Something else"],
] as const;

export function PublicRecipeScreen({
  recipeId,
  token,
  onBack,
  onNeedAuth,
  onOpenPrivacy,
}: {
  recipeId: string;
  token: string | null;
  onBack: () => void;
  onNeedAuth: () => void;
  onOpenPrivacy: () => void;
}) {
  const [recipe, setRecipe] = useState<PublicRecipe | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showReport, setShowReport] = useState(false);
  const [reason, setReason] = useState<string>("inappropriate");
  const [details, setDetails] = useState("");
  const [reportSent, setReportSent] = useState(false);
  const [notice, setNotice] = useState("");
  const [servings, setServings] = useState<number | null>(null);
  const [stepIndex, setStepIndex] = useState(-1);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ recipe: PublicRecipe }>(`/api/public/recipes/${recipeId}`, { token })
      .then((data) => {
        setRecipe(data.recipe);
        setServings(data.recipe.baseServings ?? null);
        setError("");
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [recipeId, token]);

  async function toggleFavorite() {
    if (!token) {
      onNeedAuth();
      return;
    }
    if (!recipe) return;
    const next = !recipe.isFavorite;
    setRecipe({ ...recipe, isFavorite: next });
    try {
      await apiFetch(`/api/public/recipes/${recipe.id}/favorite`, { method: next ? "POST" : "DELETE", token });
      setNotice(next ? "Saved to your favorites." : "Removed from favorites.");
    } catch (err) {
      setRecipe({ ...recipe, isFavorite: !next });
      setNotice(err instanceof Error ? err.message : "Couldn't update your favorites.");
    }
  }

  async function submitReport() {
    if (!recipe) return;
    try {
      await apiFetch(`/api/public/recipes/${recipe.id}/report`, {
        method: "POST",
        token,
        body: JSON.stringify({ reason, details }),
      });
      setReportSent(true);
      setShowReport(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't send that report.");
    }
  }

  if (loading) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Recipe" onBack={onBack} />
          <Loading />
        </div>
      </div>
    );
  }

  if (!recipe) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Recipe" onBack={onBack} />
          <div className="empty-state">
            <p className="empty-title">This recipe isn't available</p>
            <p className="empty-body">It may have been made private, or the link is wrong.</p>
          </div>
        </div>
      </div>
    );
  }

  const ratio =
    recipe.baseServings && servings ? Math.max(0.1, servings / recipe.baseServings) : 1;
  const scale = (value: number | null) =>
    value == null ? "" : String(Math.round(value * ratio * 100) / 100);

  return (
    <div className="app feature-app public-recipe">
      <div className="screen">
        <ScreenHeader title="Shared recipe" onBack={onBack} />
        <ErrorNote>{error}</ErrorNote>
        {recipe.imageUrl ? (
          <img className="public-hero" src={recipe.imageUrl} alt={recipe.title} />
        ) : (
          <div className="public-hero placeholder" aria-hidden="true">
            🥘
          </div>
        )}
        <h1 className="public-title">{recipe.title}</h1>
        <p className="public-credit">
          {recipe.sharedBy}
          {recipe.sourceCredit ? (
            <>
              {" · "}
              {recipe.sourceUrl ? (
                <a href={recipe.sourceUrl} target="_blank" rel="noreferrer noopener">
                  Source: {recipe.sourceCredit}
                </a>
              ) : (
                `Source: ${recipe.sourceCredit}`
              )}
            </>
          ) : recipe.sourceUrl ? (
            <>
              {" · "}
              <a href={recipe.sourceUrl} target="_blank" rel="noreferrer noopener">
                Original post
              </a>
            </>
          ) : null}
        </p>
        {recipe.description && <p className="feature-lede">{recipe.description}</p>}

        <div className="public-facts">
          <span>{recipe.prepTimeMinutes} min</span>
          {recipe.baseServings ? <span>Serves {servings ?? recipe.baseServings}</span> : null}
          {recipe.cuisine && <span>{recipe.cuisine}</span>}
        </div>

        {(recipe.allergenTags?.length ?? 0) > 0 && (
          <div className="allergen-row">
            {recipe.allergenTags.map((tag) => (
              <span key={tag} className="allergen-tag">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="feature-actions">
          <button type="button" className={`primary-btn${recipe.isFavorite ? " is-saved" : ""}`} onClick={() => void toggleFavorite()}>
            {recipe.isFavorite ? "♥ Saved" : "♡ Save recipe"}
          </button>
          {recipe.baseServings ? (
            <span className="servings-stepper">
              <button type="button" className="round-btn" aria-label="Fewer servings" onClick={() => setServings((v) => Math.max(1, (v ?? 1) - 1))}>
                −
              </button>
              <span>{servings ?? recipe.baseServings}</span>
              <button type="button" className="round-btn" aria-label="More servings" onClick={() => setServings((v) => Math.min(50, (v ?? 1) + 1))}>
                +
              </button>
            </span>
          ) : null}
        </div>

        <ErrorNote>{notice}</ErrorNote>

        <section className="feature-card">
          <h2>Ingredients</h2>
          <ul className="check-list">
            {recipe.ingredients.map((item, index) => (
              <li key={index}>
                <strong>{[scale(item.amount), item.unit].filter(Boolean).join(" ")}</strong> {item.name}
              </li>
            ))}
          </ul>
        </section>

        <section className="feature-card">
          <div className="feature-card-head">
            <h2>Steps</h2>
            <button type="button" className="link-btn" onClick={() => setStepIndex(stepIndex === -1 ? 0 : -1)}>
              {stepIndex === -1 ? "Start cook mode" : "Exit cook mode"}
            </button>
          </div>
          {stepIndex === -1 ? (
            <ol className="cook-steps">
              {recipe.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          ) : (
            <div className="cook-mode">
              <p className="cook-step-count">
                Step {stepIndex + 1} of {recipe.steps.length}
              </p>
              <p className="cook-step-text">{recipe.steps[stepIndex]}</p>
              <div className="cook-mode-controls">
                <button type="button" className="secondary-btn" disabled={stepIndex === 0} onClick={() => setStepIndex((v) => Math.max(0, v - 1))}>
                  Back
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={stepIndex >= recipe.steps.length - 1}
                  onClick={() => setStepIndex((v) => Math.min(recipe.steps.length - 1, v + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>

        <button type="button" className="link-btn" onClick={() => (token ? setShowReport(true) : onNeedAuth())}>
          Report this recipe
        </button>
        <button type="button" className="link-btn muted" onClick={onOpenPrivacy}>
          What gets shared publicly?
        </button>
        {reportSent && <p className="helper">Thanks — the site admin will review it.</p>}
      </div>

      {showReport && (
        <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setShowReport(false)}>
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="report-title">
            <div className="sheet-head">
              <h2 id="report-title">Report recipe</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowReport(false)}>
                ✕
              </button>
            </div>
            {REPORT_REASONS.map(([value, label]) => (
              <label key={value} className="radio-row">
                <input type="radio" name="reportReason" checked={reason === value} onChange={() => setReason(value)} />
                <span>{label}</span>
              </label>
            ))}
            <label className="field">
              <span>Details (optional)</span>
              <textarea rows={3} maxLength={500} value={details} onChange={(event) => setDetails(event.target.value)} />
            </label>
            <button type="button" className="primary-btn" onClick={() => void submitReport()}>
              Send report
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
