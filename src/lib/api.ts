export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const { token, headers, ...rest } = options;
  const response = await fetch(path, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Something went wrong. Try again.";
    throw new Error(message);
  }
  return body as T;
}

export async function uploadImage(
  path: string,
  file: Blob,
  token: string | null,
  contentType = "image/jpeg",
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Couldn't upload that photo.";
    throw new Error(message);
  }
  return body;
}

export type Child = { id: string; displayName: string; createdAt: string };

export type ClassSummary = {
  id: string;
  name: string;
  description: string;
  joinMode: "approve" | "open";
  joinCodeActive: boolean;
  accepting: boolean;
  archived: boolean;
  role: "admin" | "parent" | null;
  status: "pending" | "approved" | "declined" | "removed" | null;
  pendingApprovals: number;
  memberCount: number;
  openCookAlongs: number;
  createdAt: string;
  joinCode?: string;
  joinLink?: string;
  children?: Child[];
  declineMessage?: string | null;
};

export type ClassMember = {
  id: string;
  userId: string;
  role: "admin" | "parent";
  status: string;
  email: string;
  displayName: string | null;
  children: Child[];
  createdAt: string;
};

export type JoinRequest = ClassMember & { declineMessage: string | null };

export type CookAlong = {
  id: string;
  classId: string;
  title: string;
  prompt: string;
  dueDate: string | null;
  status: "open" | "closed";
  postCount: number;
  isAdmin: boolean;
  createdAt: string;
};

export type ClassPost = {
  id: string;
  cookAlongId: string;
  classId: string;
  recipeId: string;
  recipeTitle: string;
  recipeImageUrl: string | null;
  recipeVisibility: "private" | "class" | "public";
  childId: string;
  childName: string;
  note: string;
  hidden: boolean;
  photoUrl: string | null;
  isMine: boolean;
  canDelete: boolean;
  canHide: boolean;
  createdAt: string;
  cookAlongTitle?: string;
};

export type PublicRecipe = {
  id: string;
  title: string;
  description: string;
  category: string;
  cuisine: string;
  mealTypes: string[];
  dietTags: string[];
  allergenTags: string[];
  prepTimeMinutes: number;
  baseServings: number | null;
  imageUrl: string | null;
  ingredients: Array<{ amount: number | null; unit: string; name: string; nutrition?: unknown }>;
  steps: string[];
  nutritionPerPortion: unknown;
  ratingAvg: number;
  ratingCount: number;
  sourceUrl: string | null;
  sourceCredit: string | null;
  sharedBy: string;
  createdAt: string;
  updatedAt: string;
  isFavorite?: boolean;
};

export type Notification = {
  id: string;
  type: string;
  classId: string | null;
  memberId: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};
