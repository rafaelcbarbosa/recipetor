import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

type Nutrition = {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
};

type IngredientLine = {
  amount: number | null;
  unit: string;
  name: string;
  nutrition?: Nutrition;
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
  totals?: Nutrition | null;
  isExample?: boolean;
  sourceUrls?: string[];
  sourceCount?: number;
};

const COMMON_UNITS = ["g", "kg", "ml", "l", "oz", "lb", "cup", "tbsp", "tsp", "piece", "pieces", "can", "clove", "slice", "units"];

const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
  g: { kg: 0.001, oz: 0.035274, lb: 0.00220462 },
  kg: { g: 1000, oz: 35.274, lb: 2.20462 },
  ml: { l: 0.001, cup: 0.00422675, tbsp: 0.067628, tsp: 0.202884, oz: 0.033814 },
  l: { ml: 1000, cup: 4.22675, tbsp: 67.628, tsp: 202.884, oz: 33.814 },
  oz: { g: 28.3495, kg: 0.0283495, lb: 0.0625, ml: 29.5735, l: 0.0295735, cup: 0.125, tbsp: 2, tsp: 6 },
  lb: { g: 453.592, kg: 0.453592, oz: 16 },
  cup: { ml: 236.588, l: 0.236588, tbsp: 16, tsp: 48, oz: 8 },
  tbsp: { ml: 14.7868, l: 0.0147868, cup: 0.0625, tsp: 3, oz: 0.5 },
  tsp: { ml: 4.92892, l: 0.00492892, cup: 0.0208333, tbsp: 0.333333, oz: 0.166667 },
  piece: { pieces: 1 },
  pieces: { piece: 1 },
  can: {},
  clove: {},
  slice: {},
  units: {},
};

