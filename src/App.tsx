import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

type IngredientLine = {
  amount: number | null;
  unit: string;
  name: string;
};

type Recipe = {
  id: string;
  title: string;
  category: string;
  source: string;
  time: string;
  emoji: string;
  color: string;
  description: string;
  ingredients: IngredientLine[];
  steps: string[];
  basePortions?: number | null;
  isExample?: boolean;
  sourceUrls?: string[];
  sourceCount?: number;
};

const COMMON_UNITS = ["g", "kg", "ml", "l", "oz", "lb", "cup", "tbsp", "tsp", "piece", "pieces", "can", "clove", "slice", "units"];

const recipes: Recipe[] = [
  {
    id: "lemon-pasta",
    title: "Lemon butter pasta",
    category: "Dinner",
    source: "@oliveandthyme",
    time: "25 min",
    emoji: "🍋",
    color: "lemon",
    description: "Silky, bright, and ready before your favorite show starts.",
    basePortions: 4,
    ingredients: [
      { amount: 12, unit: "oz", name: "spaghetti" },
      { amount: 2, unit: "units", name: "lemons, zested and juiced" },
      { amount: 4, unit: "tbsp", name: "butter" },
      { amount: 0.5, unit: "cup", name: "finely grated parmesan" },
      { amount: null, unit: "", name: "freshly cracked black pepper" },
    ],
    steps: ["Cook the pasta in well-salted water until just shy of al dente. Save a mug of pasta water.", "Melt butter in a wide pan. Add lemon zest and a splash of pasta water.", "Toss in the pasta, lemon juice, and parmesan until glossy. Add more pasta water as needed.", "Finish with plenty of black pepper and extra parmesan."],
  },
  {
    id: "crispy-chickpeas",
    title: "Crispy chickpea bowls",
    category: "Lunch",
    source: "@theweekdaytable",
    time: "30 min",
    emoji: "🥑",
    color: "avocado",
    description: "Crunchy spiced chickpeas, creamy avocado, and a zippy tahini drizzle.",
    basePortions: 2,
    ingredients: [
      { amount: 1, unit: "can", name: "chickpeas, drained and dried" },
      { amount: 1, unit: "units", name: "ripe avocado" },
      { amount: 2, unit: "cup", name: "cooked rice" },
      { amount: 1, unit: "tsp", name: "smoked paprika" },
      { amount: 2, unit: "tbsp", name: "tahini" },
      { amount: 1, unit: "tbsp", name: "lemon juice" },
    ],
    steps: ["Toss dry chickpeas with olive oil, paprika, salt, and pepper.", "Roast at 425°F for 25–30 minutes, shaking the pan once.", "Whisk tahini, lemon juice, and a little warm water until pourable.", "Serve chickpeas over rice with avocado and tahini sauce."],
  },
  {
    id: "berry-pancakes",
    title: "Sunday berry pancakes",
    category: "Breakfast",
    source: "@morningswithmia",
    time: "20 min",
    emoji: "🫐",
    color: "berry",
    description: "Fluffy, golden pancakes with juicy berries in every bite.",
    basePortions: 4,
    ingredients: [
      { amount: 1.5, unit: "cup", name: "all-purpose flour" },
      { amount: 1, unit: "tbsp", name: "baking powder" },
      { amount: 1.25, unit: "cup", name: "milk" },
      { amount: 1, unit: "units", name: "egg" },
      { amount: 2, unit: "tbsp", name: "melted butter" },
      { amount: 1, unit: "cup", name: "fresh blueberries" },
    ],
    steps: ["Whisk flour and baking powder in a large bowl.", "In another bowl, whisk milk, egg, and melted butter. Fold into the dry ingredients.", "Gently fold in blueberries. Leave a few lumps in the batter.", "Cook small scoops on a buttered skillet until bubbles form, then flip and cook until golden."],
  },
];

const categories = ["All recipes", "Breakfast", "Lunch", "Dinner", "Dessert", "Snack", "Other"];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    search: "m21 21-4.34-4.34 M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z",
    plus: "M12 5v14 M5 12h14",
    bookmark: "M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-4-6 4V4.75Z",
    clock: "M12 8v4l2.5 1.5 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    grid: "M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z",
    collection: "M4 5.5h16 M4 10.5h16 M4 15.5h10 M4 20.5h10",
    share: "M12 16V3m0 0L7 8m5-5 5 5 M5 13v7h14v-7",
    close: "M18 6 6 18 M6 6l12 12",
    link: "M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.71 M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.71-1.71",
    instagram: "M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Zm5 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm5.5-.5h.01",
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
      {name === "instagram" && <circle cx="12" cy="12" r="3" />}
      {name === "instagram" && <circle cx="17.5" cy="6.5" r=".75" fill="currentColor" stroke="none" />}
    </svg>
  );
}

