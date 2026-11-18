import { useEffect, useState } from "react";
import { apiFetch, type PublicRecipe } from "../lib/api";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

type PublicSummary = Pick<
  PublicRecipe,
  | "id"
  | "title"
  | "description"
  | "cuisine"
  | "mealTypes"
  | "dietTags"
  | "allergenTags"
  | "prepTimeMinutes"
  | "imageUrl"
  | "ratingAvg"
  | "ratingCount"
  | "sourceCredit"
  | "sharedBy"
  | "updatedAt"
>;

export function DiscoverScreen({
  token,
  onOpenRecipe,
  onBack,
  onNeedAuth,
}: {
  token: string | null;
  onOpenRecipe: (id: string) => void;
  onBack: () => void;
  onNeedAuth: () => void;
}) {
  const [query, setQuery] = useState("");
  const [recipes, setRecipes] = useState<PublicSummary[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(nextPage: number, append: boolean) {
    setLoading(true);
    try {
      const data = await apiFetch<{ recipes: PublicSummary[]; hasMore: boolean; total: number }>(
        `/api/public/recipes?page=${nextPage}&q=${encodeURIComponent(query)}`,
        { token },
      );
      setRecipes((current) => (append ? [...current, ...data.recipes] : data.recipes));
      setHasMore(data.hasMore);
      setTotal(data.total);
      setPage(nextPage);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load Discover.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1, false), query ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader
          title="Discover"
          subtitle="Class-only recipes stay private. Public recipes are shared by other families."
          onBack={onBack}
        />

        {!token && (
          <button type="button" className="feature-banner" onClick={onNeedAuth}>
            Sign in to save recipes and report anything that looks wrong.
          </button>
        )}

        <div className="search">
          <span aria-hidden="true">🔍</span>
          <label className="sr-only" htmlFor="discover-search">
            Search public recipes
          </label>
          <input
            id="discover-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search public recipes"
          />
        </div>

        <ErrorNote>{error}</ErrorNote>
        {loading && recipes.length === 0 ? (
          <Loading label="Looking for recipes…" />
        ) : recipes.length === 0 ? (
          <EmptyNote
            title="Nothing here yet"
            body={query ? "Try a different search." : "When families share a recipe publicly, it appears here."}
          />
        ) : (
          <>
            <p className="helper">{total} public {total === 1 ? "recipe" : "recipes"}</p>
            <div className="discover-grid">
              {recipes.map((recipe) => (
                <button type="button" key={recipe.id} className="discover-card" onClick={() => onOpenRecipe(recipe.id)}>
                  {recipe.imageUrl ? (
                    <img src={recipe.imageUrl} alt="" loading="lazy" />
                  ) : (
                    <span className="discover-placeholder" aria-hidden="true">
                      🥘
                    </span>
                  )}
                  <span className="discover-title">{recipe.title}</span>
                  <span className="discover-meta">
                    {[recipe.cuisine, recipe.mealTypes?.[0], recipe.prepTimeMinutes ? `${recipe.prepTimeMinutes} min` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="discover-credit">{recipe.sharedBy}</span>
                </button>
              ))}
            </div>
            {hasMore && (
              <button type="button" className="secondary-btn" disabled={loading} onClick={() => void load(page + 1, true)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
