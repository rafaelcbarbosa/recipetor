import { useEffect, useRef, useState } from "react";
import { apiFetch, type ClassSummary } from "../lib/api";
import { ErrorNote } from "./ui";

export function VisibilitySheet({
  recipeId,
  visibility,
  classIds,
  token,
  onClose,
  onSaved,
}: {
  recipeId: string;
  visibility: "private" | "class" | "public";
  classIds: string[];
  token: string | null;
  onClose: () => void;
  onSaved: (visibility: "private" | "class" | "public", classIds: string[]) => void;
}) {
  const [next, setNext] = useState(visibility);
  const [selected, setSelected] = useState<string[]>(classIds);
  const [classes, setClasses] = useState<ClassSummary[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<{ classes: ClassSummary[] }>("/api/classes", { token })
      .then((data) => setClasses(data.classes.filter((item) => item.status === "approved")))
      .catch(() => setClasses([]));
  }, [token]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/recipes/${recipeId}/visibility`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          visibility: next,
          classIds: next === "class" ? selected : [],
        }),
      });
      onSaved(next, next === "class" ? selected : []);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change visibility.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="visibility-title">
        <div className="sheet-head">
          <h2 id="visibility-title">Who can see this recipe?</h2>
          <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="helper">Only you can change this. Class admins can hide a post but cannot publish your recipe.</p>
        {(
          [
            ["private", "Private", "Only you."],
            ["class", "Class only", "Approved families in the classes you choose."],
            ["public", "Public", "Anyone, including people without an account. Your child's name and class are never shown."],
          ] as const
        ).map(([value, label, description]) => (
          <label key={value} className="radio-row">
            <input type="radio" name="visibility" checked={next === value} onChange={() => setNext(value)} />
            <span>
              <strong>{label}</strong>
              <span className="helper">{description}</span>
            </span>
          </label>
        ))}
        {next === "class" && (
          <div className="feature-card">
            <h3>Classes</h3>
            {classes.length === 0 && <p className="helper">Join a class first.</p>}
            {classes.map((item) => (
              <label key={item.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>{item.name}</span>
              </label>
            ))}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <button type="button" className="primary-btn" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </section>
    </div>
  );
}

export function CookModeOverlay({
  title,
  ingredients,
  steps,
  stepJobs = [],
  onClose,
}: {
  title: string;
  ingredients: Array<{ amount: number | null; unit: string; name: string }>;
  steps: string[];
  stepJobs?: string[];
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

  useEffect(() => {
    let active = true;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: string) => Promise<unknown> } };
    if (nav.wakeLock) {
      nav.wakeLock
        .request("screen")
        .then((lock) => {
          if (active) wakeLock.current = lock as { release: () => Promise<void> };
          else void (lock as { release: () => Promise<void> }).release();
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      void wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
    };
  }, []);

  return (
    <div className="cook-mode-overlay" role="dialog" aria-modal="true" aria-label="Cook mode">
      <div className="cook-mode-top">
        <p>{title}</p>
        <button type="button" className="round-btn" aria-label="Exit cook mode" onClick={onClose}>
          ✕
        </button>
      </div>
      <details className="cook-mode-ingredients">
        <summary>Ingredients</summary>
        <ul>
          {ingredients.map((item, index) => (
            <li key={index}>
              <label>
                <input
                  type="checkbox"
                  checked={checked.has(index)}
                  onChange={(event) =>
                    setChecked((current) => {
                      const copy = new Set(current);
                      if (event.target.checked) copy.add(index);
                      else copy.delete(index);
                      return copy;
                    })
                  }
                />
                <span>
                  {[item.amount, item.unit].filter(Boolean).join(" ")} {item.name}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </details>
      <div className="cook-mode-step">
        <p className="cook-step-count">
          Step {step + 1} of {steps.length}
        </p>
        <p className="cook-step-text">{steps[step]}</p>
        {stepJobs[step] && <p className="kid-job">Kid job: {stepJobs[step]}</p>}
      </div>
      <div className="cook-mode-controls">
        <button type="button" className="secondary-btn" disabled={step === 0} onClick={() => setStep((v) => v - 1)}>
          Back
        </button>
        {step < steps.length - 1 ? (
          <button type="button" className="primary-btn" onClick={() => setStep((v) => v + 1)}>
            Next step
          </button>
        ) : (
          <button type="button" className="primary-btn" onClick={onClose}>
            Finish
          </button>
        )}
      </div>
    </div>
  );
}
