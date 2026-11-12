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
  const [showFavorites, setShowFavorites] = useState(false);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [instagramLink, setInstagramLink] = useState("");
  const [notice, setNotice] = useState("");
  const [savedRecipes, setSavedRecipes] = useState<Recipe[]>([]);
  const [serverState, setServerState] = useState<"checking" | "ready" | "hermes-missing" | "offline">("checking");
  const [isImporting, setIsImporting] = useState(false);
  const [importJob, setImportJob] = useState<{
    id: string;
    status: string;
    stage: string;
    progress: number;
    errorMessage?: string;
    recipeId?: string;
  } | null>(null);
  const [portions, setPortions] = useState<number | null>(null);
  const [commitInfo, setCommitInfo] = useState<{ hash: string; date: string; message: string } | null>(null);
  const [ingredientUnits, setIngredientUnits] = useState<Record<number, string>>({});
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("recipetor_token"));
  const [authMode, setAuthMode] = useState<"login" | "register" | "verify" | "forgot-password" | "reset-password" | null>(null);
  const [verifyEmail, setVerifyEmail] = useState<string>("");
  const [resetEmail, setResetEmail] = useState<string>("");
  const [showQueue, setShowQueue] = useState(false);
  const [showMobileAccount, setShowMobileAccount] = useState(false);
  const [queueJobs, setQueueJobs] = useState<Array<{ id: string; url: string; status: string; stage: string; progress: number; errorMessage?: string; recipeId?: string; createdBy: string | null; createdAt: string }>>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [history, setHistory] = useState<Array<Recipe & { action: string; createdAt: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);

  useEffect(() => {
    fetch("/commit-info.json")
      .then((res) => res.json())
      .then((data) => {
        setCommitInfo(data);
        // Check if this is a new version and log it
        console.log(`[recipetor] v${data.hash.substring(0, 7)} - ${data.message || "No release notes"}`);
        // Show update prompt if this commit differs from what was previously loaded
        if (data.hash) setShowUpdatePrompt(false); // reset, will be set by server
      })
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
        headers: { Authorization: `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        // Fetch favorites and history for the user
        const [favRes, histRes] = await Promise.all([
          fetch("/api/favorites", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/history", { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        if (favRes.ok) {
          const favData = await favRes.json();
          setFavorites(favData.favorites || []);
        }
        if (histRes.ok) {
          const histData = await histRes.json();
          setHistory(histData.history || []);
        }
        return;
      }
    } catch {}
    setToken(null);
    setUser(null);
    setFavorites([]);
    setHistory([]);
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

  const allRecipes = savedRecipes;
  const visibleRecipes = allRecipes.filter((recipe) => {
    const matchesCategory = category === "All recipes" || recipe.category === category;
    const matchesQuery = `${recipe.title} ${recipe.category} ${recipe.source}`.toLowerCase().includes(query.toLowerCase());
    const matchesFavorites = !showFavorites || favorites.includes(recipe.id);
    const matchesHistory = !showHistory || history.some((h) => h.id === recipe.id);
    return matchesCategory && matchesQuery && matchesFavorites && matchesHistory;
  });

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers as Record<string, string> || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(path, { ...options, headers });
  }

  async function fetchQueue() {
    try {
      const response = await apiFetch("/api/recipes/import/queue");
      if (response.ok) {
        const data = await response.json();
        setQueueJobs(data.jobs || []);
      }
    } catch {
      // Queue fetch failed silently
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
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Verification failed.");
          setNotice("Email verified! You can now sign in.");
          setAuthMode("login");
          return;
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Verification failed. Try again.");
          return;
        }
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
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Password reset failed.");
          setNotice("Password reset successfully! You can now sign in.");
          setAuthMode("login");
          setResetEmail("");
          return;
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Password reset failed. Try again.");
          return;
        }
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
        const data = await response.json();
        if (!response.ok) {
          if (data.requiresVerification && data.email) {
            setVerifyEmail(data.email);
            setAuthMode("verify");
            setNotice(data.message || "Please check your email for a verification code.");
          } else {
            throw new Error(data.error || "Authentication failed.");
          }
          return;
        }
        setToken(data.token);
        setUser(data.user);
        setAuthMode(null);
        setNotice(authMode === "register" ? "Account created! Welcome to Recipetor." : "Welcome back!");
        // Fetch favorites and history
        const [favRes, histRes] = await Promise.all([
          fetch("/api/favorites", { headers: { Authorization: `Bearer ${data.token}` } }),
          fetch("/api/history", { headers: { Authorization: `Bearer ${data.token}` } }),
        ]);
        if (favRes.ok) {
          const favData = await favRes.json();
          setFavorites(favData.favorites || []);
        }
        if (histRes.ok) {
          const histData = await histRes.json();
          setHistory(histData.history || []);
        }
        // Refresh saved recipes
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

  async function handleResendVerification() {
    if (!verifyEmail) return;
    setNotice("Sending new code…");
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verifyEmail }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to resend code.");
      setNotice("New verification code sent!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to resend code. Try again.");
    }
  }

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    console.log("[ForgotPassword] Submitting with email:", resetEmail);
    if (!resetEmail) return;
    setNotice("Sending reset code…");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetEmail }),
      });
      const data = await response.json();
      console.log("[ForgotPassword] Response:", response.status, data);
      if (!response.ok) throw new Error(data.error || "Failed to send reset code.");
      setAuthMode("reset-password");
      setNotice("Reset code sent! Check your email.");
    } catch (error) {
      console.error("[ForgotPassword] Error:", error);
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to resend code.");
      setNotice("New reset code sent!");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to resend code. Try again.");
    }
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setSavedRecipes([]);
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
        const error = await response.json();
        throw new Error(error.error || "Failed to delete account");
      }
      setToken(null);
      setUser(null);
      setSavedRecipes([]);
      setFavorites([]);
      setHistory([]);
      setShowDeleteConfirm(false);
      setNotice("Account deleted successfully.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to delete account.");
    }
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
              const result = await response.json() as {
                job?: { id: string; status: string; stage: string; progress: number; errorMessage?: string; recipeId?: string };
                recipe?: Recipe;
                duplicate?: boolean;
                reason?: string;
                error?: string;
                message?: string;
              };

              if (result.recipe) {
                // Recipe already exists (duplicate)
                const importedRecipe = result.recipe;
                setSavedRecipes((current) => [
                  importedRecipe,
                  ...current.filter((recipe) => recipe.id !== importedRecipe.id),
                ]);
                // The server favorites and logs the import for signed-in users.
                if (user) {
                  const isNewFavorite = !favorites.includes(importedRecipe.id);
                  setFavorites((current) => current.includes(importedRecipe.id) ? current : [...current, importedRecipe.id]);
                  if (isNewFavorite) {
                    setHistory((current) => [{ ...importedRecipe, action: "added", createdAt: new Date().toISOString() }, ...current]);
                  }
                }
                setSelectedRecipe(importedRecipe);
                setIngredientUnits({});
                setPortions(importedRecipe.basePortions ?? null);
                setInstagramLink("");
                setNotice(
                  result.reason === "source"
                    ? "This link was already saved. Here's the recipe."
                    : result.duplicate
                    ? "Same recipe found. The new Instagram link was added to it."
                    : "Recipe extracted and saved to your recipe box.",
                );
                setIsImporting(false);
                return;
              }

              if (result.job) {
                // Job started or existing job found, start polling
                setImportJob(result.job);
                setNotice("Extracting recipe with Hermes…");
                pollJobStatus(result.job.id);
                return;
              }

              throw new Error("Unexpected server response.");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Recipe import failed. Try again.");
        setIsImporting(false);
      }
    }

    async function pollJobStatus(jobId: string) {
      try {
        const response = await apiFetch(`/api/recipes/import/status/${jobId}`);
        if (!response.ok) throw new Error("Failed to check job status.");
        const result = await response.json() as { job: { id: string; status: string; stage: string; progress: number; errorMessage?: string; recipeId?: string } };
        const job = result.job;
        setImportJob(job);

        const stageMessages: Record<string, string> = {
          queued: "Waiting in queue…",
          fetching: "Fetching recipe from Instagram…",
          extracting: "Extracting recipe with Hermes…",
          saving: "Saving recipe…",
          completed: "Recipe ready!",
          failed: "Extraction failed.",
        };

        if (job.status === "completed" && job.recipeId) {
          // Fetch the completed recipe
          const recipeResponse = await apiFetch(`/api/recipes/${job.recipeId}`);
          if (recipeResponse.ok) {
            const recipe = await recipeResponse.json();
            setSavedRecipes((current) => [recipe, ...current.filter((r) => r.id !== recipe.id)]);
            // The server favorites and logs the import for signed-in users.
            if (user) {
              const isNewFavorite = !favorites.includes(recipe.id);
              setFavorites((current) => current.includes(recipe.id) ? current : [...current, recipe.id]);
              if (isNewFavorite) {
                setHistory((current) => [{ ...recipe, action: "added", createdAt: new Date().toISOString() }, ...current]);
              }
            }
            setSelectedRecipe(recipe);
            setIngredientUnits({});
            setPortions(recipe.basePortions ?? null);
            setInstagramLink("");
            setNotice("Recipe extracted and saved to your recipe box!");
          }
          setIsImporting(false);
          setImportJob(null);
          return;
        }

        if (job.status === "failed") {
          const errorDetail = job.errorMessage || "Unknown error during extraction.";
          setNotice(`Failed to extract recipe: ${errorDetail}`);
          setIsImporting(false);
          setImportJob(null);
          return;
        }

        setNotice(stageMessages[job.stage] || `Processing… (${job.progress}%)`);
        // Poll again in 2 seconds
        setTimeout(() => pollJobStatus(jobId), 2000);
      } catch (error) {
        setNotice("Lost connection to import job. Please try again.");
        setIsImporting(false);
        setImportJob(null);
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

  async function toggleFavorite(id: string) {
    if (!user) {
      setNotice("Please sign in to manage favorites.");
      return;
    }
    const isFav = favorites.includes(id);
    try {
      if (isFav) {
        const response = await apiFetch(`/api/favorites/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Failed to remove favorite.");
      } else {
        const response = await apiFetch("/api/favorites", {
          method: "POST",
          body: JSON.stringify({ recipeId: id }),
        });
        if (!response.ok) throw new Error("Failed to add favorite.");
      }
      // Update local state
      setFavorites((current) => current.includes(id) ? current.filter((f) => f !== id) : [...current, id]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not update favorite.");
    }
  }

  async function deleteRecipe(id: string) {
    if (!user) {
      setNotice("Please sign in to delete recipes.");
      return;
    }
    if (!window.confirm("Delete this recipe?")) return;

    const response = await apiFetch(`/api/recipes/${id}`, { method: "DELETE" });
    if (!response.ok) {
      let message = "Couldn't delete the recipe. Try again.";
      try {
        const data = await response.json() as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Keep the generic message when the response isn't JSON.
      }
      setNotice(message);
      return;
    }

    setSelectedRecipe(null);
    setSavedRecipes((current) => current.filter((recipe) => recipe.id !== id));
    setFavorites((current) => current.filter((favoriteId) => favoriteId !== id));
    setHistory((current) => current.filter((entry) => entry.id !== id));
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
          <button className={`nav-item ${!showFavorites && !showHistory ? "active" : ""}`} onClick={() => { setShowFavorites(false); setShowHistory(false); }}>
            <Icon name="grid" /> <span>My recipes</span><span className="nav-count">{allRecipes.length}</span>
          </button>
          <button className={`nav-item ${showFavorites ? "active" : ""}`} onClick={() => { setShowFavorites(true); setShowHistory(false); }}>
            <Icon name="bookmark" /> <span>Favorites</span>
          </button>
          {user && (
            <button className={`nav-item ${showHistory ? "active" : ""}`} onClick={() => { setShowHistory(true); setShowFavorites(false); }}>
              <Icon name="history" /> <span>History</span>
            </button>
          )}
          <button className="nav-item" onClick={() => { setShowFavorites(false); setShowHistory(false); setCategory("All recipes"); }}>
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
                      <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>Delete account</button>
                    </div>
                  ) : authMode === "forgot-password" ? (
                    <form onSubmit={handleForgotPassword} className="auth-form">
                      <h3>Forgot password</h3>
                      <p className="verify-hint">Enter your email to receive a 6-digit reset code.</p>
                      <div className="form-field">
                        <label htmlFor="reset-email">Email</label>
                        <input id="reset-email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" value={resetEmail} onChange={(e) => setResetEmail(e.target.value.toLowerCase())} />
                      </div>
                      <button type="submit" className="btn btn-primary">Send reset code</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setAuthMode("login")}>Cancel</button>
                    </form>
                  ) : authMode === "reset-password" ? (
                    <form onSubmit={handleAuth} className="auth-form">
                      <h3>Reset password</h3>
                      <p className="verify-hint">Enter the 6-digit code sent to <strong>{resetEmail}</strong>.</p>
                      <div className="form-field">
                        <label htmlFor="reset-code">Reset code</label>
                        <input id="reset-code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" required placeholder="123456" maxLength={6} />
                      </div>
                      <div className="form-field">
                        <label htmlFor="new-password">New password</label>
                        <input id="new-password" name="newPassword" type="password" autoComplete="new-password" required placeholder="••••••••" minLength={6} />
                      </div>
                      <button type="submit" className="btn btn-primary">Reset password</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setAuthMode("login")}>Cancel</button>
                      <p className="auth-switch">
                        Didn't receive the code? <button type="button" onClick={handleResendResetCode}>Resend code</button>
                      </p>
                    </form>
                  ) : authMode === "verify" ? (
                    <form onSubmit={handleAuth} className="auth-form">
                      <h3>Verify your email</h3>
                      <p className="verify-hint">A 6-digit code has been sent to <strong>{verifyEmail}</strong>.</p>
                      <div className="form-field">
                        <label htmlFor="auth-code">Verification code</label>
                        <input id="auth-code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" required placeholder="123456" maxLength={6} />
                      </div>
                      <button type="submit" className="btn btn-primary">Verify</button>
                      <button type="button" className="btn btn-ghost" onClick={() => setAuthMode(null)}>Cancel</button>
                      <p className="auth-switch">
                        Didn't receive the code? <button type="button" onClick={handleResendVerification}>Resend code</button>
                      </p>
                    </form>
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
                      {authMode === "login" && (
                        <p className="auth-switch"><button type="button" onClick={() => { setResetEmail(""); setAuthMode("forgot-password"); }}>Forgot password?</button></p>
                      )}
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
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {user && (
              <button className="mobile-account" aria-label="Account" onClick={() => setShowMobileAccount(true)}>
                <span className="avatar"><svg className="avatar-icon" viewBox="0 0 512 512" aria-hidden="true"><path fill="#4A2C1A" d="M256 512c-141.4 0-256-94.6-256-211.3 0-147.3 147.6-209.3 165.3-231.1 4.1-5.1 9.3-8.1 14.7-8.1h180c5.4 0 10.6 3 14.7 8.1 17.7 21.8 165.3 83.8 165.3 231.1 0 116.7-114.6 211.3-256 211.3zm0-144c-44.2 0-80-35.8-80-80s35.8-80 80-80 80 35.8 80 80-35.8 80-80 80zm0-32c53 0 96-43 96-96s-43-96-96-96-96 43-96 96 43 96 96 96z"/></svg></span>
              </button>
            )}
            <button className={`mobile-favorite ${showFavorites ? "active" : ""}`} aria-label="Toggle favorites" onClick={() => setShowFavorites(!showFavorites)}><Icon name="bookmark" /></button>
          </div>
        </header>

        <div className="version-banner">recipetor v{commitInfo?.hash?.substring(0, 7) || "dev"}</div>
        <div className="content-wrap">
          <div className="topline">
            <div className="breadcrumb"><span>Your kitchen</span><span className="breadcrumb-separator">/</span><strong>{showHistory ? "History" : showFavorites ? "Favorites" : "Recipe box"}</strong></div>
            <span className="free-badge"><span /> Always free</span>
          </div>

          <section className="welcome-row">
            <div>
              <p className="eyebrow">A LITTLE INSPIRATION, SAVED</p>
              <h1>{showHistory ? "Your history" : showFavorites ? "Your favorites" : "Your recipe box"}</h1>
              <p className="welcome-copy">{showHistory ? "Recipes you've added to your collection." : "Good food deserves a place you can find it again."}</p>
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
              {importJob && isImporting && (
                <div className="import-progress" role="status" aria-live="polite">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${importJob.progress}%` }} />
                  </div>
                  <div className="progress-info">
                    <span className="progress-stage">{importJob.stage.charAt(0).toUpperCase() + importJob.stage.slice(1)}</span>
                    <span className="progress-percent">{importJob.progress}%</span>
                  </div>
                </div>
              )}
              <div className="import-foot">
                <span className={`server-status server-${serverState}`}><span />
                  {serverState === "checking" ? "Checking recipe server…" : serverState === "ready" ? "Hermes connected" : serverState === "hermes-missing" ? "Hermes is not available on the server" : "Recipe server unavailable"}
                </span>
                <span>Duplicate recipes are grouped together.</span>
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowQueue(!showQueue); if (!showQueue) fetchQueue(); }}>
                  <Icon name="collection" size={14} /> {showQueue ? "Hide queue" : "View queue"}
                </button>
              </div>
              {notice && <p className="notice" role="status">{notice}</p>}
            </div>
          </section>

          {showQueue && (
            <section className="queue-section" aria-labelledby="queue-title">
              <div className="queue-header">
                <h2 id="queue-title"><Icon name="collection" size={18} /> Extraction Queue</h2>
                <button className="btn btn-ghost btn-sm" onClick={() => { fetchQueue(); }}>Refresh</button>
              </div>
              {queueJobs.length === 0 ? (
                <p className="queue-empty">No extraction jobs in queue.</p>
              ) : (
                <div className="queue-list">
                  {queueJobs.map((job) => (
                    <article key={job.id} className={`queue-item queue-${job.status}`}>
                      <div className="queue-url">
                        <span className="queue-status-badge queue-status-{job.status}">{job.status}</span>
                        <a href={job.url} target="_blank" rel="noopener noreferrer" className="queue-link">
                          {job.url}
                        </a>
                      </div>
                      <div className="queue-progress">
                        <div className="progress-bar">
                          <div className="progress-fill" style={{ width: `${job.progress}%` }} />
                        </div>
                        <div className="progress-info">
                          <span className="progress-stage">{job.stage.charAt(0).toUpperCase() + job.stage.slice(1)}</span>
                          <span className="progress-percent">{job.progress}%</span>
                        </div>
                      </div>
                      <div className="queue-meta">
                        <span>Submitted: {new Date(job.createdAt).toLocaleString()}</span>
                        {job.createdBy && <span>By: {job.createdBy}</span>}
                        {job.errorMessage && <span className="queue-error">Error: {job.errorMessage}</span>}
                        {job.recipeId && <span className="queue-success">Recipe ready! <a href={`#${job.recipeId}`} onClick={() => { setSelectedRecipe(savedRecipes.find(r => r.id === job.recipeId) || null); setShowQueue(false); }}>View</a></span>}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="library-section" aria-labelledby="library-title">
            <div className="library-heading">
              <div><h2 id="library-title">{showHistory ? "History" : showFavorites ? "Saved favorites" : "Your collection"} <span className="recipe-count">{visibleRecipes.length}</span></h2><p>{showHistory ? "Recipes you've added, in order added." : savedRecipes.length ? "Your imported recipes, all in one place." : "No recipes yet. Add one from Instagram!"}</p></div>
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
                    <span className="example-tag saved-tag">SAVED</span>
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
            </div> : <div className="empty-state"><span className="empty-icon"><Icon name={showHistory ? "history" : showFavorites ? "bookmark" : "search"} size={22} /></span><h3>{showHistory ? "No history yet" : showFavorites ? "No favorites yet" : "No recipes found"}</h3><p>{showHistory ? "Recipes you add will appear here." : showFavorites ? "Tap the bookmark on a recipe to keep it close." : "Try another search or choose a different category."}</p></div>}
            <p className="sample-note">{showHistory ? "Your recipe journey starts with the first import." : savedRecipes.length ? "Add another Instagram recipe whenever inspiration strikes." : "Add a recipe from Instagram to get started."}</p>
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
          <button className={!showFavorites && !showHistory ? "selected" : ""} onClick={() => { setShowFavorites(false); setShowHistory(false); }}><Icon name="grid" /><span>Recipes</span></button>
          <button className={showFavorites ? "selected" : ""} onClick={() => { setShowFavorites(true); setShowHistory(false); }}><Icon name="bookmark" /><span>Favorites</span></button>
          {user && <button className={showHistory ? "selected" : ""} onClick={() => { setShowHistory(true); setShowFavorites(false); }}><Icon name="history" /><span>History</span></button>}
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
            <p className="modal-source">Saved from <strong>{selectedRecipe.source}</strong></p>
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
                  <h3>Ingredients <span>({selectedRecipe.ingredients?.length ?? 0})</span></h3>
                  {selectedRecipe.basePortions && <div className="portions-control">
                    <label>Portions</label>
                    <input type="number" min="1" value={portions ?? selectedRecipe.basePortions} onChange={(event) => setPortions(Math.max(1, parseInt(event.target.value, 10) || 1))} />
                  </div>}
                </div>
                <ul>
                  {selectedRecipe.ingredients?.map((ingredient, index) => {
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
              <div><h3>Let’s make it</h3><ol>{selectedRecipe.steps?.map((step) => <li key={step}>{step}</li>)}</ol></div>
            </div>
          </div>
        </section>
      </div>}

      {showDeleteConfirm && (
        <div className="modal-overlay" onClick={() => setShowDeleteConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete account</h2>
            <p>This will permanently delete your account. Your recipes will remain in the shared library but will no longer be linked to your account. Your favorites and history will be deleted. This action cannot be undone.</p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDeleteAccount}>Delete my account</button>
            </div>
          </div>
        </div>
      )}

      {showMobileAccount && (
        <div className="modal-overlay" onClick={() => setShowMobileAccount(false)}>
          <div className="modal modal-mobile-account" onClick={(e) => e.stopPropagation()}>
            {user ? (
              <div className="mobile-account-content">
                <div className="mobile-account-header">
                  <span className="avatar"><svg className="avatar-icon" viewBox="0 0 512 512" aria-hidden="true"><path fill="#4A2C1A" d="M256 512c-141.4 0-256-94.6-256-211.3 0-147.3 147.6-209.3 165.3-231.1 4.1-5.1 9.3-8.1 14.7-8.1h180c5.4 0 10.6 3 14.7 8.1 17.7 21.8 165.3 83.8 165.3 231.1 0 116.7-114.6 211.3-256 211.3zm0-144c-44.2 0-80-35.8-80-80s35.8-80 80-80 80 35.8 80 80-35.8 80-80 80zm0-32c53 0 96-43 96-96s-43-96-96-96-96 43-96 96 43 96 96 96z"/></svg></span>
                  <div className="mobile-account-info">
                    <strong>{user.email}</strong>
                    <small>Signed in</small>
                  </div>
                </div>
                <div className="mobile-account-actions">
                  <button className="btn btn-secondary" onClick={handleLogout}>Sign out</button>
                  <button className="btn btn-danger" onClick={() => { setShowMobileAccount(false); setShowDeleteConfirm(true); }}>Delete account</button>
                </div>
              </div>
            ) : (
              <div className="mobile-account-content">
                <h3>Sign in to save recipes</h3>
                <p className="mobile-account-hint">Your recipes, favorites, and history sync across devices.</p>
                <div className="mobile-account-actions">
                  <button className="btn btn-primary" onClick={() => { setShowMobileAccount(false); setAuthMode("login"); }}>Sign in</button>
                  <button className="btn btn-secondary" onClick={() => { setShowMobileAccount(false); setAuthMode("register"); }}>Create account</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showUpdatePrompt && (
        <div className="modal-overlay" onClick={() => setShowUpdatePrompt(false)}>
          <div className="modal modal-update-prompt" onClick={(e) => e.stopPropagation()}>
            <div className="update-prompt-content">
              <div className="update-icon"><Icon name="refresh-cw" size={28} /></div>
              <h3>Update available</h3>
              <p>A new version of recipetor is ready.</p>
              <button className="btn btn-primary" onClick={() => window.location.reload()}>Refresh now</button>
              <button className="btn btn-ghost" onClick={() => setShowUpdatePrompt(false)}>Later</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