function App() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All recipes");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [showFavorites, setShowFavorites] = useState(false);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [instagramLink, setInstagramLink] = useState("");
  const [notice, setNotice] = useState("");
  const [savedRecipes, setSavedRecipes] = useState<Recipe[]>([]);
  const [serverState, setServerState] = useState<"checking" | "ready" | "hermes-missing" | "offline">("checking");
  const [isImporting, setIsImporting] = useState(false);
  const [portions, setPortions] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error("Recipe server health check failed.");
        return response.json() as Promise<{ ok: boolean; hermesAvailable: boolean }>;
      })
      .then((health) => {
        if (active) setServerState(health.ok ? health.hermesAvailable ? "ready" : "hermes-missing" : "offline");
      })
      .catch(() => {
        if (active) setServerState("offline");
      });

    void fetch("/api/recipes")
      .then(async (response) => {
        if (!response.ok) throw new Error("Saved recipes could not be loaded.");
        return response.json() as Promise<{ recipes: Recipe[] }>;
      })
      .then((result) => {
        if (active) setSavedRecipes(result.recipes);
      })
      .catch(() => {
        if (active) setNotice("Saved recipes couldn't be loaded. Check the recipe server and refresh.");
      });

    return () => { active = false; };
  }, []);

  const allRecipes = [...savedRecipes, ...recipes];
  const visibleRecipes = allRecipes.filter((recipe) => {
    const matchesCategory = category === "All recipes" || recipe.category === category;
    const matchesQuery = `${recipe.title} ${recipe.category} ${recipe.source}`.toLowerCase().includes(query.toLowerCase());
    const matchesFavorites = !showFavorites || favorites.includes(recipe.id);
    return matchesCategory && matchesQuery && matchesFavorites;
  });

  async function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let url: URL;
    try {
      url = new URL(instagramLink.trim());
    } catch {
      setNotice("Enter a complete Instagram link to continue.");
      return;
    }

    if (
      url.protocol !== "https:" ||
      !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
      !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]+\/?$/i.test(url.pathname)
    ) {
      setNotice("That doesn't look like an Instagram link. Check the URL and try again.");
      return;
    }

    setIsImporting(true);
    setNotice("Checking the link and extracting the recipe…");
    try {
      const response = await fetch("/api/recipes/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.href }),
      });
      const result = await response.json() as {
        recipe?: Recipe;
        duplicate?: boolean;
        reason?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error || "Recipe import failed. Try again.");
      if (!result.recipe) throw new Error("The server returned no recipe. Try again.");

      const importedRecipe = result.recipe;
      setSavedRecipes((current) => [
        importedRecipe,
        ...current.filter((recipe) => recipe.id !== importedRecipe.id),
      ]);
      setSelectedRecipe(importedRecipe);
      setPortions(importedRecipe.basePortions ?? null);
      setInstagramLink("");
      setNotice(
        result.reason === "source"
          ? "This link was already saved. Here’s the recipe."
          : result.duplicate
            ? "Same recipe found. The new Instagram link was added to it."
            : "Recipe extracted and saved to your recipe box.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recipe import failed. Try again.");
    } finally {
      setIsImporting(false);
    }
  }

  async function shareRecipe(recipe: Recipe) {
    const shareData = { title: recipe.title, text: `Try this recipe: ${recipe.title}`, url: window.location.href };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        setNotice("Recipe shared.");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setNotice("Couldn't share this recipe right now.");
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(`${shareData.text} — ${shareData.url}`);
      setNotice("Recipe link copied to clipboard.");
    } catch {
      setNotice("Sharing isn't available in this browser.");
    }
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => current.includes(id) ? current.filter((favorite) => favorite !== id) : [...current, id]);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="Recipetor home">
          <span className="brand-mark">r<span>.</span></span>
          <span>recipetor</span>
        </a>
        <div className="sidebar-label">YOUR KITCHEN</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button className={`nav-item ${!showFavorites ? "active" : ""}`} onClick={() => setShowFavorites(false)}>
            <Icon name="grid" /> <span>My recipes</span><span className="nav-count">{allRecipes.length}</span>
          </button>
          <button className={`nav-item ${showFavorites ? "active" : ""}`} onClick={() => setShowFavorites(true)}>
            <Icon name="bookmark" /> <span>Favorites</span>
          </button>
          <button className="nav-item" onClick={() => { setShowFavorites(false); setCategory("All recipes"); }}>
            <Icon name="collection" /> <span>All collections</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note"><span className="privacy-dot" /> Just your recipes. No personal profile needed.</div>
          <div className="account-chip"><span className="avatar">R</span><span><strong>Your kitchen</strong><small>Private recipe box</small></span></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="mobile-header">
          <a className="brand" href="#" aria-label="Recipetor home"><span className="brand-mark">r<span>.</span></span><span>recipetor</span></a>
          <button className={`mobile-favorite ${showFavorites ? "active" : ""}`} aria-label="Toggle favorites" onClick={() => setShowFavorites(!showFavorites)}><Icon name="bookmark" /></button>
        </header>

        <div className="content-wrap">
          <div className="topline">
            <div className="breadcrumb"><span>Your kitchen</span><span className="breadcrumb-separator">/</span><strong>{showFavorites ? "Favorites" : "Recipe box"}</strong></div>
            <span className="free-badge"><span /> Always free</span>
          </div>

          <section className="welcome-row">
            <div>
              <p className="eyebrow">A LITTLE INSPIRATION, SAVED</p>
              <h1>{showFavorites ? "Your favorites" : "Your recipe box"}</h1>
              <p className="welcome-copy">Good food deserves a place you can find it again.</p>
            </div>
            <button className="primary-button desktop-add" onClick={() => document.getElementById("instagram-link")?.focus()}><Icon name="plus" /> Add a recipe</button>
          </section>

          <section className="import-card" aria-labelledby="import-title">
            <div className="import-icon"><Icon name="instagram" size={23} /></div>
            <div className="import-content">
              <div className="import-heading">
                <div>
                  <h2 id="import-title">Found something delicious?</h2>
                  <p>Drop in an Instagram link. We’ll turn it into a recipe you can actually cook.</p>
                </div>
                <span className="import-sparkle" aria-hidden="true">✳</span>
              </div>
              <form className="import-form" onSubmit={handleImport}>
                <label className="sr-only" htmlFor="instagram-link">Instagram recipe link</label>
                <Icon name="link" size={17} />
                <input id="instagram-link" type="url" value={instagramLink} onChange={(event) => { setInstagramLink(event.target.value); setNotice(""); }} placeholder="Paste an Instagram reel or post link" />
                <button type="submit" disabled={isImporting}>{isImporting ? "Checking…" : <>Find recipe <Icon name="arrow" size={16} /></>}</button>
              </form>
              <div className="import-foot">
                <span className={`server-status server-${serverState}`}><span />
                  {serverState === "checking" ? "Checking recipe server…" : serverState === "ready" ? "Hermes connected" : serverState === "hermes-missing" ? "Hermes is not available on the server" : "Recipe server unavailable"}
                </span>
                <span>Duplicate recipes are grouped together.</span>
              </div>
              {notice && <p className="notice" role="status">{notice}</p>}
            </div>
          </section>

          <section className="library-section" aria-labelledby="library-title">
            <div className="library-heading">
              <div><h2 id="library-title">{showFavorites ? "Saved favorites" : "Your collection"} <span className="recipe-count">{visibleRecipes.length}</span></h2><p>{savedRecipes.length ? "Your imported recipes, all in one place." : "A few examples to get your kitchen started."}</p></div>
              <label className="search-box">
                <Icon name="search" size={18} />
                <span className="sr-only">Search recipes</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search recipes..." />
                <kbd>/</kbd>
              </label>
            </div>

            <div className="category-row" aria-label="Filter recipes by category">
              {categories.map((item) => <button key={item} className={`category-chip ${category === item ? "selected" : ""}`} onClick={() => setCategory(item)}>{item}</button>)}
            </div>

            {visibleRecipes.length > 0 ? <div className="recipe-grid">
              {visibleRecipes.map((recipe, index) => (
                <article className="recipe-card" key={recipe.id} onClick={() => setSelectedRecipe(recipe)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedRecipe(recipe); }} tabIndex={0}>
                  <div className={`recipe-art ${recipe.color}`}>
                    <span className="art-orbit orbit-one" /><span className="art-orbit orbit-two" />
                    <span className="food-emoji" aria-hidden="true">{recipe.emoji}</span>
                    <span className={`example-tag ${recipe.isExample === false ? "saved-tag" : ""}`}>{recipe.isExample === false ? "SAVED" : "EXAMPLE"}</span>
                    <button className={`favorite-button ${favorites.includes(recipe.id) ? "favorited" : ""}`} aria-label={favorites.includes(recipe.id) ? "Remove from favorites" : "Add to favorites"} onClick={(event) => { event.stopPropagation(); toggleFavorite(recipe.id); }}>
                      <Icon name="bookmark" size={17} />
                    </button>
                    <span className="card-number">0{index + 1}</span>
                  </div>
                  <div className="recipe-card-body">
                    <div className="card-meta"><span>{recipe.category}</span><span className="meta-dot" /><span><Icon name="clock" size={14} /> {recipe.time}</span></div>
                    <h3>{recipe.title}</h3>
                    <p className="recipe-source">from <strong>{recipe.source}</strong></p>
                    <div className="card-bottom"><span>View recipe</span><span className="round-arrow"><Icon name="arrow" size={15} /></span></div>
                  </div>
                </article>
              ))}
            </div> : <div className="empty-state"><span className="empty-icon"><Icon name={showFavorites ? "bookmark" : "search"} size={22} /></span><h3>{showFavorites ? "No favorites yet" : "No recipes found"}</h3><p>{showFavorites ? "Tap the bookmark on a recipe to keep it close." : "Try another search or choose a different category."}</p></div>}
            <p className="sample-note">{savedRecipes.length ? "Add another Instagram recipe whenever inspiration strikes." : "These example recipes are here to help you explore."}</p>
          </section>
          <footer className="page-footer"><span>Made for the recipes you want to make.</span><span>Simple, free, and yours.</span></footer>
        </div>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button className={!showFavorites ? "selected" : ""} onClick={() => setShowFavorites(false)}><Icon name="grid" /><span>Recipes</span></button>
          <button className={showFavorites ? "selected" : ""} onClick={() => setShowFavorites(true)}><Icon name="bookmark" /><span>Favorites</span></button>
          <button onClick={() => document.getElementById("instagram-link")?.focus()}><Icon name="plus" /><span>Add link</span></button>
        </nav>
      </main>

      {selectedRecipe && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedRecipe(null); }}>
        <section className="recipe-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <button className="modal-close" aria-label="Close recipe" onClick={() => setSelectedRecipe(null)}><Icon name="close" /></button>
          <div className={`modal-art ${selectedRecipe.color}`}><span aria-hidden="true">{selectedRecipe.emoji}</span></div>
          <div className="modal-content">
            <div className="card-meta"><span>{selectedRecipe.category}</span><span className="meta-dot" /><span><Icon name="clock" size={14} /> {selectedRecipe.time}</span></div>
            <h2 id="modal-title">{selectedRecipe.title}</h2>
            <p className="modal-description">{selectedRecipe.description}</p>
            <p className="modal-source">{selectedRecipe.isExample === false ? "Saved from" : "Example source"} <strong>{selectedRecipe.source}</strong> {selectedRecipe.isExample !== false && <span className="example-tag inline-tag">EXAMPLE</span>}</p>
            {selectedRecipe.sourceUrls && <div className="source-links"><strong>Instagram links</strong>{selectedRecipe.sourceUrls.map((sourceUrl, index) => <a key={sourceUrl} href={sourceUrl} target="_blank" rel="noreferrer">Source {index + 1} <Icon name="arrow" size={13} /></a>)}</div>}
            <div className="modal-actions"><button className="primary-button" onClick={() => toggleFavorite(selectedRecipe.id)}><Icon name="bookmark" /> {favorites.includes(selectedRecipe.id) ? "Saved to favorites" : "Save recipe"}</button><button className="secondary-button" onClick={() => void shareRecipe(selectedRecipe)}><Icon name="share" /> Share</button></div>
            <div className="modal-recipe-columns">
              <div>
                <div className="ingredients-header">
                  <h3>Ingredients <span>({selectedRecipe.ingredients.length})</span></h3>
                  {selectedRecipe.basePortions && <div className="portions-control">
                    <label>Portions</label>
                    <input type="number" min="1" value={portions ?? selectedRecipe.basePortions} onChange={(event) => setPortions(Math.max(1, parseInt(event.target.value, 10) || 1))} />
                  </div>}
                </div>
                <ul>
                  {selectedRecipe.ingredients.map((ingredient, index) => {
                    const scale = selectedRecipe.basePortions && portions ? portions / selectedRecipe.basePortions : 1;
                    const scaledAmount = ingredient.amount !== null ? ingredient.amount * scale : null;
                    return (
                      <li key={index} className="ingredient-line">
                        <span className="ingredient-amount">{scaledAmount !== null ? scaledAmount.toString().replace(/\.0$/, "") : ""}</span>
                        <select className="ingredient-unit" value={ingredient.unit} onChange={() => { /* unit selection stored per line */ }}>
                          <option value="">—</option>
                          {COMMON_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                        </select>
                        <span className="ingredient-name">{ingredient.name}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div><h3>Let’s make it</h3><ol>{selectedRecipe.steps.map((step) => <li key={step}>{step}</li>)}</ol></div>
            </div>
          </div>
        </section>
      </div>}
    </div>
  );
}

export default App;
