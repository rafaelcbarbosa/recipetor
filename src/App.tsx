import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import "./App.css";
import { compatibleUnits, isConvertibleUnit, isKnownUnit, normalizeUnit, UNIT_GROUPS } from "./units";

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
  nutrition?: Nutrition | null;
};

type Recipe = {
  id: string;
  title: string;
  description?: string;
  category: string;
  cuisine?: string;
  mealTypes?: string[];
  dietTags?: string[];
  customTags?: string[];
  prepTimeMinutes?: number | null;
  basePortions?: number | null;
  baseServings?: number | null;
  time?: string;
  emoji?: string;
  color?: string;
  imageUrl?: string | null;
  ingredients?: IngredientLine[];
  steps?: string[];
  totals?: Nutrition | null;
  nutritionPerPortion?: Nutrition | null;
  source?: string;
  sourceUrls?: string[];
  sourcePosts?: string[];
  sourceCount?: number;
  ratingAvg?: number;
  ratingCount?: number;
  isFavorite?: boolean;
  myRating?: number | null;
  canDelete?: boolean;
  isExample?: boolean;
};

type HistoryEntry = Recipe & { action: string; createdAt: string };

type QueueJob = {
  id: string;
  shortUrl: string;
  status: string;
  stage: string | null;
  stageLabel?: string | null;
  progress: number;
  position: number | null;
  isMine: boolean;
  canRetry?: boolean;
  recipeId: string | null;
  error?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ImportJob = {
  id: string;
  status: string;
  stage: string;
  stageLabel?: string | null;
  progress: number;
  error?: string | null;
  errorMessage?: string | null;
  recipeId?: string | null;
};

type User = { id: string; email: string };
type AuthMode = "login" | "register" | "verify" | "forgot-password" | "reset-password" | null;
type Tab = "recipes" | "add" | "favorites";
type DetailOrigin = "library" | "favorites" | "queue" | "history";
type IngredientSheetMode = "unit" | "quantity";
type IngredientSheetState = { index: number; mode: IngredientSheetMode };
type FailureDialogState = { jobId: string; message: string; url: string };
type ManualIngredient = { amount: string; unit: string; name: string; kcal: string };
type ServerState = "checking" | "ready" | "extractor-missing" | "offline";

const MEAL_OPTIONS = ["Breakfast", "Lunch", "Dinner", "Dessert", "Snack"];
const MANUAL_CATEGORIES = ["Breakfast", "Lunch", "Dinner", "Dessert", "Snack", "Other"];
const DIET_OPTIONS = ["Vegan", "Vegetarian", "Gluten-free", "Low-carb", "Dairy-free", "Pescatarian", "High-protein"];
const STAGE_LABELS = ["Queued", "Fetching", "Extracting", "Saving"];
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const kcalFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function formatQuantity(value: number) {
  return numberFormatter.format(Math.round(value * 100) / 100);
}

function formatKcal(value: number) {
  return kcalFormatter.format(value);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function shortenUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    return `${host}${path}`;
  } catch {
    return url;
  }
}

function recipeSubtitle(recipe: Recipe) {
  const meal = recipe.mealTypes?.[0] ?? (recipe.category && recipe.category !== "Other" ? recipe.category : null);
  const parts = [recipe.cuisine, meal, recipe.prepTimeMinutes ? `${recipe.prepTimeMinutes} min` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Recipe";
}

function recipeBaseServings(recipe: Recipe) {
  return recipe.baseServings ?? recipe.basePortions ?? 1;
}

function jobStageIndex(job: Pick<QueueJob, "status" | "stage">) {
  if (job.status === "completed") return STAGE_LABELS.length;
  switch (job.stage) {
    case "queued":
      return 0;
    case "fetching":
      return 1;
    case "extracting":
      return 2;
    case "saving":
      return 3;
    default:
      return 0;
  }
}

function jobStatusLine(job: QueueJob) {
  if (job.stageLabel) return job.stageLabel;
  if (job.status === "pending") return "Waiting for your turn";
  if (job.stage === "fetching") return "Fetching from Instagram";
  if (job.stage === "saving") return "Saving recipe";
  return "Extracting recipe";
}

function jobRowSubtitle(job: QueueJob) {
  const position = job.position ? ` · position ${job.position}` : "";
  if (job.stageLabel) return `${job.stageLabel}${position}`;
  if (job.status === "pending") return `Waiting${position}`;
  if (job.stage === "fetching") return `Fetching recipe${position}`;
  if (job.stage === "saving") return `Saving recipe${position}`;
  return `Extracting recipe${position}`;
}

function importStageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: "Waiting in queue",
    fetching: "Fetching recipe",
    extracting: "Extracting recipe",
    saving: "Saving recipe",
    completed: "Recipe ready",
    failed: "Extraction failed",
  };
  return labels[stage] ?? "Working";
}

function Icon({
  name,
  size = 24,
  filled = false,
  className,
}: {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}) {
  const paths: Record<string, ReactNode> = {
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    "chevron-right": <path d="M9 5l7 7-7 7" />,
    "chevron-left": <path d="M15 5l-7 7 7 7" />,
    "chevrons-up-down": <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />,
    check: <path d="M5 12.5l4.5 4.5L20 6.5" />,
    heart: (
      <path
        fill={filled ? "currentColor" : "none"}
        d="M12 21s-8-5-8-11a4.5 4.5 0 0 1 8-2.7A4.5 4.5 0 0 1 20 10c0 6-8 11-8 11z"
      />
    ),
    star: (
      <path
        fill={filled ? "currentColor" : "none"}
        d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"
      />
    ),
    share: <path d="M12 15V4M8 8l4-4 4 4M5 13v6h14v-6" />,
    list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
    "check-circle": (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5l3 3 5-6" />
      </>
    ),
    "alert-circle": (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5M12 16h.01" />
      </>
    ),
    loader: <path d="M12 3a9 9 0 1 0 9 9" />,
    "plus-circle": (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </>
    ),
    "book-open": (
      <>
        <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
        <path d="M5 17a3 3 0 0 1 3-3h11" />
      </>
    ),
    soup: (
      <>
        <path d="M4 11h16a8 8 0 0 1-16 0z" />
        <path d="M9 7c0-1.5 1.5-1.5 1.5-3M14 7c0-1.5 1.5-1.5 1.5-3" />
      </>
    ),
    x: <path d="M18 6 6 18M6 6l12 12" />,
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.71-1.71" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {paths[name]}
    </svg>
  );
}

function TopBar({
  onAccount,
  onBacklog,
  backlogCount,
}: {
  onAccount: () => void;
  onBacklog: () => void;
  backlogCount: number;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-icon">
          <Icon name="soup" size={20} />
        </span>
        <h1>Recipetor</h1>
      </div>
      <div className="topbar-actions">
        <button
          type="button"
          className="round-btn glass backlog-btn"
          aria-label={backlogCount > 0 ? `Backlog, ${backlogCount} active` : "Backlog"}
          onClick={onBacklog}
        >
          <Icon name="list" />
          {backlogCount > 0 && <span className="backlog-badge">{backlogCount > 9 ? "9+" : backlogCount}</span>}
        </button>
        <button type="button" className="round-btn glass" aria-label="Account" onClick={onAccount}>
          <Icon name="user" />
        </button>
      </div>
    </header>
  );
}