function convertAmount(amount: number, fromUnit: string, toUnit: string): number | null {
  if (fromUnit === toUnit) return amount;
  if (!fromUnit || !toUnit) return null;
  const conversion = UNIT_CONVERSIONS[fromUnit]?.[toUnit];
  return conversion ? amount * conversion : null;
}

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
      { amount: 12, unit: "oz", name: "spaghetti", nutrition: { calories: 220, protein: 8, carbs: 43, fat: 1 } },
      { amount: 2, unit: "units", name: "lemons, zested and juiced", nutrition: { calories: 34, protein: 1, carbs: 11, fat: 0 } },
      { amount: 4, unit: "tbsp", name: "butter", nutrition: { calories: 407, protein: 0, carbs: 0, fat: 46 } },
      { amount: 0.5, unit: "cup", name: "finely grated parmesan", nutrition: { calories: 216, protein: 19, carbs: 2, fat: 14 } },
      { amount: null, unit: "", name: "freshly cracked black pepper", nutrition: { calories: null, protein: null, carbs: null, fat: null } },
    ],
    steps: ["Cook the pasta in well-salted water until just shy of al dente. Save a mug of pasta water.", "Melt butter in a wide pan. Add lemon zest and a splash of pasta water.", "Toss in the pasta, lemon juice, and parmesan until glossy. Add more pasta water as needed.", "Finish with plenty of black pepper and extra parmesan."],
    totals: { calories: 219, protein: 7, carbs: 14, fat: 15 },
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
      { amount: 1, unit: "can", name: "chickpeas, drained and dried", nutrition: { calories: 210, protein: 11, carbs: 35, fat: 4 } },
      { amount: 1, unit: "units", name: "ripe avocado", nutrition: { calories: 234, protein: 3, carbs: 12, fat: 21 } },
      { amount: 2, unit: "cup", name: "cooked rice", nutrition: { calories: 416, protein: 8, carbs: 90, fat: 1 } },
      { amount: 1, unit: "tsp", name: "smoked paprika", nutrition: { calories: 6, protein: 0, carbs: 1, fat: 0 } },
      { amount: 2, unit: "tbsp", name: "tahini", nutrition: { calories: 178, protein: 5, carbs: 6, fat: 16 } },
      { amount: 1, unit: "tbsp", name: "lemon juice", nutrition: { calories: 4, protein: 0, carbs: 1, fat: 0 } },
    ],
    steps: ["Toss dry chickpeas with olive oil, paprika, salt, and pepper.", "Roast at 425°F for 25–30 minutes, shaking the pan once.", "Whisk tahini, lemon juice, and a little warm water until pourable.", "Serve chickpeas over rice with avocado and tahini sauce."],
    totals: { calories: 524, protein: 13, carbs: 72, fat: 21 },
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
      { amount: 1.5, unit: "cup", name: "all-purpose flour", nutrition: { calories: 682, protein: 19, carbs: 143, fat: 2 } },
      { amount: 1, unit: "tbsp", name: "baking powder", nutrition: { calories: 2, protein: 0, carbs: 1, fat: 0 } },
      { amount: 1.25, unit: "cup", name: "milk", nutrition: { calories: 156, protein: 8, carbs: 12, fat: 8 } },
      { amount: 1, unit: "units", name: "egg", nutrition: { calories: 72, protein: 6, carbs: 0, fat: 5 } },
      { amount: 2, unit: "tbsp", name: "melted butter", nutrition: { calories: 204, protein: 0, carbs: 0, fat: 23 } },
      { amount: 1, unit: "cup", name: "fresh blueberries", nutrition: { calories: 84, protein: 1, carbs: 21, fat: 0 } },
    ],
    steps: ["Whisk flour and baking powder in a large bowl.", "In another bowl, whisk milk, egg, and melted butter. Fold into the dry ingredients.", "Gently fold in blueberries. Leave a few lumps in the batter.", "Cook small scoops on a buttered skillet until bubbles form, then flip and cook until golden."],
    totals: { calories: 300, protein: 8, carbs: 44, fat: 12 },
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
  const [commitInfo, setCommitInfo] = useState<{ hash: string; date: string; message: string } | null>(null);
  const [ingredientUnits, setIngredientUnits] = useState<Record<number, string>>({});
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("recipetor_token"));
  const [authMode, setAuthMode] = useState<"login" | "register" | null>(null);

  useEffect(() => {
    fetch("/commit-info.json")
      .then((res) => res.json())
      .then((data) => setCommitInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (token) localStorage.setItem("recipetor_token", token);
    else localStorage.removeItem("recipetor_token");
  }, [token]);

  async function checkAuth() {
    if (!token) return;
    try {
      const response = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        return;
      }
    } catch {}
    setToken(null);
    setUser(null);
  }

  useEffect(() => {
    checkAuth();
  }, [token]);

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

    if (token) {
      void fetch("/api/recipes", { headers: { Authorization: `Bearer ${token}` } })
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
    }

    return () => { active = false; };
  }, [token]);

  const allRecipes = [...savedRecipes, ...recipes];
  const visibleRecipes = allRecipes.filter((recipe) => {
    const matchesCategory = category === "All recipes" || recipe.category === category;
    const matchesQuery = `${recipe.title} ${recipe.category} ${recipe.source}`.toLowerCase().includes(query.toLowerCase());
    const matchesFavorites = !showFavorites || favorites.includes(recipe.id);
    return matchesCategory && matchesQuery && matchesFavorites;
  });

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string> || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(path, { ...options, headers });
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = formData.get("email")?.toString().trim().toLowerCase();
    const password = formData.get("password")?.toString();
    if (!email || !password) {
      setNotice("Email and password are required.");
      return;
    }
    const endpoint = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    setNotice(authMode === "register" ? "Creating account…" : "Signing in…");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Authentication failed.");
      setToken(data.token);
      setUser(data.user);
      setAuthMode(null);
      setNotice(authMode === "register" ? "Account created! Welcome to Recipetor." : "Welcome back!");
      await apiFetch("/api/recipes").then(async (response) => {
        if (response.ok) {
          const data = await response.json();
          setSavedRecipes(data.recipes || []);
        }
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Authentication failed. Try again.");
    }
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setSavedRecipes([]);
    setNotice("Signed out.");
  }

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
    setNotice("Checking the link…");
    try {
      const response = await apiFetch("/api/recipes/import", {
        method: "POST",
        body: JSON.stringify({ url: url.href }),
      });
      if (!response.ok) {
        let message = "Recipe import failed. Try again.";
        try {
          const errorData = await response.json();
          message = errorData.error || message;
        } catch {
          // response wasn't JSON
        }
        throw new Error(message);
      }
      setNotice("Extracting recipe with Hermes…");
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
      setIngredientUnits({});
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

  async function deleteRecipe(id: string) {
    if (!window.confirm("Delete this recipe?")) return;
    const response = await fetch(`/api/recipes/${id}`, { method: "DELETE" });
    if (!response.ok) {
      setNotice("Couldn't delete the recipe. Try again.");
      return;
    }
    setSelectedRecipe(null);
    setSavedRecipes((current) => current.filter((recipe) => recipe.id !== id));
    setNotice("Recipe deleted.");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="Recipetor home">
          <svg className="brand-icon" viewBox="0 0 512 512" aria-hidden="true">
            <defs>
              <linearGradient id="burritoBody" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#D4A574" stopOpacity={1} />
                <stop offset="100%" stopColor="#C49564" stopOpacity={1} />
              </linearGradient>
              <linearGradient id="burritoFilling" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#E8B87D" stopOpacity={1} />
                <stop offset="100%" stopColor="#D8A86D" stopOpacity={1} />
              </linearGradient>
              <linearGradient id="cheese" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#FFD700" stopOpacity={1} />
                <stop offset="100%" stopColor="#F0C000" stopOpacity={1} />
              </linearGradient>
              <linearGradient id="beans" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#4A2C1A" stopOpacity={1} />
                <stop offset="100%" stopColor="#3A1C0A" stopOpacity={1} />
              </linearGradient>
              <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx={0} dy={2} stdDeviation={3} floodColor="#000000" floodOpacity={0.2} />
              </filter>
            </defs>
            <path d="M120 180 Q120 120 180 120 L332 120 Q392 120 392 180 L392 332 Q392 392 332 392 L180 392 Q120 392 120 332 Z" fill="url(#burritoBody)" filter="url(#shadow)" />
            <path d="M140 180 Q140 140 180 140 L332 140 Q372 140 372 180 L372 200 Q372 220 332 220 L180 220 Q140 220 140 180 Z" fill="#B8956A" opacity={0.6} />
            <path d="M160 160 Q160 145 180 145 L332 145 Q352 145 352 160 L352 175 Q352 185 332 185 L180 185 Q160 185 160 160 Z" fill="url(#burritoFilling)" />
            <path d="M190 155 Q200 150 210 155 Q220 160 230 155 Q240 150 250 155 Q260 160 270 155 Q280 150 290 155 Q300 160 310 155 Q320 150 330 155" stroke="url(#cheese)" strokeWidth={8} fill="none" strokeLinecap="round" />
            <circle cx={200} cy={165} r={6} fill="url(#beans)" />
            <circle cx={240} cy={158} r={5} fill="url(#beans)" />
            <circle cx={280} cy={162} r={5} fill="url(#beans)" />
            <circle cx={310} cy={157} r={4} fill="url(#beans)" />
            <ellipse cx={220} cy={168} rx={3} ry={2} fill="#F5F0E8" />
            <ellipse cx={260} cy={170} rx={2.5} ry={1.8} fill="#F5F0E8" />
            <ellipse cx={300} cy={168} rx={2.5} ry={1.8} fill="#F5F0E8" />
            <path d="M185 170 Q180 165 185 160 Q190 165 185 170" fill="#4CAF50" opacity={0.8} />
            <path d="M255 175 Q250 170 255 165 Q260 170 255 175" fill="#4CAF50" opacity={0.8} />
            <path d="M295 172 Q290 167 295 162 Q300 167 295 172" fill="#4CAF50" opacity={0.8} />
            <circle cx={210} cy={260} r={18} fill="#2D2D2D" />
            <circle cx={302} cy={260} r={18} fill="#2D2D2D" />
            <circle cx={215} cy={255} r={6} fill="#FFFFFF" />
            <circle cx={307} cy={255} r={6} fill="#FFFFFF" />
            <path d="M210 300 Q256 330 302 300" stroke="#2D2D2D" strokeWidth={4} fill="none" strokeLinecap="round" />
            <ellipse cx={175} cy={275} rx={15} ry={8} fill="#E8A8A8" opacity={0.5} />
            <ellipse cx={337} cy={275} rx={15} ry={8} fill="#E8A8A8" opacity={0.5} />
            <path d="M256 100 Q250 80 256 60" stroke="#FFFFFF" strokeWidth={3} fill="none" opacity={0.6} strokeLinecap="round" />
            <path d="M230 110 Q225 90 230 70" stroke="#FFFFFF" strokeWidth={2} fill="none" opacity={0.4} strokeLinecap="round" />
            <path d="M282 110 Q287 90 282 70" stroke="#FFFFFF" strokeWidth={2} fill="none" opacity={0.4} strokeLinecap="round" />
          </svg>
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
                  {user ? (
                    <div className="account-section">
                      <div className="user-info">
                        <span className="avatar"><svg className="avatar-icon" viewBox="0 0 512 512" aria-hidden="true"><path fill="#4A2C1A" d="M256 512c-141.4 0-256-94.6-256-211.3 0-147.3 147.6-209.3 165.3-231.1 4.1-5.1 9.3-8.1 14.7-8.1h180c5.4 0 10.6 3 14.7 8.1 17.7 21.8 165.3 83.8 165.3 231.1 0 116.7-114.6 211.3-256 211.3zm0-144c-44.2 0-80-35.8-80-80s35.8-80 80-80 80 35.8 80 80-35.8 80-80 80zm0-32c53 0 96-43 96-96s-43-96-96-96-96 43-96 96 43 96 96 96z"/></svg></span>
                        <span className="user-email">{user.email}</span>
                      </div>
                      <button className="btn btn-secondary" onClick={handleLogout}>Sign out</button>
                    </div>
                  ) : authMode ? (
                    <form onSubmit={handleAuth} className="auth-form">
                      <h3>{authMode === "register" ? "Create account" : "Sign in"}</h3>
                      <div className="form-field">
                        <label htmlFor="auth-email">Email</label>
                        <input id="auth-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
                      </div>
                      <div className="form-field">
                        <label htmlFor="auth-password">Password</label>
                        <input id="auth-password" name="password" type="password" autoComplete={authMode === "register" ? "new-password" : "current-password"} required placeholder="••••••••" />
                      </div>
                      <button type="submit" className="btn btn-primary">{authMode === "register" ? "Create account" : "Sign in"}</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setAuthMode(null)}>Cancel</button>
                      <p className="auth-switch">{authMode === "register" ? "Already have an account? " : "Don't have an account? "}<button type="button" onClick={() => setAuthMode(authMode === "register" ? "login" : "register")}>{authMode === "register" ? "Sign in" : "Create account"}</button></p>
                    </form>
                  ) : (
                    <div className="account-chip">
                      <span className="avatar"><svg className="avatar-icon" viewBox="0 0 512 512" aria-hidden="true"><path fill="#4A2C1A" d="M256 512c-141.4 0-256-94.6-256-211.3 0-147.3 147.6-209.3 165.3-231.1 4.1-5.1 9.3-8.1 14.7-8.1h180c5.4 0 10.6 3 14.7 8.1 17.7 21.8 165.3 83.8 165.3 231.1 0 116.7-114.6 211.3-256 211.3zm0-144c-44.2 0-80-35.8-80-80s35.8-80 80-80 80 35.8 80 80-35.8 80-80 80zm0-32c53 0 96-43 96-96s-43-96-96-96-96 43-96 96 43 96 96 96z"/></svg></span>
                      <span>Sign in to save recipes</span>
                      <button className="btn btn-primary btn-sm" onClick={() => setAuthMode("login")}>Sign in</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setAuthMode("register")}>Create account</button>
                    </div>
                  )}
                  <div className="privacy-note"><span className="privacy-dot" /> Just your recipes. No personal profile needed.</div>
                </div>
      </aside>

      <main className="main-content">
        <header className="mobile-header">
          <a className="brand" href="#" aria-label="Recipetor home">
            <svg className="brand-icon" viewBox="0 0 512 512" aria-hidden="true">
              <defs>
                <linearGradient id="burritoBody" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#D4A574" stopOpacity={1} />
                  <stop offset="100%" stopColor="#C49564" stopOpacity={1} />
                </linearGradient>
                <linearGradient id="burritoFilling" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#E8B87D" stopOpacity={1} />
                  <stop offset="100%" stopColor="#D8A86D" stopOpacity={1} />
                </linearGradient>
                <linearGradient id="cheese" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#FFD700" stopOpacity={1} />
                  <stop offset="100%" stopColor="#F0C000" stopOpacity={1} />
                </linearGradient>
                <linearGradient id="beans" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor="#4A2C1A" stopOpacity={1} />
                  <stop offset="100%" stopColor="#3A1C0A" stopOpacity={1} />
                </linearGradient>
                <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx={0} dy={2} stdDeviation={3} floodColor="#000000" floodOpacity={0.2} />
                </filter>
              </defs>
              <path d="M120 180 Q120 120 180 120 L332 120 Q392 120 392 180 L392 332 Q392 392 332 392 L180 392 Q120 392 120 332 Z" fill="url(#burritoBody)" filter="url(#shadow)" />
              <path d="M140 180 Q140 140 180 140 L332 140 Q372 140 372 180 L372 200 Q372 220 332 220 L180 220 Q140 220 140 180 Z" fill="#B8956A" opacity={0.6} />
              <path d="M160 160 Q160 145 180 145 L332 145 Q352 145 352 160 L352 175 Q352 185 332 185 L180 185 Q160 185 160 160 Z" fill="url(#burritoFilling)" />
              <path d="M190 155 Q200 150 210 155 Q220 160 230 155 Q240 150 250 155 Q260 160 270 155 Q280 150 290 155 Q300 160 310 155 Q320 150 330 155" stroke="url(#cheese)" strokeWidth={8} fill="none" strokeLinecap="round" />
              <circle cx={200} cy={165} r={6} fill="url(#beans)" />
              <circle cx={240} cy={158} r={5} fill="url(#beans)" />
              <circle cx={280} cy={162} r={5} fill="url(#beans)" />
              <circle cx={310} cy={157} r={4} fill="url(#beans)" />
              <ellipse cx={220} cy={168} rx={3} ry={2} fill="#F5F0E8" />
              <ellipse cx={260} cy={170} rx={2.5} ry={1.8} fill="#F5F0E8" />
              <ellipse cx={300} cy={168} rx={2.5} ry={1.8} fill="#F5F0E8" />
              <path d="M185 170 Q180 165 185 160 Q190 165 185 170" fill="#4CAF50" opacity={0.8} />
              <path d="M255 175 Q250 170 255 165 Q260 170 255 175" fill="#4CAF50" opacity={0.8} />
              <path d="M295 172 Q290 167 295 162 Q300 167 295 172" fill="#4CAF50" opacity={0.8} />
              <circle cx={210} cy={260} r={18} fill="#2D2D2D" />
              <circle cx={302} cy={260} r={18} fill="#2D2D2D" />
              <circle cx={215} cy={255} r={6} fill="#FFFFFF" />
              <circle cx={307} cy={255} r={6} fill="#FFFFFF" />
              <path d="M210 300 Q256 330 302 300" stroke="#2D2D2D" strokeWidth={4} fill="none" strokeLinecap="round" />
              <ellipse cx={175} cy={275} rx={15} ry={8} fill="#E8A8A8" opacity={0.5} />
              <ellipse cx={337} cy={275} rx={15} ry={8} fill="#E8A8A8" opacity={0.5} />
              <path d="M256 100 Q250 80 256 60" stroke="#FFFFFF" strokeWidth={3} fill="none" opacity={0.6} strokeLinecap="round" />
              <path d="M230 110 Q225 90 230 70" stroke="#FFFFFF" strokeWidth={2} fill="none" opacity={0.4} strokeLinecap="round" />
              <path d="M282 110 Q287 90 282 70" stroke="#FFFFFF" strokeWidth={2} fill="none" opacity={0.4} strokeLinecap="round" />
            </svg>
            <span>recipetor</span>
          </a>
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
                <article className="recipe-card" key={recipe.id} onClick={() => { setIngredientUnits({}); setSelectedRecipe(recipe); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { setIngredientUnits({}); setSelectedRecipe(recipe); } }} tabIndex={0}>
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
          <footer className="page-footer">
            <span>Made for the recipes you want to make.</span>
            <span>Simple, free, and yours.</span>
            {commitInfo && (
              <span className="commit-info">
                <Icon name="link" size={12} />
                <a href={`https://github.com/recipetor/recipetor/commit/${commitInfo.hash}`} target="_blank" rel="noopener noreferrer" title={commitInfo.message}>
                  {commitInfo.hash}
                </a>
                <span className="commit-date">{new Date(commitInfo.date).toLocaleDateString()}</span>
              </span>
            )}
          </footer>
        </div>

        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button className={!showFavorites ? "selected" : ""} onClick={() => setShowFavorites(false)}><Icon name="grid" /><span>Recipes</span></button>
          <button className={showFavorites ? "selected" : ""} onClick={() => setShowFavorites(true)}><Icon name="bookmark" /><span>Favorites</span></button>
          <button onClick={() => document.getElementById("instagram-link")?.focus()}><Icon name="plus" /><span>Add link</span></button>
        </nav>
      </main>

      {selectedRecipe && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedRecipe(null); }}>
        <section className="recipe-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <button className="modal-close" aria-label="Close recipe" onClick={() => { setSelectedRecipe(null); setIngredientUnits({}); }}><Icon name="close" /></button>
          <div className={`modal-art ${selectedRecipe.color}`}><span aria-hidden="true">{selectedRecipe.emoji}</span></div>
          <div className="modal-content">
            <div className="card-meta"><span>{selectedRecipe.category}</span><span className="meta-dot" /><span><Icon name="clock" size={14} /> {selectedRecipe.time}</span></div>
            <h2 id="modal-title">{selectedRecipe.title}</h2>
            <p className="modal-description">{selectedRecipe.description}</p>
            <p className="modal-source">{selectedRecipe.isExample === false ? "Saved from" : "Example source"} <strong>{selectedRecipe.source}</strong> {selectedRecipe.isExample !== false && <span className="example-tag inline-tag">EXAMPLE</span>}</p>
            {selectedRecipe.sourceUrls && <div className="source-links"><strong>Instagram links</strong>{selectedRecipe.sourceUrls.map((sourceUrl, index) => <a key={sourceUrl} href={sourceUrl} target="_blank" rel="noreferrer">Source {index + 1} <Icon name="arrow" size={13} /></a>)}</div>}
            {selectedRecipe.totals && <div className="nutrition-summary">
              <h3>Nutrition per portion</h3>
              <div className="nutrition-grid">
                <div className="nutrition-item"><span className="nutrition-value">{selectedRecipe.totals.calories}</span><span className="nutrition-label">kcal</span></div>
                <div className="nutrition-item"><span className="nutrition-value">{selectedRecipe.totals.protein}g</span><span className="nutrition-label">Protein</span></div>
                <div className="nutrition-item"><span className="nutrition-value">{selectedRecipe.totals.carbs}g</span><span className="nutrition-label">Carbs</span></div>
                <div className="nutrition-item"><span className="nutrition-value">{selectedRecipe.totals.fat}g</span><span className="nutrition-label">Fat</span></div>
              </div>
            </div>}
            <div className="modal-actions"><button className="primary-button" onClick={() => toggleFavorite(selectedRecipe.id)}><Icon name="bookmark" /> {favorites.includes(selectedRecipe.id) ? "Saved to favorites" : "Save recipe"}</button><button className="secondary-button" onClick={() => void shareRecipe(selectedRecipe)}><Icon name="share" /> Share</button><button className="secondary-button delete-button" onClick={() => void deleteRecipe(selectedRecipe.id)}><Icon name="close" /> Delete</button></div>
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
                    const baseAmount = ingredient.amount !== null ? ingredient.amount * scale : null;
                    const currentUnit = ingredientUnits[index] ?? ingredient.unit;
                    const displayAmount = baseAmount !== null && currentUnit !== ingredient.unit
                      ? convertAmount(baseAmount, ingredient.unit, currentUnit)
                      : baseAmount;
                    const nutrition = ingredient.nutrition;
                    const macros = nutrition && nutrition.protein !== null && nutrition.carbs !== null && nutrition.fat !== null
                      ? { protein: nutrition.protein, carbs: nutrition.carbs, fat: nutrition.fat }
                      : null;
                    const macroTotal = macros ? macros.protein + macros.carbs + macros.fat : 0;
                    const macroPercents = macros && macroTotal > 0 ? {
                      protein: Math.round((macros.protein / macroTotal) * 100),
                      carbs: Math.round((macros.carbs / macroTotal) * 100),
                      fat: Math.round((macros.fat / macroTotal) * 100),
                    } : null;
                    return (
                      <li key={index} className="ingredient-line">
                        <span className="ingredient-amount">{displayAmount !== null ? displayAmount.toString().replace(/\.0$/, "") : ""}</span>
                        <select className="ingredient-unit" value={currentUnit} onChange={(event) => setIngredientUnits((prev) => ({ ...prev, [index]: event.target.value }))}>
                          <option value="">—</option>
                          {COMMON_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                        </select>
                        <span className="ingredient-name">{ingredient.name}</span>
                        {nutrition && nutrition.calories !== null && (
                          <span className="ingredient-nutrition">
                            {nutrition.calories} kcal
                            {macroPercents && (
                              <span className="ingredient-macros">
                                P: {macroPercents.protein}% C: {macroPercents.carbs}% F: {macroPercents.fat}%
                              </span>
                            )}
                          </span>
                        )}
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
