import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetch,
  uploadImage,
  type Child,
  type ClassMember,
  type ClassPost,
  type ClassSummary,
  type CookAlong,
  type JoinRequest,
} from "../lib/api";
import { compressPhoto } from "../lib/photo";
import { EmptyNote, ErrorNote, Loading, ScreenHeader } from "./ui";

type Detail = {
  class: ClassSummary;
  membership: { status: string; role: string } | null;
  pending: boolean;
  unread?: number;
};

type RecipeOption = {
  id: string;
  title: string;
  imageUrl: string | null;
  visibility: "private" | "class" | "public";
  canEdit?: boolean;
};

type Tab = "cook-alongs" | "gallery" | "families" | "settings";

export function ClassDetailScreen({
  classId,
  token,
  onBack,
  onOpenRecipe,
  onOpenLibrary,
}: {
  classId: string;
  token: string | null;
  onBack: () => void;
  onOpenRecipe: (recipeId: string) => void;
  onOpenLibrary: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("cook-alongs");
  const [cookAlongs, setCookAlongs] = useState<CookAlong[]>([]);
  const [gallery, setGallery] = useState<ClassPost[]>([]);
  const [members, setMembers] = useState<ClassMember[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [activeCookAlong, setActiveCookAlong] = useState<CookAlong | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [showCookbook, setShowCookbook] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [showCookAlongForm, setShowCookAlongForm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Detail>(`/api/classes/${classId}`, { token });
      setDetail(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open that class.");
    } finally {
      setLoading(false);
    }
  }, [classId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const isAdmin = detail?.class?.role === "admin";

  const loadTab = useCallback(async () => {
    if (!detail?.class || detail.pending) return;
    try {
      if (tab === "cook-alongs") {
        const data = await apiFetch<{ cookAlongs: CookAlong[] }>(`/api/classes/${classId}/cook-alongs`, { token });
        setCookAlongs(data.cookAlongs);
      } else if (tab === "gallery") {
        const data = await apiFetch<{ posts: ClassPost[] }>(`/api/classes/${classId}/gallery`, { token });
        setGallery(data.posts);
      } else if (tab === "families") {
        const data = await apiFetch<{ members: ClassMember[] }>(`/api/classes/${classId}/members`, { token });
        setMembers(data.members);
        if (isAdmin) {
          const req = await apiFetch<{ requests: JoinRequest[] }>(`/api/classes/${classId}/requests`, { token });
          setRequests(req.requests);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load that.");
    }
  }, [classId, detail, isAdmin, tab, token]);

  useEffect(() => {
    void loadTab();
  }, [loadTab]);

  async function refreshAfterChange() {
    await load();
    await loadTab();
  }

  async function cancelRequest() {
    if (!window.confirm("Cancel your request to join this class?")) return;
    try {
      await apiFetch(`/api/classes/${classId}/cancel-request`, { method: "POST", token });
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't cancel that request.");
    }
  }

  if (loading) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Class" onBack={onBack} />
          <Loading />
        </div>
      </div>
    );
  }

  if (!detail?.class) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title="Class" onBack={onBack} />
          <ErrorNote>{error || "This class isn't available."}</ErrorNote>
        </div>
      </div>
    );
  }

  if (detail.pending) {
    return (
      <div className="app feature-app">
        <div className="screen">
          <ScreenHeader title={detail.class.name} onBack={onBack} />
          <div className="pending-card">
            <span className="pending-icon" aria-hidden="true">
              ⏳
            </span>
            <h2>Waiting for approval</h2>
            <p>An admin will review your request. You'll get an email when you're approved.</p>
            {(detail.class.children ?? []).length > 0 && (
              <dl className="pending-summary">
                <dt>{(detail.class.children ?? []).length === 1 ? "Child" : "Children"}</dt>
                <dd>{(detail.class.children ?? []).map((child) => child.displayName).join(", ")}</dd>
              </dl>
            )}
            <ErrorNote>{error}</ErrorNote>
            <button type="button" className="secondary-btn" onClick={() => void load()}>
              Check again
            </button>
            <button type="button" className="link-btn danger" onClick={() => void cancelRequest()}>
              Cancel request
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app feature-app">
      <div className="screen">
        <ScreenHeader
          title={detail.class.name}
          subtitle={`${detail.class.memberCount} ${
            detail.class.memberCount === 1 ? "family" : "families"
          }${detail.class.archived ? " · Archived" : ""}`}
          onBack={onBack}
          action={
            isAdmin ? (
              <button type="button" className="round-btn" aria-label="Class settings" onClick={() => setTab("settings")}>
                ⚙
              </button>
            ) : undefined
          }
        />
        <ErrorNote>{error}</ErrorNote>

        <div className="segmented" role="tablist" aria-label="Class sections">
          {(
            [
              ["cook-alongs", "Cook-Alongs"],
              ["gallery", "Gallery"],
              ["families", isAdmin && detail.class.pendingApprovals > 0 ? `Families (${detail.class.pendingApprovals})` : "Families"],
              ...(isAdmin ? [["settings", "Settings"] as [Tab, string]] : []),
            ] as Array<[Tab, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={`segmented-btn${tab === value ? " active" : ""}`}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {detail.class.archived && (
          <p className="helper">This class is archived. You can still read the cookbook and gallery.</p>
        )}

        {tab === "cook-alongs" && (
          <CookAlongTab
            classId={classId}
            token={token}
            cookAlongs={cookAlongs}
            isAdmin={isAdmin}
            archived={detail.class.archived}
            onCreate={() => setShowCookAlongForm(true)}
            onOpen={setActiveCookAlong}
            onGallery={() => setTab("gallery")}
          />
        )}

        {tab === "gallery" && (
          <GalleryTab
            posts={gallery}
            isAdmin={isAdmin}
            onPresent={() => setPresenting(true)}
            onCookbook={() => setShowCookbook(true)}
            onRefresh={loadTab}
            onError={setError}
            token={token}
            onOpenRecipe={onOpenRecipe}
          />
        )}

        {tab === "families" && (
          <FamiliesTab
            classId={classId}
            token={token}
            isAdmin={isAdmin}
            members={members}
            requests={requests}
            children={detail.class.children ?? []}
            onChanged={refreshAfterChange}
            onError={setError}
          />
        )}

        {tab === "settings" && isAdmin && (
          <SettingsTab
            current={detail.class}
            token={token}
            onChanged={refreshAfterChange}
            onLeft={onBack}
            onError={setError}
          />
        )}

        <div className="feature-footer-actions">
          <button type="button" className="secondary-btn" onClick={onOpenLibrary}>
            Your recipes
          </button>
          {!detail.class.archived && (
            <button type="button" className="primary-btn" onClick={() => setShowPost(true)}>
              Share a cook
            </button>
          )}
        </div>
      </div>

      {activeCookAlong && (
        <CookAlongDetail
          cookAlong={activeCookAlong}
          token={token}
          children={detail.class.children ?? []}
          isAdmin={isAdmin}
          onClose={() => {
            setActiveCookAlong(null);
            void loadTab();
          }}
        />
      )}

      {showPost && (
        <PostSheet
          cookAlong={cookAlongs.find((item) => item.status === "open") ?? null}
          cookAlongs={cookAlongs}
          children={detail.class.children ?? []}
          token={token}
          onClose={() => setShowPost(false)}
          onPosted={() => {
            setShowPost(false);
            setTab("gallery");
            void loadTab();
          }}
          onError={setError}
        />
      )}

      {showCookAlongForm && (
        <CookAlongForm
          classId={classId}
          token={token}
          onClose={() => setShowCookAlongForm(false)}
          onCreated={() => {
            setShowCookAlongForm(false);
            void loadTab();
          }}
          onError={setError}
        />
      )}

      {presenting && (
        <PresentationMode posts={gallery.filter((post) => !post.hidden)} onClose={() => setPresenting(false)} />
      )}

      {showCookbook && (
        <CookbookView classId={classId} token={token} onClose={() => setShowCookbook(false)} />
      )}
    </div>
  );
}

/* ---------------- Cook-Alongs ---------------- */

function CookAlongTab({
  cookAlongs,
  isAdmin,
  archived,
  onCreate,
  onOpen,
  onGallery,
}: {
  classId: string;
  token: string | null;
  cookAlongs: CookAlong[];
  isAdmin: boolean;
  archived: boolean;
  onCreate: () => void;
  onOpen: (cookAlong: CookAlong) => void;
  onGallery: () => void;
}) {
  return (
    <>
      <div className="feature-actions">
        {isAdmin && !archived && (
          <button type="button" className="primary-btn" onClick={onCreate}>
            New Cook-Along
          </button>
        )}
        <button type="button" className="secondary-btn" onClick={onGallery}>
          Open gallery
        </button>
      </div>
      {cookAlongs.length === 0 ? (
        <EmptyNote
          title="No Cook-Alongs yet"
          body={isAdmin ? "Start one so families know what to cook this week." : "Your class admin will start one soon."}
        />
      ) : (
        <div className="group">
          {cookAlongs.map((item) => (
            <button type="button" key={item.id} className="cook-along-row" onClick={() => onOpen(item)}>
              <span className={`status-dot ${item.status}`} aria-hidden="true" />
              <span className="class-row-text">
                <span className="class-row-title">{item.title}</span>
                <span className="class-row-sub">
                  {item.status === "open" ? "Open" : "Closed"} · {item.postCount}{" "}
                  {item.postCount === 1 ? "post" : "posts"}
                  {item.dueDate ? ` · due ${item.dueDate}` : ""}
                </span>
              </span>
              <span aria-hidden="true" className="chev">
                ›
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CookAlongDetail({
  cookAlong,
  token,
  children,
  isAdmin,
  onClose,
}: {
  cookAlong: CookAlong;
  token: string | null;
  children: Child[];
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [posts, setPosts] = useState<ClassPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showPost, setShowPost] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ posts: ClassPost[] }>(`/api/cook-alongs/${cookAlong.id}/posts`, { token });
      setPosts(data.posts);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load posts.");
    } finally {
      setLoading(false);
    }
  }, [cookAlong.id, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleHidden(post: ClassPost) {
    try {
      await apiFetch(`/api/posts/${post.id}/${post.hidden ? "unhide" : "hide"}`, { method: "POST", token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update that post.");
    }
  }

  async function remove(post: ClassPost) {
    if (!window.confirm(isAdmin && !post.isMine ? "Remove this family's post?" : "Delete your post?")) return;
    try {
      await apiFetch(`/api/posts/${post.id}`, { method: "DELETE", token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that post.");
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet full-sheet" role="dialog" aria-modal="true" aria-labelledby="cook-along-title">
        <div className="sheet-head">
          <div>
            <h2 id="cook-along-title">{cookAlong.title}</h2>
            <p className="helper">{cookAlong.prompt || "Share what your family cooked."}</p>
          </div>
          <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <ErrorNote>{error}</ErrorNote>
        {cookAlong.status === "open" && cookAlong.postCount < (children.length || 99) && (
          <button type="button" className="primary-btn" onClick={() => setShowPost(true)}>
            Share a cook
          </button>
        )}
        {loading ? (
          <Loading />
        ) : posts.length === 0 ? (
          <EmptyNote title="No posts yet" body="Be the first to share a photo of your family's dish." />
        ) : (
          <div className="post-list">
            {posts.map((post) => (
              <article key={post.id} className={`post-card${post.hidden ? " is-hidden" : ""}`}>
                {post.photoUrl ? (
                  <img src={post.photoUrl} alt={`${post.childName}'s dish`} loading="lazy" />
                ) : (
                  <div className="post-placeholder" aria-hidden="true">
                    🍽
                  </div>
                )}
                <div className="post-body">
                  <p className="post-child">{post.childName}</p>
                  {post.note && <p className="post-note">{post.note}</p>}
                  <p className="post-meta">
                    {post.recipeTitle} · {new Date(post.createdAt).toLocaleDateString()}
                    {post.hidden ? " · Hidden" : ""}
                  </p>
                  <div className="post-actions">
                    {isAdmin && (
                      <button type="button" className="link-btn" onClick={() => void toggleHidden(post)}>
                        {post.hidden ? "Unhide" : "Hide"}
                      </button>
                    )}
                    {post.canDelete && (
                      <button type="button" className="link-btn danger" onClick={() => void remove(post)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}

        {showPost && (
          <PostSheet
            cookAlong={cookAlong}
            cookAlongs={[cookAlong]}
            children={children}
            token={token}
            onClose={() => setShowPost(false)}
            onPosted={() => {
              setShowPost(false);
              void load();
            }}
            onError={setError}
          />
        )}
      </section>
    </div>
  );
}

function PostSheet({
  cookAlong,
  cookAlongs,
  children,
  token,
  onClose,
  onPosted,
  onError,
}: {
  cookAlong: CookAlong | null;
  cookAlongs: CookAlong[];
  children: Child[];
  token: string | null;
  onClose: () => void;
  onPosted: () => void;
  onError: (message: string) => void;
}) {
  const [selectedCookAlong, setSelectedCookAlong] = useState(cookAlong?.id ?? cookAlongs.find((item) => item.status === "open")?.id ?? "");
  const [childId, setChildId] = useState(children[0]?.id ?? "");
  const [recipeId, setRecipeId] = useState("");
  const [note, setNote] = useState("");
  const [publish, setPublish] = useState(false);
  const [recipes, setRecipes] = useState<RecipeOption[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const selectedRecipe = useMemo(() => recipes.find((item) => item.id === recipeId), [recipeId, recipes]);

  useEffect(() => {
    apiFetch<{ recipes: RecipeOption[] }>("/api/recipes", { token })
      .then((data) => setRecipes(data.recipes))
      .catch(() => setError("Couldn't load your recipes."));
  }, [token]);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  async function submit() {
    if (!selectedCookAlong) return setError("This Cook-Along is closed.");
    if (!childId) return setError("Choose your child.");
    if (!recipeId) return setError("Choose the recipe you cooked.");
    setBusy(true);
    setError("");
    try {
      const created = await apiFetch<{ post: ClassPost }>(`/api/cook-alongs/${selectedCookAlong}/posts`, {
        method: "POST",
        token,
        body: JSON.stringify({ childId, recipeId, note, visibility: publish ? "public" : undefined }),
      });
      if (photo) {
        const blob = await compressPhoto(photo);
        await uploadImage(`/api/posts/${created.post.id}/photo`, blob, token, "image/jpeg");
      }
      onPosted();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't share that post.";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="post-title">
        <div className="sheet-head">
          <h2 id="post-title">Share a cook</h2>
          <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <ErrorNote>{error}</ErrorNote>

        {cookAlongs.length > 1 && (
          <label className="field">
            <span>Cook-Along</span>
            <select value={selectedCookAlong} onChange={(event) => setSelectedCookAlong(event.target.value)}>
              {cookAlongs.map((item) => (
                <option key={item.id} value={item.id} disabled={item.status !== "open"}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Who cooked?</span>
          <select value={childId} onChange={(event) => setChildId(event.target.value)}>
            {children.length === 0 && <option value="">Add a child first</option>}
            {children.map((child) => (
              <option key={child.id} value={child.id}>
                {child.displayName}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Recipe</span>
          <select value={recipeId} onChange={(event) => setRecipeId(event.target.value)}>
            <option value="">Choose a recipe</option>
            {recipes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
                {item.visibility === "private" ? " (Private)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Note (optional)</span>
          <input
            value={note}
            maxLength={140}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What did they think?"
          />
        </label>

        <div className="field">
          <span>Photo</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(event) => setPhoto(event.target.files?.[0] ?? null)}
          />
          {preview ? (
            <button type="button" className="photo-preview" onClick={() => fileRef.current?.click()}>
              <img src={preview} alt="Selected dish" />
              <span>Change photo</span>
            </button>
          ) : (
            <button type="button" className="photo-picker" onClick={() => fileRef.current?.click()}>
              📷 Take or choose a photo
            </button>
          )}
        </div>

        {selectedRecipe?.canEdit && (
          <label className="checkbox-row">
            <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} />
            <span>
              Also share this recipe on Discover
              <span className="helper">Only your own recipes can be made public.</span>
            </span>
          </label>
        )}
        {!selectedRecipe?.canEdit && selectedRecipe && (
          <p className="helper">This recipe stays Class only. Only its owner can make it public.</p>
        )}

        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? "Sharing…" : "Share with class"}
        </button>
      </section>
    </div>
  );
}

function CookAlongForm({
  classId,
  token,
  onClose,
  onCreated,
  onError,
}: {
  classId: string;
  token: string | null;
  onClose: () => void;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!title.trim()) return setError("Give the Cook-Along a title.");
    setBusy(true);
    try {
      await apiFetch(`/api/classes/${classId}/cook-alongs`, {
        method: "POST",
        token,
        body: JSON.stringify({ title, prompt, dueDate: dueDate || null }),
      });
      onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start that Cook-Along.";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="cook-along-form-title">
        <div className="sheet-head">
          <h2 id="cook-along-form-title">New Cook-Along</h2>
          <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <label className="field">
          <span>Title</span>
          <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="This week: soup" />
        </label>
        <label className="field">
          <span>Prompt (optional)</span>
          <textarea value={prompt} rows={3} maxLength={500} onChange={(event) => setPrompt(event.target.value)} placeholder="Cook any soup together." />
        </label>
        <label className="field">
          <span>Due date (optional)</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
        </label>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void submit()}>
          {busy ? "Starting…" : "Start Cook-Along"}
        </button>
      </section>
    </div>
  );
}

/* ---------------- Gallery ---------------- */

function GalleryTab({
  posts,
  isAdmin,
  token,
  onPresent,
  onCookbook,
  onRefresh,
  onError,
  onOpenRecipe,
}: {
  posts: ClassPost[];
  isAdmin: boolean;
  token: string | null;
  onPresent: () => void;
  onCookbook: () => void;
  onRefresh: () => void;
  onError: (message: string) => void;
  onOpenRecipe: (recipeId: string) => void;
}) {
  async function toggle(post: ClassPost) {
    try {
      await apiFetch(`/api/posts/${post.id}/${post.hidden ? "unhide" : "hide"}`, { method: "POST", token });
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't update that post.");
    }
  }

  if (posts.length === 0) {
    return (
      <>
        <div className="feature-actions">
          <button type="button" className="secondary-btn" onClick={onCookbook}>
            Class cookbook
          </button>
        </div>
        <EmptyNote title="The gallery is empty" body="Photos shared in Cook-Alongs show up here for the whole class." />
      </>
    );
  }

  return (
    <>
      <div className="feature-actions">
        <button type="button" className="primary-btn" onClick={onPresent}>
          Presentation mode
        </button>
        <button type="button" className="secondary-btn" onClick={onCookbook}>
          Class cookbook
        </button>
      </div>
      <div className="gallery-grid">
        {posts.map((post) => (
          <figure key={post.id} className={`gallery-item${post.hidden ? " is-hidden" : ""}`}>
            {post.photoUrl ? (
              <img src={post.photoUrl} alt={`${post.childName}'s dish`} loading="lazy" />
            ) : (
              <div className="post-placeholder" aria-hidden="true">
                🍽
              </div>
            )}
            <figcaption>
              <button type="button" className="link-btn" onClick={() => onOpenRecipe(post.recipeId)}>
                {post.recipeTitle}
              </button>
              <span className="helper">{post.childName}</span>
              {post.hidden && <span className="hidden-tag">Hidden</span>}
            </figcaption>
            {isAdmin && (
              <button type="button" className="gallery-hide" onClick={() => void toggle(post)}>
                {post.hidden ? "Unhide" : "Hide"}
              </button>
            )}
          </figure>
        ))}
      </div>
    </>
  );
}

function PresentationMode({ posts, onClose }: { posts: ClassPost[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const post = posts[index];

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((value) => Math.min(posts.length - 1, value + 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, posts.length]);

  if (!post) {
    return (
      <div className="presentation">
        <p>No photos to present.</p>
        <button type="button" className="primary-btn" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="presentation" role="dialog" aria-modal="true" aria-label="Presentation mode">
      <div className="presentation-stage">
        {post.photoUrl ? (
          <img src={post.photoUrl} alt={`${post.childName}'s dish`} />
        ) : (
          <div className="post-placeholder" aria-hidden="true">
            🍽
          </div>
        )}
      </div>
      <div className="presentation-caption">
        <p className="post-child">{post.childName}</p>
        <p>{post.recipeTitle}</p>
        {post.note && <p className="post-note">{post.note}</p>}
      </div>
      <div className="presentation-controls">
        <button type="button" className="round-btn" aria-label="Previous" onClick={() => setIndex((v) => Math.max(0, v - 1))}>
          ‹
        </button>
        <span>
          {index + 1} / {posts.length}
        </span>
        <button
          type="button"
          className="round-btn"
          aria-label="Next"
          onClick={() => setIndex((v) => Math.min(posts.length - 1, v + 1))}
        >
          ›
        </button>
        <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}

function CookbookView({ classId, token, onClose }: { classId: string; token: string | null; onClose: () => void }) {
  const [data, setData] = useState<{
    class: ClassSummary;
    exportedAt: string;
    recipes: Array<{
      id: string;
      title: string;
      description: string;
      imageUrl: string | null;
      prepTimeMinutes: number;
      baseServings: number | null;
      ingredients: Array<{ amount: number | null; unit: string; name: string }>;
      steps: string[];
      allergenTags: string[];
      postedIn: Array<{ cookAlongTitle: string }>;
    }>;
  } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<NonNullable<typeof data>>(`/api/classes/${classId}/cookbook`, { token })
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [classId, token]);

  return (
    <div className="cookbook-overlay">
      <div className="cookbook-toolbar">
        <button type="button" className="round-btn" aria-label="Close cookbook" onClick={onClose}>
          ✕
        </button>
        <button type="button" className="primary-btn" onClick={() => window.print()}>
          Print or save PDF
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!data ? (
        <Loading label="Building the cookbook…" />
      ) : (
        <article className="cookbook-print">
          <header className="cookbook-cover">
            <p className="cookbook-eyebrow">Class cookbook</p>
            <h1>{data.class.name}</h1>
            <p>
              {data.recipes.length} {data.recipes.length === 1 ? "recipe" : "recipes"} ·{" "}
              {new Date(data.exportedAt).toLocaleDateString()}
            </p>
          </header>
          {data.recipes.length === 0 ? (
            <p>No class recipes yet. Share a Cook-Along to start the cookbook.</p>
          ) : (
            data.recipes.map((recipe) => (
              <section key={recipe.id} className="cookbook-recipe">
                <h2>{recipe.title}</h2>
                {recipe.description && <p>{recipe.description}</p>}
                <p className="cookbook-meta">
                  {recipe.prepTimeMinutes} min
                  {recipe.baseServings ? ` · serves ${recipe.baseServings}` : ""}
                  {recipe.allergenTags.length ? ` · ${recipe.allergenTags.join(", ")}` : ""}
                </p>
                <div className="cookbook-columns">
                  <div>
                    <h3>Ingredients</h3>
                    <ul>
                      {recipe.ingredients.map((item, index) => (
                        <li key={index}>
                          {[item.amount, item.unit, item.name].filter(Boolean).join(" ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3>Steps</h3>
                    <ol>
                      {recipe.steps.map((step, index) => (
                        <li key={index}>{step}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              </section>
            ))
          )}
        </article>
      )}
    </div>
  );
}

/* ---------------- Families ---------------- */

function FamiliesTab({
  classId,
  token,
  isAdmin,
  members,
  requests,
  children,
  onChanged,
  onError,
}: {
  classId: string;
  token: string | null;
  isAdmin: boolean;
  members: ClassMember[];
  requests: JoinRequest[];
  children: Child[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [newChild, setNewChild] = useState("");
  const [busyChild, setBusyChild] = useState(false);

  async function addChild() {
    const name = newChild.trim();
    if (!name) return;
    setBusyChild(true);
    try {
      await apiFetch(`/api/classes/${classId}/children`, {
        method: "POST",
        token,
        body: JSON.stringify({ displayName: name }),
      });
      setNewChild("");
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't add that child.");
    } finally {
      setBusyChild(false);
    }
  }

  async function removeChild(child: Child) {
    if (
      !window.confirm(
        `Remove ${child.displayName}? Their name and any gallery posts for this child will be removed from the class.`,
      )
    ) {
      return;
    }
    setBusyChild(true);
    try {
      await apiFetch(`/api/classes/${classId}/children/${child.id}`, { method: "DELETE", token });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't remove that child.");
    } finally {
      setBusyChild(false);
    }
  }

  async function decide(memberId: string, decision: "approve" | "decline") {
    let message = "";
    if (decision === "decline") {
      message = window.prompt("Optional message to the family:") ?? "";
    }
    try {
      await apiFetch(`/api/classes/${classId}/requests/${memberId}`, {
        method: "POST",
        token,
        body: JSON.stringify({ decision, message }),
      });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't update that request.");
    }
  }

  async function approveAll() {
    if (!window.confirm(`Approve all ${requests.length} requests to join?`)) return;
    try {
      await apiFetch(`/api/classes/${classId}/requests/approve-all`, { method: "POST", token });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't approve those requests.");
    }
  }

  async function remove(member: ClassMember) {
    if (!window.confirm(`Remove ${member.displayName || member.email} from the class?`)) return;
    try {
      await apiFetch(`/api/classes/${classId}/members/${member.id}`, { method: "DELETE", token });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't remove that member.");
    }
  }

  async function makeAdmin(member: ClassMember) {
    try {
      await apiFetch(`/api/classes/${classId}/members/${member.id}/admin`, { method: "POST", token });
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't make that member an admin.");
    }
  }

  return (
    <>
      <section className="feature-card">
        <h2>Your children in this class</h2>
        <p className="helper">
          Add a first name or nickname. Other families in this class can see it; public pages never do.
        </p>
        {children.length === 0 ? (
          <p className="helper">No children added yet.</p>
        ) : (
          <div className="child-list">
            {children.map((child) => (
              <div key={child.id} className="child-row">
                <span>{child.displayName}</span>
                <button
                  type="button"
                  className="link-btn danger"
                  disabled={busyChild}
                  onClick={() => void removeChild(child)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {children.length < 5 && (
          <div className="child-add">
            <input
              value={newChild}
              maxLength={60}
              autoComplete="off"
              placeholder="Child's first name or nickname"
              onChange={(event) => setNewChild(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addChild();
                }
              }}
            />
            <button type="button" className="secondary-btn" disabled={busyChild || !newChild.trim()} onClick={() => void addChild()}>
              Add
            </button>
          </div>
        )}
      </section>

      {isAdmin && requests.length > 0 && (
        <section className="feature-card">
          <div className="feature-card-head">
            <h2>Requests to join</h2>
            {requests.length > 1 && (
              <button type="button" className="link-btn" onClick={() => void approveAll()}>
                Approve all
              </button>
            )}
          </div>
          {requests.map((request) => (
            <div key={request.id} className="request-row">
              <div>
                <p className="request-name">{request.displayName || request.email}</p>
                <p className="helper">
                  {request.children.map((child) => child.displayName).join(", ") || "No child listed"}
                </p>
              </div>
              <div className="request-actions">
                <button type="button" className="primary-btn small" onClick={() => void decide(request.id, "approve")}>
                  Approve
                </button>
                <button type="button" className="secondary-btn small" onClick={() => void decide(request.id, "decline")}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="group">
        {members.map((member) => (
          <div key={member.id} className="member-row">
            <span className="class-row-text">
              <span className="class-row-title">
                {member.displayName || member.email}
                {member.role === "admin" && <span className="role-tag">Admin</span>}
              </span>
              <span className="class-row-sub">
                {member.children.map((child) => child.displayName).join(", ") || "No child listed"}
              </span>
            </span>
            {isAdmin && member.role !== "admin" && (
              <span className="member-actions">
                <button type="button" className="link-btn" onClick={() => void makeAdmin(member)}>
                  Make admin
                </button>
                <button type="button" className="link-btn danger" onClick={() => void remove(member)}>
                  Remove
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- Settings ---------------- */

function SettingsTab({
  current,
  token,
  onChanged,
  onLeft,
  onError,
}: {
  current: ClassSummary;
  token: string | null;
  onChanged: () => Promise<void>;
  onLeft: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(current.name);
  const [description, setDescription] = useState(current.description);
  const [joinMode, setJoinMode] = useState(current.joinMode);
  const [joinCodeActive, setJoinCodeActive] = useState(current.joinCodeActive);
  const [joinCode, setJoinCode] = useState(current.joinCode ?? "");
  const [busy, setBusy] = useState(false);

  async function patch(changes: Record<string, unknown>) {
    setBusy(true);
    try {
      const data = await apiFetch<{ class: ClassSummary }>(`/api/classes/${current.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify(changes),
      });
      if (data.class.joinCode) setJoinCode(data.class.joinCode);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't save those settings.");
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (!window.confirm("Generate a new code? The old code will stop working.")) return;
    setBusy(true);
    try {
      const data = await apiFetch<{ class: ClassSummary }>(`/api/classes/${current.id}/regenerate-code`, {
        method: "POST",
        token,
      });
      if (data.class.joinCode) setJoinCode(data.class.joinCode);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't regenerate the code.");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!window.confirm("Leave this class? Your child's posts will be hidden from the class.")) return;
    try {
      await apiFetch(`/api/classes/${current.id}/leave`, { method: "POST", token });
      onLeft();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Couldn't leave the class.");
    }
  }

  const joinLink = `${window.location.origin}/join/${joinCode}`;

  return (
    <>
      <section className="feature-card">
        <h2>Class details</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={description} maxLength={300} rows={3} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <button
          type="button"
          className="secondary-btn"
          disabled={busy}
          onClick={() => void patch({ name, description })}
        >
          Save details
        </button>
      </section>

      <section className="feature-card">
        <h2>Joining</h2>
        <label className="radio-row">
          <input
            type="radio"
            name="joinModeSettings"
            checked={joinMode === "approve"}
            onChange={() => {
              setJoinMode("approve");
              void patch({ joinMode: "approve" });
            }}
          />
          <span>
            <strong>Review each request</strong>
            <span className="helper">Approve families before they see the class.</span>
          </span>
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name="joinModeSettings"
            checked={joinMode === "open"}
            onChange={() => {
              setJoinMode("open");
              void patch({ joinMode: "open" });
            }}
          />
          <span>
            <strong>Anyone with the code</strong>
            <span className="helper">Families join instantly with the code.</span>
          </span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={joinCodeActive}
            onChange={(event) => {
              setJoinCodeActive(event.target.checked);
              void patch({ joinCodeActive: event.target.checked });
            }}
          />
          <span>Accept new families</span>
        </label>

        {joinCode && (
          <div className="join-code-box">
            <p className="helper">Class code</p>
            <p className="join-code">{joinCode}</p>
            <div className="qr-and-links">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(joinLink)}`}
                alt="QR code for the class join link"
                width={160}
                height={160}
              />
              <div className="stack">
                <button
                  type="button"
                  className="secondary-btn small"
                  onClick={() => void navigator.clipboard?.writeText(joinLink)}
                >
                  Copy join link
                </button>
                <button type="button" className="secondary-btn small" onClick={() => void regenerate()} disabled={busy}>
                  Generate new code
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="feature-card danger-zone">
        <h2>Class archive</h2>
        <p className="helper">Archiving keeps the gallery and cookbook but stops new Cook-Alongs.</p>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => void patch({ archived: !current.archived })}
          disabled={busy}
        >
          {current.archived ? "Unarchive class" : "Archive class"}
        </button>
        <button type="button" className="link-btn danger" onClick={() => void leave()}>
          Leave class
        </button>
      </section>
    </>
  );
}