function RecipeRow({
  recipe,
  favorite,
  subtitle,
  onOpen,
  onToggleFavorite,
}: {
  recipe: Recipe;
  favorite: boolean;
  subtitle?: string;
  onOpen: (recipe: Recipe) => void;
  onToggleFavorite: (recipe: Recipe) => void;
}) {
  return (
    <article className="recipe-row">
      <button type="button" className="recipe-row-main" onClick={() => onOpen(recipe)}>
        <span className="thumb">
          {recipe.imageUrl ? <img src={recipe.imageUrl} alt="" loading="lazy" /> : <Icon name="soup" size={30} />}
        </span>
        <span className="recipe-row-text">
          <span className="recipe-row-title">{recipe.title}</span>
          <span className="recipe-row-sub">{subtitle ?? recipeSubtitle(recipe)}</span>
          <span className="rating-line">
            {recipe.ratingCount ? (
              <>
                <Icon name="star" size={14} filled />
                <b>{Number(recipe.ratingAvg ?? 0).toFixed(1)}</b>
                <span className="count">({recipe.ratingCount})</span>
              </>
            ) : (
              <span className="count">No ratings yet</span>
            )}
            {recipe.dietTags?.[0] && <span className="tag-chip">{recipe.dietTags[0]}</span>}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`fav-btn${favorite ? " on" : ""}`}
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={favorite}
        onClick={() => onToggleFavorite(recipe)}
      >
        <Icon name="heart" size={22} filled={favorite} />
      </button>
    </article>
  );
}

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const tabs: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "recipes", label: "Recipes", icon: "book-open" },
    { id: "add", label: "Add", icon: "plus-circle" },
    { id: "favorites", label: "Favorites", icon: "heart" },
  ];
  return (
    <nav className="tabbar" aria-label="Main">
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          className={tab === item.id ? "on" : ""}
          aria-current={tab === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
        >
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <Icon name="soup" size={28} />
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("recipetor_token"));
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [verifyEmail, setVerifyEmail] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [serverState, setServerState] = useState<ServerState>("checking");

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [queueJobs, setQueueJobs] = useState<QueueJob[]>([]);

  const [query, setQuery] = useState("");
  const [mealFilter, setMealFilter] = useState("");
  const [cuisineFilter, setCuisineFilter] = useState("");
  const [dietFilter, setDietFilter] = useState("");

  const [tab, setTab] = useState<Tab>("recipes");
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [detailOrigin, setDetailOrigin] = useState<DetailOrigin>("library");
  const [servings, setServings] = useState<number | null>(null);
  const [localTags, setLocalTags] = useState<Record<string, string[]>>({});

  const [showQueue, setShowQueue] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showTagSheet, setShowTagSheet] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [ingredientSheet, setIngredientSheet] = useState<IngredientSheetState | null>(null);
  const [ingredientAmountDraft, setIngredientAmountDraft] = useState("");
  const [ingredientUnitDraft, setIngredientUnitDraft] = useState("");
  const [isSavingIngredient, setIsSavingIngredient] = useState(false);

  const [failureDialog, setFailureDialog] = useState<FailureDialogState | null>(null);
  const [manualSheet, setManualSheet] = useState<{ jobId: string } | null>(null);
  const [manualTitle, setManualTitle] = useState("");
  const [manualCategory, setManualCategory] = useState("Dinner");
  const [manualCuisine, setManualCuisine] = useState("");
  const [manualServings, setManualServings] = useState("");
  const [manualPrep, setManualPrep] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [manualSteps, setManualSteps] = useState("");
  const [manualIngredients, setManualIngredients] = useState<ManualIngredient[]>([
    { amount: "", unit: "g", name: "", kcal: "" },
  ]);
  const [isSavingManual, setIsSavingManual] = useState(false);

  const [instagramLink, setInstagramLink] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);

  const handledCompletions = useRef<Set<string>>(new Set());
  const knownRecipes = useRef<Map<string, Recipe>>(new Map());
  const queueLoadedAt = useRef<number | null>(null);

  const apiFetch = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...((options.headers as Record<string, string> | undefined) ?? {}),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      return fetch(path, { ...options, headers });
    },
    [token],
  );

  const refreshQueue = useCallback(async () => {
    if (queueLoadedAt.current == null) queueLoadedAt.current = Date.now();
    try {
      const response = await apiFetch("/api/recipes/import/queue");
      if (!response.ok) return;
      const data = (await response.json()) as { jobs?: QueueJob[] };
      setQueueJobs(data.jobs ?? []);
    } catch {
      // Queue refresh is best effort.
    }
  }, [apiFetch]);

  useEffect(() => {
    if (token) localStorage.setItem("recipetor_token", token);
    else localStorage.removeItem("recipetor_token");
  }, [token]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let active = true;
    void fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error("Health check failed.");
        return (await response.json()) as { ok: boolean; extractorAvailable: boolean };
      })
      .then((health) => {
        if (active) setServerState(health.ok ? (health.extractorAvailable ? "ready" : "extractor-missing") : "offline");
      })
      .catch(() => {
        if (active) setServerState("offline");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      if (token) {
        try {
          const response = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
          if (!response.ok) throw new Error("Session expired.");
          const data = (await response.json()) as { user: User };
          if (active) setUser(data.user);
        } catch {
          if (active) {
            setToken(null);
            setUser(null);
            setRecipes((current) =>
              current.map((recipe) => ({ ...recipe, isFavorite: false, myRating: null, canDelete: false })),
            );
          }
          return;
        }
      } else if (active) {
        setUser(null);
      }

      try {
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const response = await fetch("/api/recipes", { headers });
        if (!response.ok) throw new Error("Recipes unavailable.");
        const data = (await response.json()) as { recipes: Recipe[] };
        if (active) setRecipes(data.recipes ?? []);
      } catch {
        if (active) setNotice("Saved recipes couldn't be loaded. Check the recipe server and refresh.");
      }

      if (!token) {
        if (active) {
          setFavorites([]);
          setHistory([]);
        }
        return;
      }

      try {
        const [favoritesResponse, historyResponse] = await Promise.all([
          fetch("/api/favorites", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/history", { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        if (active && favoritesResponse.ok) {
          const data = (await favoritesResponse.json()) as { favorites?: string[] };
          setFavorites(data.favorites ?? []);
        }
        if (active && historyResponse.ok) {
          const data = (await historyResponse.json()) as { history?: HistoryEntry[] };
          setHistory(data.history ?? []);
        }
      } catch {
        // Favorites and history are optional for the library view.
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function tick() {
      await refreshQueue();
      if (active) timer = window.setTimeout(tick, 2000);
    }
    void tick();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshQueue]);

  useEffect(() => {
    knownRecipes.current = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  }, [recipes]);

  // Add recipes that finish in the background, even when the user is on
  // another screen. This keeps the list and favorites current without a reload.
  useEffect(() => {
    const completed = queueJobs.filter(
      (job): job is QueueJob & { recipeId: string } =>
        job.status === "completed" &&
        Boolean(job.recipeId) &&
        !handledCompletions.current.has(job.id),
    );
    if (completed.length === 0) return;

    for (const job of completed) {
      handledCompletions.current.add(job.id);
      const isNewCompletion =
        queueLoadedAt.current == null || new Date(job.updatedAt).getTime() >= queueLoadedAt.current;

      const known = knownRecipes.current.get(job.recipeId);
      if (known) {
        if (job.isMine || known.isFavorite) {
          setFavorites((current) => (current.includes(known.id) ? current : [...current, known.id]));
        }
        if (job.isMine) {
          setHistory((current) =>
            current.some((entry) => entry.id === known.id)
              ? current
              : [{ ...known, action: "added", createdAt: job.updatedAt }, ...current],
          );
        }
        if (isNewCompletion && job.isMine) setNotice(`Recipe ready: ${known.title}`);
        continue;
      }

      void (async () => {
        try {
          const response = await apiFetch(`/api/recipes/${job.recipeId}`);
          if (!response.ok) {
            handledCompletions.current.delete(job.id);
            return;
          }
          const data = (await response.json()) as { recipe: Recipe };
          const recipe = data.recipe;
          knownRecipes.current.set(recipe.id, recipe);
          setRecipes((current) =>
            current.some((item) => item.id === recipe.id) ? current : [recipe, ...current],
          );
          if (job.isMine || recipe.isFavorite) {
            setFavorites((current) => (current.includes(recipe.id) ? current : [...current, recipe.id]));
          }
          if (job.isMine) {
            setHistory((current) =>
              current.some((entry) => entry.id === recipe.id)
                ? current
                : [{ ...recipe, action: "added", createdAt: job.updatedAt }, ...current],
            );
          }
          if (isNewCompletion && job.isMine) setNotice(`Recipe ready: ${recipe.title}`);
        } catch {
          handledCompletions.current.delete(job.id);
        }
      })();
    }
  }, [queueJobs, apiFetch]);

  const overlayOpen = Boolean(
    showAccount ||
      authMode ||
      showDeleteConfirm ||
      showSources ||
      showTagSheet ||
      ingredientSheet ||
      failureDialog ||
      manualSheet,
  );
  useEffect(() => {
    if (!overlayOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [overlayOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (manualSheet) setManualSheet(null);
      else if (failureDialog) setFailureDialog(null);
      else if (ingredientSheet) setIngredientSheet(null);
      else if (showTagSheet) setShowTagSheet(false);
      else if (showSources) setShowSources(false);
      else if (showDeleteConfirm) setShowDeleteConfirm(false);
      else if (authMode) setAuthMode(null);
      else if (showAccount) setShowAccount(false);
      else if (detail) closeDetail();
      else if (showQueue) setShowQueue(false);
      else if (showHistory) setShowHistory(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const activeJobs = useMemo(
    () => queueJobs.filter((job) => job.status === "pending" || job.status === "processing"),
    [queueJobs],
  );
  const ownJob = activeJobs.find((job) => job.isMine) ?? null;
  const failedJobs = useMemo(
    () => queueJobs.filter((job) => job.status === "failed" && !job.recipeId),
    [queueJobs],
  );
  const cuisineOptions = useMemo(
    () => Array.from(new Set(recipes.map((recipe) => recipe.cuisine).filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b)),
    [recipes],
  );

  const visibleRecipes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recipes.filter((recipe) => {
      const haystack = [
        recipe.title,
        recipe.description,
        recipe.category,
        recipe.cuisine,
        ...(recipe.mealTypes ?? []),
        ...(recipe.dietTags ?? []),
        ...(recipe.customTags ?? []),
        ...(recipe.ingredients ?? []).map((ingredient) => ingredient.name),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matchesQuery = !needle || haystack.includes(needle);
      const matchesMeal =
        !mealFilter ||
        recipe.mealTypes?.includes(mealFilter) ||
        recipe.category === mealFilter ||
        (mealFilter === "Snack" && recipe.category === "Snacks");
      const matchesCuisine = !cuisineFilter || recipe.cuisine === cuisineFilter;
      const matchesDiet = !dietFilter || recipe.dietTags?.includes(dietFilter);
      const matchesTab = tab !== "favorites" || favoriteSet.has(recipe.id) || Boolean(recipe.isFavorite);
      return matchesQuery && matchesMeal && matchesCuisine && matchesDiet && matchesTab;
    });
  }, [recipes, query, mealFilter, cuisineFilter, dietFilter, tab, favoriteSet]);

  function recipeIsFavorite(recipe: Recipe) {
    return favoriteSet.has(recipe.id) || Boolean(recipe.isFavorite);
  }

  function patchRecipe(id: string, patch: Partial<Recipe>) {
    setRecipes((current) => current.map((recipe) => (recipe.id === id ? { ...recipe, ...patch } : recipe)));
    setDetail((current) => (current && current.id === id ? { ...current, ...patch } : current));
  }

  function openBacklog() {
    setShowQueue(true);
    void refreshQueue();
  }

  function openRecipe(recipe: Recipe, origin: DetailOrigin) {
    setDetail(recipe);
    setDetailOrigin(origin);
    setServings(recipeBaseServings(recipe));
    setShowSources(false);
    setShowTagSheet(false);
    setIngredientSheet(null);
    if (origin === "queue") setShowQueue(false);
    if (origin === "history") setShowHistory(false);
  }

  function closeDetail() {
    const origin = detailOrigin;
    setDetail(null);
    setShowSources(false);
    setShowTagSheet(false);
    setIngredientSheet(null);
    if (origin === "queue") setShowQueue(true);
    if (origin === "history") setShowHistory(true);
  }

  async function toggleFavorite(recipe: Recipe) {
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to save favorites.");
      return;
    }
    const wasFavorite = recipeIsFavorite(recipe);
    const next = !wasFavorite;
    patchRecipe(recipe.id, { isFavorite: next });
    setFavorites((current) =>
      next ? (current.includes(recipe.id) ? current : [...current, recipe.id]) : current.filter((id) => id !== recipe.id),
    );
    try {
      const response = next
        ? await apiFetch("/api/favorites", { method: "POST", body: JSON.stringify({ recipeId: recipe.id }) })
        : await apiFetch(`/api/favorites/${recipe.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Couldn't update favorite.");
    } catch (error) {
      patchRecipe(recipe.id, { isFavorite: wasFavorite });
      setFavorites((current) =>
        wasFavorite
          ? current.includes(recipe.id)
            ? current
            : [...current, recipe.id]
          : current.filter((id) => id !== recipe.id),
      );
      setNotice(error instanceof Error ? error.message : "Couldn't update favorite.");
    }
  }

  async function rateRecipe(recipe: Recipe, rating: number) {
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to rate recipes.");
      return;
    }
    try {
      const response = await apiFetch(`/api/recipes/${recipe.id}/rating`, {
        method: "PUT",
        body: JSON.stringify({ rating }),
      });
      if (!response.ok) throw new Error("Couldn't save your rating.");
      const data = (await response.json()) as { ratingAvg: number; ratingCount: number; myRating: number };
      patchRecipe(recipe.id, { ratingAvg: data.ratingAvg, ratingCount: data.ratingCount, myRating: data.myRating });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't save your rating.");
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

  async function deleteRecipe(id: string) {
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to delete recipes.");
      return;
    }
    if (!window.confirm("Delete this recipe?")) return;
    try {
      const response = await apiFetch(`/api/recipes/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Couldn't delete the recipe. Try again.");
      }
      setRecipes((current) => current.filter((recipe) => recipe.id !== id));
      setFavorites((current) => current.filter((favoriteId) => favoriteId !== id));
      setHistory((current) => current.filter((entry) => entry.id !== id));
      setDetail(null);
      setNotice("Recipe deleted.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't delete the recipe.");
    }
  }

  function addTag() {
    if (!detail) return;
    const clean = tagDraft.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!clean) return;
    setLocalTags((current) => {
      const existing = current[detail.id] ?? [];
      if ([...(detail.customTags ?? []), ...existing].some((tag) => tag.toLowerCase() === clean.toLowerCase())) {
        return current;
      }
      return { ...current, [detail.id]: [...existing, clean] };
    });
    setTagDraft("");
    setShowTagSheet(false);
  }

  function replaceRecipe(updated: Recipe) {
    setRecipes((current) => current.map((recipe) => (recipe.id === updated.id ? updated : recipe)));
    setDetail((current) => (current && current.id === updated.id ? updated : current));
  }

  function openIngredientSheet(index: number, mode: IngredientSheetMode) {
    if (!detail) return;
    const ingredient = detail.ingredients?.[index];
    if (!ingredient) return;
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to edit ingredients.");
      return;
    }
    setNotice("");
    if (mode === "quantity") {
      setIngredientAmountDraft(ingredient.amount != null ? String(ingredient.amount) : "");
      setIngredientUnitDraft(normalizeUnit(ingredient.unit || ""));
    }
    setIngredientSheet({ index, mode });
  }

  async function saveIngredient(index: number, changes: { amount?: number | null; unit?: string }) {
    if (!detail) return;
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to edit ingredients.");
      return;
    }
    setIsSavingIngredient(true);
    try {
      const response = await apiFetch(`/api/recipes/${detail.id}/ingredients/${index}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      const data = (await response.json().catch(() => ({}))) as { recipe?: Recipe; error?: string };
      if (!response.ok || !data.recipe) throw new Error(data.error ?? "Couldn't update the ingredient.");
      replaceRecipe(data.recipe);
      setIngredientSheet(null);
      setNotice("Ingredient updated.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't update the ingredient.");
    } finally {
      setIsSavingIngredient(false);
    }
  }

  function saveIngredientQuantity() {
    if (!ingredientSheet) return;
    const raw = ingredientAmountDraft.trim();
    const amount = raw === "" ? null : Number(raw);
    if (amount != null && (!Number.isFinite(amount) || amount < 0)) {
      setNotice("Enter a valid amount.");
      return;
    }
    if (amount == null && !ingredientUnitDraft) {
      setNotice("Add an amount or a unit.");
      return;
    }
    void saveIngredient(ingredientSheet.index, { amount, unit: ingredientUnitDraft });
  }

  async function retryFailedJob(jobId: string, url?: string) {
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to try again.");
      return;
    }
    try {
      if (url) {
        // Re-submitting registers the signed-in user as a watcher first.
        const check = await apiFetch("/api/recipes/import", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        const checkData = (await check.json().catch(() => ({}))) as { recipe?: Recipe };
        if (check.ok && checkData.recipe) {
          setFailureDialog(null);
          registerImportedRecipe(checkData.recipe, "This link was already saved. Opened it and added it to your favorites.", {
            openDetail: true,
            switchTab: true,
          });
          return;
        }
      }
      const response = await apiFetch(`/api/recipes/import/retry/${jobId}`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { job?: ImportJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error ?? "Couldn't retry this import.");
      setFailureDialog(null);
      setImportJob(data.job);
      setInstagramLink("");
      setNotice("Retry queued.");
      void refreshQueue();
      void pollJobStatus(data.job.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't retry this import.");
    }
  }

  function openManualSheet(job: QueueJob) {
    if (!user) {
      setAuthMode("login");
      setNotice("Sign in to add a recipe manually.");
      return;
    }
    setNotice("");
    setManualSheet({ jobId: job.id });
    setManualTitle("");
    setManualCategory("Dinner");
    setManualCuisine("");
    setManualServings("");
    setManualPrep("");
    setManualDescription("");
    setManualSteps("");
    setManualIngredients([{ amount: "", unit: "g", name: "", kcal: "" }]);
  }

  function updateManualIngredient(index: number, patch: Partial<ManualIngredient>) {
    setManualIngredients((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  }

  function addManualIngredient() {
    setManualIngredients((current) => [...current, { amount: "", unit: "g", name: "", kcal: "" }]);
  }

  function removeManualIngredient(index: number) {
    setManualIngredients((current) =>
      current.length <= 1 ? current : current.filter((_, itemIndex) => itemIndex !== index),
    );
  }

  async function saveManualRecipe() {
    if (!manualSheet) return;
    if (!user) {
      setAuthMode("login");
      return;
    }
    const title = manualTitle.trim();
    const ingredients = manualIngredients
      .filter((item) => item.name.trim())
      .map((item) => {
        const amount = item.amount.trim() === "" ? null : Number(item.amount);
        const calories = item.kcal.trim() === "" ? null : Number(item.kcal);
        return {
          amount,
          unit: item.unit.trim(),
          name: item.name.trim(),
          nutrition: { calories, protein: null, carbs: null, fat: null },
        };
      });
    const steps = manualSteps
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!title) {
      setNotice("Add a recipe title.");
      return;
    }
    if (ingredients.length === 0) {
      setNotice("Add at least one ingredient.");
      return;
    }
    if (steps.length === 0) {
      setNotice("Add at least one step.");
      return;
    }
    if (
      ingredients.some(
        (item) => item.amount != null && (!Number.isFinite(item.amount) || item.amount < 0),
      )
    ) {
      setNotice("Enter valid ingredient amounts.");
      return;
    }
    if (
      ingredients.some(
        (item) =>
          item.nutrition.calories != null &&
          (!Number.isFinite(item.nutrition.calories) || item.nutrition.calories < 0),
      )
    ) {
      setNotice("Enter valid ingredient calories.");
      return;
    }
    const prep = manualPrep.trim() === "" ? null : Number(manualPrep);
    if (prep != null && (!Number.isInteger(prep) || prep < 1 || prep > 1440)) {
      setNotice("Prep time must be 1-1440 minutes.");
      return;
    }
    const servings = manualServings.trim() === "" ? null : Number(manualServings);
    if (servings != null && (!Number.isFinite(servings) || servings < 1 || servings > 1000)) {
      setNotice("Servings must be between 1 and 1000.");
      return;
    }

    setIsSavingManual(true);
    try {
      const response = await apiFetch("/api/recipes/manual", {
        method: "POST",
        body: JSON.stringify({
          jobId: manualSheet.jobId,
          recipe: {
            title,
            description: manualDescription.trim().slice(0, 500),
            category: manualCategory,
            cuisine: manualCuisine.trim().slice(0, 50),
            mealTypes: [],
            dietTags: [],
            customTags: [],
            prepTimeMinutes: prep,
            basePortions: servings,
            ingredients,
            instructions: steps,
            totals: null,
          },
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { recipe?: Recipe; error?: string };
      if (!response.ok || !data.recipe) throw new Error(data.error ?? "Couldn't save the recipe.");
      const recipe = data.recipe;
      setManualSheet(null);
      knownRecipes.current.set(recipe.id, recipe);
      setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
      setFavorites((current) => (current.includes(recipe.id) ? current : [...current, recipe.id]));
      setHistory((current) =>
        current.some((entry) => entry.id === recipe.id)
          ? current
          : [{ ...recipe, action: "added", createdAt: new Date().toISOString() }, ...current],
      );
      setShowQueue(false);
      setTab("recipes");
      openRecipe(recipe, "library");
      setNotice("Recipe added.");
      void refreshQueue();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Couldn't save the recipe.");
    } finally {
      setIsSavingManual(false);
    }
  }

  function registerImportedRecipe(
    recipe: Recipe,
    message: string,
    { openDetail = false, switchTab = false }: { openDetail?: boolean; switchTab?: boolean } = {},
  ) {
    knownRecipes.current.set(recipe.id, recipe);
    setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)]);
    if (user || recipe.isFavorite) {
      setFavorites((current) => (current.includes(recipe.id) ? current : [...current, recipe.id]));
    }
    if (user) {
      setHistory((current) =>
        current.some((entry) => entry.id === recipe.id)
          ? current
          : [{ ...recipe, action: "added", createdAt: new Date().toISOString() }, ...current],
      );
    }
    if (switchTab) setTab("recipes");
    if (openDetail) openRecipe(recipe, "library");
    setInstagramLink("");
    setNotice(message);
    void refreshQueue();
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

    setIsSubmitting(true);
    setNotice("Adding to the backlog…");
    try {
      const response = await apiFetch("/api/recipes/import", {
        method: "POST",
        body: JSON.stringify({ url: url.href }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Recipe import failed. Try again.");
      }
      const result = (await response.json()) as {
        alreadyFailed?: boolean;
        job?: ImportJob;
        recipe?: Recipe;
        duplicate?: boolean;
        reason?: string;
        message?: string;
      };
      if (result.alreadyFailed && result.job) {
        setNotice("");
        setFailureDialog({
          jobId: result.job.id,
          url: url.href,
          message:
            result.message ??
            "This link was tried before but it was not possible to extract the recipe.",
        });
        return;
      }
      if (result.recipe) {
        registerImportedRecipe(
          result.recipe,
          result.reason === "source"
            ? user
              ? "This link was already saved. Opened it and added it to your favorites."
              : "This link was already saved. Here's the recipe."
            : result.duplicate
              ? "Same recipe found. The new Instagram link was added to it."
              : "Recipe extracted and saved to your recipe box.",
          { openDetail: true, switchTab: true },
        );
        return;
      }
      if (result.job) {
        setImportJob(result.job);
        setInstagramLink("");
        setNotice("Added to the backlog. You can add another link while it processes.");
        openBacklog();
        void pollJobStatus(result.job.id);
        return;
      }
      throw new Error("Unexpected server response.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recipe import failed. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function pollJobStatus(jobId: string) {
    try {
      const response = await apiFetch(`/api/recipes/import/status/${jobId}`);
      if (!response.ok) throw new Error("Failed to check job status.");
      const result = (await response.json()) as { job: ImportJob };
      const job = result.job;
      setImportJob((current) => (current == null || current.id === job.id ? job : current));

      if (job.status === "completed") {
        if (!job.recipeId) setNotice("The recipe finished, but it couldn't be loaded.");
        setImportJob((current) => (current?.id === job.id ? null : current));
        void refreshQueue();
        return;
      }
      if (job.status === "failed") {
        setNotice(`Failed to extract recipe: ${job.errorMessage ?? job.error ?? "Unknown error during extraction."}`);
        setImportJob((current) => (current?.id === job.id ? null : current));
        return;
      }
      setNotice(importStageLabel(job.stage));
      window.setTimeout(() => void pollJobStatus(jobId), 2000);
    } catch {
      setNotice("Lost connection to the import job. Please try again.");
      setImportJob((current) => (current?.id === jobId ? null : current));
    }
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = formData.get("email")?.toString().trim().toLowerCase();
    const password = formData.get("password")?.toString();
    const code = formData.get("code")?.toString().trim();
    const newPassword = formData.get("newPassword")?.toString();

    if (authMode === "verify") {
      if (!verifyEmail || !code) {
        setNotice("Email and verification code are required.");
        return;
      }
      setNotice("Verifying email…");
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: verifyEmail, code }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Verification failed.");
        setNotice("Email verified! You can now sign in.");
        setAuthMode("login");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Verification failed. Try again.");
      }
      return;
    }

    if (authMode === "reset-password") {
      if (!resetEmail || !code || !newPassword) {
        setNotice("Email, code, and new password are required.");
        return;
      }
      if (newPassword.length < 6) {
        setNotice("Password must be at least 6 characters.");
        return;
      }
      setNotice("Resetting password…");
      try {
        const response = await fetch("/api/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: resetEmail, code, newPassword }),
        });
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Password reset failed.");
        setNotice("Password reset successfully! You can now sign in.");
        setAuthMode("login");
        setResetEmail("");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Password reset failed. Try again.");
      }
      return;
    }

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
      const data = (await response.json()) as {
        error?: string;
        token?: string;
        user?: User;
        requiresVerification?: boolean;
        email?: string;
        message?: string;
      };
      if (!response.ok) {
        if (data.requiresVerification && data.email) {
          setVerifyEmail(data.email);
          setAuthMode("verify");
          setNotice(data.message ?? "Please check your email for a verification code.");
          return;
        }
        throw new Error(data.error ?? "Authentication failed.");
      }
      if (!data.token || !data.user) throw new Error("Authentication failed.");
      setToken(data.token);
      setUser(data.user);
      setAuthMode(null);
      setNotice(authMode === "register" ? "Account created! Welcome to Recipetor." : "Welcome back!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Authentication failed. Try again.");
    }
  }

  async function handleResendVerification() {
    if (!verifyEmail) return;
    setNotice("Sending new code…");
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Failed to resend code.");
      setNotice("New verification code sent!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to resend code. Try again.");
    }
  }

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetEmail) return;
    setNotice("Sending reset code…");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetEmail }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Failed to send reset code.");
      setAuthMode("reset-password");
      setNotice("Reset code sent! Check your email.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to send reset code. Try again.");
    }
  }

  async function handleResendResetCode() {
    if (!resetEmail) return;
    setNotice("Sending new reset code…");
    try {
      const response = await fetch("/api/auth/resend-password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetEmail }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Failed to resend code.");
      setNotice("New reset code sent!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to resend code. Try again.");
    }
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setRecipes((current) => current.map((recipe) => ({ ...recipe, isFavorite: false, myRating: null, canDelete: false })));
    setFavorites([]);
    setHistory([]);
    setNotice("Signed out.");
  }

  async function handleDeleteAccount() {
    if (!token) return;
    try {
      const response = await fetch("/api/auth/delete-account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to delete account.");
      }
      setToken(null);
      setUser(null);
      setRecipes([]);
      setFavorites([]);
      setHistory([]);
      setShowDeleteConfirm(false);
      setNotice("Account deleted successfully.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to delete account.");
    }
  }

  const detailTotals = detail ? (detail.nutritionPerPortion ?? detail.totals ?? null) : null;
  const detailSourceUrls = detail
    ? detail.sourceUrls?.length
      ? detail.sourceUrls
      : detail.sourcePosts ?? []
    : [];
  const detailBase = detail ? recipeBaseServings(detail) : 1;
  const detailServings = servings ?? detailBase;
  const detailScale = detailBase > 0 ? detailServings / detailBase : 1;
  const detailFavorite = detail ? recipeIsFavorite(detail) : false;
  const detailMeal = detail
    ? detail.mealTypes?.[0] ?? (detail.category && detail.category !== "Other" ? detail.category : "")
    : "";
  const detailCustomTags = detail ? localTags[detail.id] ?? [] : [];
  const detailTags = detail
    ? Array.from(
        new Map(
          [...(detail.dietTags ?? []), ...(detail.customTags ?? []), ...detailCustomTags].map((tag) => [
            tag.toLowerCase(),
            tag,
          ]),
        ).values(),
      )
    : [];
  const detailMacros: Array<{ label: string; grams: number | null; kcalPerGram: number; color: string }> = detailTotals
    ? [
        { label: "Protein", grams: detailTotals.protein, kcalPerGram: 4, color: "protein" },
        { label: "Carbs", grams: detailTotals.carbs, kcalPerGram: 4, color: "carbs" },
        { label: "Fat", grams: detailTotals.fat, kcalPerGram: 9, color: "fat" },
      ]
    : [];
  const detailKnownMacroKcal = detailMacros.reduce(
    (total, macro) => total + (macro.grams != null ? macro.grams * macro.kcalPerGram : 0),
    0,
  );
  const detailPercentBase =
    detailTotals?.calories && detailTotals.calories > 0 ? detailTotals.calories : detailKnownMacroKcal;
  const detailHasNutrition =
    Boolean(detailTotals) &&
    ((detailTotals?.calories ?? 0) > 0 || detailMacros.some((macro) => (macro.grams ?? 0) > 0));
  const detailRating = detail?.myRating ?? 0;
  const ingredientSheetIngredient =
    detail && ingredientSheet ? detail.ingredients?.[ingredientSheet.index] ?? null : null;
  const filterActive = Boolean(query.trim() || mealFilter || cuisineFilter || dietFilter);
  const emptyTitle =
    tab === "favorites" ? "No favorites yet" : filterActive ? "No recipes found" : "No recipes yet";
  const emptyBody =
    tab === "favorites"
      ? "Tap the heart on a recipe to keep it here."
      : filterActive
        ? "Try another search or filter."
        : "Add a recipe from Instagram to get started.";

  const content = detail ? (
    <div className="screen detail">
      <header className="detail-topbar">
        <button type="button" className="round-btn glass" aria-label="Back" onClick={closeDetail}>
          <Icon name="chevron-left" />
        </button>
        <div className="detail-actions">
          <button
            type="button"
            className={`round-btn glass heart-btn${detailFavorite ? " on" : ""}`}
            aria-label={detailFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={detailFavorite}
            onClick={() => void toggleFavorite(detail)}
          >
            <Icon name="heart" filled={detailFavorite} />
          </button>
          <button
            type="button"
            className="round-btn glass"
            aria-label="Share recipe"
            onClick={() => void shareRecipe(detail)}
          >
            <Icon name="share" />
          </button>
        </div>
      </header>

      <div className="hero">
        {detail.imageUrl ? <img src={detail.imageUrl} alt="" /> : <Icon name="soup" size={56} />}
      </div>

      <div>
        <h1 className="detail-title">{detail.title}</h1>
        <p className="detail-meta">
          {[
            detail.prepTimeMinutes ? `${detail.prepTimeMinutes} min` : null,
            `${detailBase} ${pluralize(detailBase, "serving")}`,
            detail.ratingCount
              ? `★ ${Number(detail.ratingAvg ?? 0).toFixed(1)} (${detail.ratingCount} ratings)`
              : "No ratings yet",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <div className="tag-row">
        {detailMeal && <span className="detail-tag meal">{detailMeal}</span>}
        {detail.cuisine && <span className="detail-tag">{detail.cuisine}</span>}
        {detailTags.map((tag) => (
          <span className="detail-tag" key={tag}>
            {tag}
          </span>
        ))}
        <button type="button" className="add-tag" onClick={() => setShowTagSheet(true)}>
          + Add tag
        </button>
      </div>

      <div className="rating-row">
        <span>Your rating</span>
        <div className="stars" role="group" aria-label="Your rating">
          {[1, 2, 3, 4, 5].map((rating) => (
            <button
              key={rating}
              type="button"
              className={`star-btn${detailRating >= rating ? " on" : ""}`}
              aria-label={`${rating} ${pluralize(rating, "star")}`}
              aria-pressed={detailRating === rating}
              onClick={() => void rateRecipe(detail, rating)}
            >
              <Icon name="star" filled={detailRating >= rating} />
            </button>
          ))}
        </div>
      </div>

      {detailSourceUrls.length > 0 && (
        <button type="button" className="source-btn" onClick={() => setShowSources(true)}>
          <span>
            Found in {detailSourceUrls.length} Instagram {pluralize(detailSourceUrls.length, "post")}
          </span>
          <Icon name="chevron-right" />
        </button>
      )}

      {detailHasNutrition && detailTotals && (
        <section className="nutrition-card">
          <div className="nutrition-head">
            <h2>Per portion</h2>
            <span className="kcal">
              {detailTotals.calories != null ? `${formatKcal(detailTotals.calories)} kcal` : "—"}
            </span>
          </div>
          {detailMacros.map((macro) => {
            const macroKcal = macro.grams != null ? macro.grams * macro.kcalPerGram : null;
            const percent =
              macroKcal != null && detailPercentBase > 0 ? Math.round((macroKcal / detailPercentBase) * 100) : 0;
            return (
              <div className="macro" key={macro.label}>
                <span>{macro.label}</span>
                <div className="track">
                  <div className={`fill ${macro.color}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                </div>
                <span>{macro.grams != null ? `${formatQuantity(macro.grams)} g · ${percent}%` : "—"}</span>
              </div>
            );
          })}
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Ingredients</h2>
          <div className="stepper">
            <button
              type="button"
              aria-label="Fewer servings"
              onClick={() => setServings(Math.max(1, detailServings - 1))}
            >
              −
            </button>
            <span>
              {detailServings} {pluralize(detailServings, "serving")}
            </span>
            <button type="button" aria-label="More servings" onClick={() => setServings(detailServings + 1)}>
              +
            </button>
          </div>
        </div>
        <p className="helper">Amounts update with the number of servings.</p>
        <div>
          {(detail.ingredients ?? []).map((ingredient, index) => {
            const amount = ingredient.amount != null ? ingredient.amount * detailScale : null;
            const kcal = ingredient.nutrition?.calories != null ? ingredient.nutrition.calories * detailScale : null;
            const amountText = [amount != null ? formatQuantity(amount) : null, ingredient.unit || null]
              .filter(Boolean)
              .join(" ");
            const needsQuantity = ingredient.amount == null || !ingredient.unit;
            const canChangeUnit = ingredient.amount != null && isConvertibleUnit(ingredient.unit);
            const canAdjust = needsQuantity || canChangeUnit;
            const missingLabels = [
              ingredient.amount == null ? "amount" : null,
              !ingredient.unit ? "unit" : null,
            ].filter(Boolean);
            const adjustLabel =
              missingLabels.length === 2
                ? `Add amount and unit for ${ingredient.name}`
                : missingLabels.length === 1
                  ? `Add ${missingLabels[0]} for ${ingredient.name}`
                  : `Change unit for ${ingredient.name}`;
            return (
              <div className="ingredient-row" key={`${ingredient.name}-${index}`}>
                {canAdjust ? (
                  <button
                    type="button"
                    className={`ingredient-amount${amountText ? "" : " missing"}`}
                    aria-label={adjustLabel}
                    onClick={() => openIngredientSheet(index, needsQuantity ? "quantity" : "unit")}
                  >
                    <span>{amountText || "Add"}</span>
                    <Icon name="chevrons-up-down" size={12} />
                  </button>
                ) : (
                  <b>{amountText || "—"}</b>
                )}
                <span className="name">{ingredient.name}</span>
                <span className={`kcal${kcal == null ? " missing" : ""}`}>
                  {kcal != null ? `${formatKcal(kcal)} kcal` : "—"}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section id="recipe-steps">
        <h2 className="section-title">Steps</h2>
        {(detail.steps ?? []).map((step, index) => (
          <div className="step" key={`${index}-${step}`}>
            <span className="step-num">{index + 1}</span>
            <span>{step}</span>
          </div>
        ))}
      </section>

      {detail.canDelete && (
        <button type="button" className="delete-recipe" onClick={() => void deleteRecipe(detail.id)}>
          Delete recipe
        </button>
      )}

      <div className="detail-primary">
        <button
          type="button"
          className="primary-btn"
          onClick={() =>
            document.getElementById("recipe-steps")?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        >
          Start cooking
        </button>
      </div>

    </div>
  ) : showQueue ? (
    <div className="screen queue">
      <header className="topbar center">
        <button type="button" className="round-btn glass" aria-label="Back" onClick={() => setShowQueue(false)}>
          <Icon name="chevron-left" />
        </button>
        <h1>Queue</h1>
        <span className="topbar-spacer" />
      </header>

      <div className="summary">
        <span className="summary-icon">
          <Icon name="list" size={28} />
        </span>
        <span>
          <span className="summary-title">
            {activeJobs.length} {pluralize(activeJobs.length, "recipe")} in the queue
          </span>
          <span className="summary-sub">Processed one at a time, in order.</span>
        </span>
      </div>

      {ownJob && (
        <section>
          <h2 className="group-head">Your recipe</h2>
          <div className="group queue-group">
            <div className="queue-card-top">
              <span className="queue-url">{ownJob.shortUrl}</span>
              {ownJob.position != null && <span className="position-badge">#{ownJob.position}</span>}
            </div>
            <span className="queue-status">
              {jobStatusLine(ownJob)}
              {ownJob.progress != null ? ` · ${ownJob.progress}%` : ""}
            </span>
            <div className="progress-bars">
              {STAGE_LABELS.map((label, index) => (
                <span key={label} className={index <= jobStageIndex(ownJob) ? "done" : ""} />
              ))}
            </div>
            <div className="progress-labels">
              {STAGE_LABELS.map((label, index) => (
                <span key={label} className={index === jobStageIndex(ownJob) ? "current" : ""}>
                  {label}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      <section>
        <h2 className="group-head">All recipes in the queue</h2>
        <div className="group">
          {activeJobs.length > 0 ? (
            activeJobs.map((job) => (
              <div className="queue-row" key={job.id}>
                {job.status === "processing" ? (
                  <Icon name="loader" className="queue-running spinner" />
                ) : (
                  <Icon name="clock" className="queue-waiting" />
                )}
                <span className="queue-row-text">
                  <span className="queue-row-title">
                    <span className="queue-url-text">{job.shortUrl}</span>
                    {job.isMine && <span className="you-chip">You</span>}
                  </span>
                  <span className="queue-row-sub">{jobRowSubtitle(job)}</span>
                </span>
              </div>
            ))
          ) : (
            <p className="empty-inline">Nothing waiting right now.</p>
          )}
        </div>
      </section>

      {failedJobs.length > 0 && (
        <section>
          <h2 className="group-head">Couldn’t be extracted</h2>
          <div className="group">
            {failedJobs.map((job) => (
              <div className="queue-row" key={job.id}>
                <Icon name="alert-circle" className="queue-failed" />
                <span className="queue-row-text">
                  <span className="queue-row-title">
                    <span className="queue-url-text">{job.shortUrl}</span>
                    {job.isMine && <span className="you-chip">You</span>}
                  </span>
                  <span className="queue-row-sub">Couldn’t read this post</span>
                </span>
                {job.canRetry && (
                  <button type="button" className="retry-btn manual-entry-btn" onClick={() => openManualSheet(job)}>
                    Enter manually
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  ) : showHistory ? (
    <div className="screen sub">
      <header className="topbar center">
        <button type="button" className="round-btn glass" aria-label="Back" onClick={() => setShowHistory(false)}>
          <Icon name="chevron-left" />
        </button>
        <h1>History</h1>
        <span className="topbar-spacer" />
      </header>
      {history.length > 0 ? (
        <div className="group">
          {history.map((entry) => {
            const recipe = recipes.find((item) => item.id === entry.id) ?? entry;
            return (
              <RecipeRow
                key={`${entry.id}-${entry.createdAt}`}
                recipe={recipe}
                favorite={recipeIsFavorite(recipe)}
                subtitle={`${entry.action === "updated" ? "Updated" : "Added"} · ${new Date(entry.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                onOpen={(selected) => openRecipe(selected, "history")}
                onToggleFavorite={(selected) => void toggleFavorite(selected)}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState title="No history yet" body="Recipes you add will appear here." />
      )}
    </div>
  ) : tab === "add" ? (
    <div className="screen">
      <TopBar
        onAccount={() => setShowAccount(true)}
        onBacklog={openBacklog}
        backlogCount={activeJobs.length}
      />
      <h2 className="page-heading">Add a recipe</h2>
      <section className="add-card">
        <p>Paste a public Instagram post or reel link. We’ll turn it into a recipe you can cook.</p>
        <form className="import-form" onSubmit={handleImport}>
          <label className="sr-only" htmlFor="instagram-link">
            Instagram recipe link
          </label>
          <input
            id="instagram-link"
            type="url"
            value={instagramLink}
            onChange={(event) => {
              setInstagramLink(event.target.value);
              setNotice("");
            }}
            placeholder="Paste link"
            autoComplete="url"
          />
          <button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Checking…" : "Add to backlog"}
          </button>
        </form>
        {importJob && (
          <div className="progress" role="status" aria-live="polite">
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, importJob.progress))}%` }}
              />
            </div>
            <div className="progress-meta">
              <span>{importJob.stageLabel || importStageLabel(importJob.stage)}</span>
              <span>{importJob.progress}%</span>
            </div>
          </div>
        )}
        <p className="helper">Recipes are processed one at a time. You can add another link while the backlog runs.</p>
        <div className={`server-status server-${serverState}`}>
          <span className="dot" />
          {serverState === "checking"
            ? "Checking recipe server…"
            : serverState === "ready"
              ? "Recipe extractor connected"
              : serverState === "extractor-missing"
                ? "Recipe extractor is not available"
                : "Recipe server unavailable"}
        </div>
      </section>
    </div>
  ) : (
    <div className="screen">
      <TopBar
        onAccount={() => setShowAccount(true)}
        onBacklog={openBacklog}
        backlogCount={activeJobs.length}
      />

      {tab === "favorites" && !user ? (
        <div className="signin-gate">
          <span className="signin-gate-icon">
            <Icon name="heart" size={28} filled />
          </span>
          <h2>Sign in to see your favorites</h2>
          <p>Your favorites and history sync across devices.</p>
          <button type="button" className="primary-btn" onClick={() => setAuthMode("login")}>
            Sign in
          </button>
          <button type="button" className="secondary-btn" onClick={() => setAuthMode("register")}>
            Create account
          </button>
        </div>
      ) : (
        <>
          <div className="search">
        <Icon name="search" />
        <label className="sr-only" htmlFor="recipe-search">
          Search recipes or ingredients
        </label>
        <input
          id="recipe-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search recipes or ingredients"
        />
      </div>

      <div className="filters">
        <label className={`filter-pill${mealFilter ? " active" : ""}`}>
          <span>{mealFilter || "Meal"}</span>
          <Icon name="chevrons-up-down" size={14} />
          <select aria-label="Filter by meal" value={mealFilter} onChange={(event) => setMealFilter(event.target.value)}>
            <option value="">Meal</option>
            {MEAL_OPTIONS.map((meal) => (
              <option key={meal} value={meal}>
                {meal === "Snack" ? "Snacks" : meal}
              </option>
            ))}
          </select>
        </label>
        <label className={`filter-pill${cuisineFilter ? " active" : ""}`}>
          <span>{cuisineFilter || "Cuisine"}</span>
          <Icon name="chevrons-up-down" size={14} />
          <select
            aria-label="Filter by cuisine"
            value={cuisineFilter}
            onChange={(event) => setCuisineFilter(event.target.value)}
          >
            <option value="">Cuisine</option>
            {cuisineOptions.map((cuisine) => (
              <option key={cuisine} value={cuisine}>
                {cuisine}
              </option>
            ))}
          </select>
        </label>
        <label className={`filter-pill${dietFilter ? " active" : ""}`}>
          <span>{dietFilter || "Diet"}</span>
          <Icon name="chevrons-up-down" size={14} />
          <select aria-label="Filter by diet" value={dietFilter} onChange={(event) => setDietFilter(event.target.value)}>
            <option value="">Diet</option>
            {DIET_OPTIONS.map((diet) => (
              <option key={diet} value={diet}>
                {diet}
              </option>
            ))}
          </select>
        </label>
      </div>

      {tab === "favorites" && <h2 className="page-heading">Favorites</h2>}

      {visibleRecipes.length > 0 ? (
        <div className="group">
          {visibleRecipes.map((recipe) => (
            <RecipeRow
              key={recipe.id}
              recipe={recipe}
              favorite={recipeIsFavorite(recipe)}
              onOpen={(selected) => openRecipe(selected, tab === "favorites" ? "favorites" : "library")}
              onToggleFavorite={(selected) => void toggleFavorite(selected)}
            />
          ))}
        </div>
      ) : (
        <EmptyState title={emptyTitle} body={emptyBody} />
      )}
        </>
      )}
    </div>
  );

  return (
    <div className="app">
      {content}
      {!detail && !showQueue && !showHistory && <TabBar tab={tab} onChange={setTab} />}
      {showAccount && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowAccount(false);
          }}
        >
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="account-title">
            <div className="sheet-head">
              <h2 id="account-title">Account</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowAccount(false)}>
                <Icon name="x" />
              </button>
            </div>
            {user ? (
              <>
                <p className="account-email">{user.email}</p>
                <div className="sheet-actions">
                  <button
                    type="button"
                    className="sheet-action"
                    onClick={() => {
                      setShowAccount(false);
                      setShowHistory(true);
                    }}
                  >
                    <span>History</span>
                    <Icon name="chevron-right" />
                  </button>
                  <button
                    type="button"
                    className="sheet-action"
                    onClick={() => {
                      setShowAccount(false);
                      handleLogout();
                    }}
                  >
                    <span>Sign out</span>
                  </button>
                  <button
                    type="button"
                    className="sheet-action danger"
                    onClick={() => {
                      setShowAccount(false);
                      setShowDeleteConfirm(true);
                    }}
                  >
                    <span>Delete account</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Your recipes, favorites, and history sync across devices.</p>
                <div className="sheet-actions">
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={() => {
                      setShowAccount(false);
                      setAuthMode("login");
                    }}
                  >
                    Sign in
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => {
                      setShowAccount(false);
                      setAuthMode("register");
                    }}
                  >
                    Create account
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {showSources && detail && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowSources(false);
          }}
        >
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sources-title">
            <div className="sheet-head">
              <h2 id="sources-title">Instagram posts</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowSources(false)}>
                <Icon name="x" />
              </button>
            </div>
            <div className="source-list">
              {detailSourceUrls.map((url, index) => (
                <a className="source-link" key={url} href={url} target="_blank" rel="noreferrer">
                  <span>
                    Source {index + 1} · {shortenUrl(url)}
                  </span>
                  <Icon name="chevron-right" />
                </a>
              ))}
            </div>
            <button type="button" className="secondary-btn" onClick={() => setShowSources(false)}>
              Done
            </button>
          </section>
        </div>
      )}

      {showTagSheet && detail && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowTagSheet(false);
          }}
        >
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="tag-title">
            <div className="sheet-head">
              <h2 id="tag-title">Add a tag</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setShowTagSheet(false)}>
                <Icon name="x" />
              </button>
            </div>
            <form
              className="auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                addTag();
              }}
            >
              <div className="field">
                <label htmlFor="tag-name">Tag name</label>
                <input
                  id="tag-name"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  maxLength={40}
                  autoFocus
                />
              </div>
              <button type="submit" className="primary-btn">
                Add tag
              </button>
              <button type="button" className="secondary-btn" onClick={() => setShowTagSheet(false)}>
                Cancel
              </button>
            </form>
          </section>
        </div>
      )}

      {ingredientSheet && ingredientSheetIngredient && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIngredientSheet(null);
          }}
        >
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="ingredient-title">
            <div className="sheet-head">
              <h2 id="ingredient-title">
                {ingredientSheet.mode === "unit" ? "Change unit" : "Amount & unit"}
              </h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setIngredientSheet(null)}>
                <Icon name="x" />
              </button>
            </div>
            <p className="sheet-hint">{ingredientSheetIngredient.name}</p>

            {ingredientSheet.mode === "unit" ? (
              <>
                <div className="unit-options">
                  {compatibleUnits(ingredientSheetIngredient.unit).map((unit) => {
                    const isCurrent = normalizeUnit(ingredientSheetIngredient.unit) === unit;
                    return (
                      <button
                        key={unit}
                        type="button"
                        className={`unit-option${isCurrent ? " on" : ""}`}
                        disabled={isSavingIngredient}
                        onClick={() => void saveIngredient(ingredientSheet.index, { unit })}
                      >
                        <span>{unit}</span>
                        {isCurrent && <Icon name="check" size={20} />}
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="secondary-btn" onClick={() => setIngredientSheet(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <div className="auth-form">
                <div className="field">
                  <label htmlFor="ingredient-amount">Amount</label>
                  <input
                    id="ingredient-amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={ingredientAmountDraft}
                    onChange={(event) => setIngredientAmountDraft(event.target.value)}
                    placeholder="e.g. 200"
                  />
                </div>
                <div className="field">
                  <label htmlFor="ingredient-unit">Unit</label>
                  <div className="select-wrap">
                    <select
                      id="ingredient-unit"
                      value={ingredientUnitDraft}
                      onChange={(event) => setIngredientUnitDraft(event.target.value)}
                    >
                      <option value="">No unit</option>
                      {ingredientUnitDraft && !isKnownUnit(ingredientUnitDraft) && (
                        <option value={ingredientUnitDraft}>{ingredientUnitDraft}</option>
                      )}
                      {UNIT_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.units.map((unit) => (
                            <option key={unit} value={unit}>
                              {unit}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <Icon name="chevrons-up-down" size={16} />
                  </div>
                </div>
                <button
                  type="button"
                  className="primary-btn"
                  disabled={isSavingIngredient}
                  onClick={saveIngredientQuantity}
                >
                  {isSavingIngredient ? "Saving…" : "Save"}
                </button>
                <button type="button" className="secondary-btn" onClick={() => setIngredientSheet(null)}>
                  Cancel
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {failureDialog && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setFailureDialog(null);
          }}
        >
          <section className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="failure-title">
            <div className="sheet-head">
              <h2 id="failure-title">Link already tried</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setFailureDialog(null)}>
                <Icon name="x" />
              </button>
            </div>
            <p>{failureDialog.message}</p>
            <div className="sheet-actions">
              {user ? (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void retryFailedJob(failureDialog.jobId, failureDialog.url)}
                >
                  Try again
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={() => setAuthMode("login")}>
                  Sign in to try again
                </button>
              )}
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setFailureDialog(null);
                  setInstagramLink("");
                  setNotice("Request cancelled.");
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {manualSheet && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setManualSheet(null);
          }}
        >
          <section className="sheet manual-sheet" role="dialog" aria-modal="true" aria-labelledby="manual-title">
            <div className="sheet-head">
              <h2 id="manual-title">Add recipe manually</h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setManualSheet(null)}>
                <Icon name="x" />
              </button>
            </div>
            <p className="sheet-hint">The link will be attached, so future submissions open this recipe.</p>
            <div className="auth-form">
              <div className="field">
                <label htmlFor="manual-title-input">Title</label>
                <input
                  id="manual-title-input"
                  value={manualTitle}
                  onChange={(event) => setManualTitle(event.target.value)}
                  maxLength={150}
                  placeholder="Recipe name"
                />
              </div>
              <div className="field">
                <label htmlFor="manual-category">Category</label>
                <div className="select-wrap">
                  <select
                    id="manual-category"
                    value={manualCategory}
                    onChange={(event) => setManualCategory(event.target.value)}
                  >
                    {MANUAL_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevrons-up-down" size={16} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="manual-cuisine">Cuisine</label>
                <input
                  id="manual-cuisine"
                  value={manualCuisine}
                  onChange={(event) => setManualCuisine(event.target.value)}
                  maxLength={50}
                  placeholder="e.g. Italian"
                />
              </div>
              <div className="manual-grid">
                <div className="field">
                  <label htmlFor="manual-servings">Servings</label>
                  <input
                    id="manual-servings"
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={manualServings}
                    onChange={(event) => setManualServings(event.target.value)}
                    placeholder="4"
                  />
                </div>
                <div className="field">
                  <label htmlFor="manual-prep">Prep minutes</label>
                  <input
                    id="manual-prep"
                    type="number"
                    min="1"
                    max="1440"
                    step="1"
                    value={manualPrep}
                    onChange={(event) => setManualPrep(event.target.value)}
                    placeholder="30"
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="manual-description">Description</label>
                <textarea
                  id="manual-description"
                  rows={2}
                  maxLength={500}
                  value={manualDescription}
                  onChange={(event) => setManualDescription(event.target.value)}
                />
              </div>

              <h3 className="manual-heading">Ingredients</h3>
              {manualIngredients.map((ingredient, index) => (
                <div className="manual-ingredient" key={index}>
                  <div className="manual-ingredient-top">
                    <input
                      className="manual-amount"
                      aria-label={`Ingredient ${index + 1} amount`}
                      type="number"
                      min="0"
                      step="any"
                      placeholder="Qty"
                      value={ingredient.amount}
                      onChange={(event) => updateManualIngredient(index, { amount: event.target.value })}
                    />
                    <div className="select-wrap manual-unit">
                      <select
                        aria-label={`Ingredient ${index + 1} unit`}
                        value={ingredient.unit}
                        onChange={(event) => updateManualIngredient(index, { unit: event.target.value })}
                      >
                        <option value="">No unit</option>
                        {UNIT_GROUPS.map((group) => (
                          <optgroup key={group.label} label={group.label}>
                            {group.units.map((unit) => (
                              <option key={unit} value={unit}>
                                {unit}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      <Icon name="chevrons-up-down" size={14} />
                    </div>
                    <input
                      className="manual-name"
                      aria-label={`Ingredient ${index + 1} name`}
                      placeholder="Ingredient"
                      maxLength={250}
                      value={ingredient.name}
                      onChange={(event) => updateManualIngredient(index, { name: event.target.value })}
                    />
                    <button
                      type="button"
                      className="manual-remove"
                      aria-label={`Remove ingredient ${index + 1}`}
                      onClick={() => removeManualIngredient(index)}
                      disabled={manualIngredients.length <= 1}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                  <input
                    className="manual-kcal"
                    aria-label={`Ingredient ${index + 1} calories`}
                    type="number"
                    min="0"
                    step="any"
                    placeholder="kcal (optional)"
                    value={ingredient.kcal}
                    onChange={(event) => updateManualIngredient(index, { kcal: event.target.value })}
                  />
                </div>
              ))}
              <button type="button" className="manual-add" onClick={addManualIngredient}>
                <Icon name="plus-circle" size={16} /> Add ingredient
              </button>

              <h3 className="manual-heading">Steps</h3>
              <div className="field">
                <label className="sr-only" htmlFor="manual-steps">
                  Steps
                </label>
                <textarea
                  id="manual-steps"
                  rows={5}
                  placeholder="One step per line"
                  value={manualSteps}
                  onChange={(event) => setManualSteps(event.target.value)}
                />
              </div>

              <button
                type="button"
                className="primary-btn"
                disabled={isSavingManual}
                onClick={() => void saveManualRecipe()}
              >
                {isSavingManual ? "Saving…" : "Save recipe"}
              </button>
              <button type="button" className="secondary-btn" onClick={() => setManualSheet(null)}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {showDeleteConfirm && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowDeleteConfirm(false);
          }}
        >
          <section className="sheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete account</h2>
            <p>
              This permanently deletes your account. Your recipes stay in the shared library but are no longer linked to
              you. Your favorites and history are removed. This cannot be undone.
            </p>
            <div className="sheet-actions">
              <button type="button" className="primary-btn" onClick={() => void handleDeleteAccount()}>
                Delete my account
              </button>
              <button type="button" className="secondary-btn" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {authMode && (
        <div
          className="sheet-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAuthMode(null);
          }}
        >
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <div className="sheet-head">
              <h2 id="auth-title">
                {authMode === "register"
                  ? "Create account"
                  : authMode === "verify"
                    ? "Verify your email"
                    : authMode === "forgot-password"
                      ? "Forgot password"
                      : authMode === "reset-password"
                        ? "Reset password"
                        : "Sign in"}
              </h2>
              <button type="button" className="round-btn" aria-label="Close" onClick={() => setAuthMode(null)}>
                <Icon name="x" />
              </button>
            </div>

            {authMode === "forgot-password" ? (
              <form className="auth-form" onSubmit={handleForgotPassword}>
                <p className="sheet-hint">Enter your email to receive a 6-digit reset code.</p>
                <div className="field">
                  <label htmlFor="reset-email">Email</label>
                  <input
                    id="reset-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@example.com"
                    value={resetEmail}
                    onChange={(event) => setResetEmail(event.target.value.toLowerCase())}
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Send reset code
                </button>
                <button type="button" className="link-btn" onClick={() => setAuthMode("login")}>
                  Back to sign in
                </button>
              </form>
            ) : authMode === "verify" ? (
              <form className="auth-form" onSubmit={handleAuth}>
                <p className="sheet-hint">
                  A 6-digit code was sent to <strong>{verifyEmail}</strong>.
                </p>
                <div className="field">
                  <label htmlFor="auth-code">Verification code</label>
                  <input
                    id="auth-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    required
                    placeholder="123456"
                    maxLength={6}
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Verify
                </button>
                <button type="button" className="link-btn" onClick={() => void handleResendVerification()}>
                  Resend code
                </button>
                <button type="button" className="link-btn" onClick={() => setAuthMode(null)}>
                  Cancel
                </button>
              </form>
            ) : authMode === "reset-password" ? (
              <form className="auth-form" onSubmit={handleAuth}>
                <p className="sheet-hint">
                  Enter the 6-digit code sent to <strong>{resetEmail}</strong>.
                </p>
                <div className="field">
                  <label htmlFor="reset-code">Reset code</label>
                  <input
                    id="reset-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="one-time-code"
                    required
                    placeholder="123456"
                    maxLength={6}
                  />
                </div>
                <div className="field">
                  <label htmlFor="new-password">New password</label>
                  <input
                    id="new-password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    placeholder="••••••••"
                    minLength={6}
                  />
                </div>
                <button type="submit" className="primary-btn">
                  Reset password
                </button>
                <button type="button" className="link-btn" onClick={() => void handleResendResetCode()}>
                  Resend code
                </button>
                <button type="button" className="link-btn" onClick={() => setAuthMode("login")}>
                  Cancel
                </button>
              </form>
            ) : (
              <form className="auth-form" onSubmit={handleAuth}>
                <div className="field">
                  <label htmlFor="auth-email">Email</label>
                  <input
                    id="auth-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@example.com"
                  />
                </div>
                <div className="field">
                  <label htmlFor="auth-password">Password</label>
                  <input
                    id="auth-password"
                    name="password"
                    type="password"
                    autoComplete={authMode === "register" ? "new-password" : "current-password"}
                    required
                    placeholder="••••••••"
                  />
                </div>
                <button type="submit" className="primary-btn">
                  {authMode === "register" ? "Create account" : "Sign in"}
                </button>
                {authMode === "login" && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setResetEmail("");
                      setAuthMode("forgot-password");
                    }}
                  >
                    Forgot password?
                  </button>
                )}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => setAuthMode(authMode === "register" ? "login" : "register")}
                >
                  {authMode === "register" ? "Already have an account? Sign in" : "Don’t have an account? Create one"}
                </button>
              </form>
            )}
          </section>
        </div>
      )}


      {notice && (
        <div className="toast" role="status" aria-live="polite">
          {notice}
        </div>
      )}
    </div>
  );
}

export default App;



