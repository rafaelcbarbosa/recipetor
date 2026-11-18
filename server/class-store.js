import { randomBytes, randomUUID } from "node:crypto";

const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 8;
const MAX_CHILDREN_PER_REQUEST = 5;
const MAX_CHILD_NAME = 60;

function nowIso() {
  return new Date().toISOString();
}

function generateJoinCode() {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let code = "";
  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    code += JOIN_ALPHABET[bytes[index] % JOIN_ALPHABET.length];
  }
  return code;
}

export function normalizeJoinCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

export function displayJoinCode(code) {
  const normalized = normalizeJoinCode(code);
  if (normalized.length === JOIN_CODE_LENGTH) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  }
  return normalized;
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailShell(title, body) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #29251f;">${escapeHtml(title)}</h2>
      ${body}
      <hr style="border: none; border-top: 1px solid #ece7df; margin: 20px 0;">
      <p style="color: #6b635a; font-size: 12px;">Recipetor</p>
    </div>
  `;
}

export function initClassSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      join_code TEXT NOT NULL UNIQUE,
      join_mode TEXT NOT NULL DEFAULT 'approve',
      join_code_active INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS classes_join_code_idx ON classes(join_code);
    CREATE INDEX IF NOT EXISTS classes_created_by_idx ON classes(created_by);

    CREATE TABLE IF NOT EXISTS class_members (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'parent',
      status TEXT NOT NULL DEFAULT 'pending',
      decline_message TEXT,
      decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (class_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS class_members_user_idx ON class_members(user_id);
    CREATE INDEX IF NOT EXISTS class_members_class_idx ON class_members(class_id);
    CREATE INDEX IF NOT EXISTS class_members_status_idx ON class_members(status);

    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES class_members(id) ON DELETE CASCADE,
      parent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS children_member_idx ON children(member_id);
    CREATE INDEX IF NOT EXISTS children_class_idx ON children(class_id);

    CREATE TABLE IF NOT EXISTS cook_alongs (
      id TEXT PRIMARY KEY,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cook_alongs_class_idx ON cook_alongs(class_id);
    CREATE INDEX IF NOT EXISTS cook_alongs_status_idx ON cook_alongs(status);

    CREATE TABLE IF NOT EXISTS class_posts (
      id TEXT PRIMARY KEY,
      cook_along_id TEXT NOT NULL REFERENCES cook_alongs(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      child_id TEXT NOT NULL REFERENCES children(id) ON DELETE CASCADE,
      parent_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      photo_url TEXT,
      note TEXT NOT NULL DEFAULT '',
      hidden INTEGER NOT NULL DEFAULT 0,
      hidden_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      hidden_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (cook_along_id, child_id)
    );
    CREATE INDEX IF NOT EXISTS class_posts_class_idx ON class_posts(class_id);
    CREATE INDEX IF NOT EXISTS class_posts_cook_along_idx ON class_posts(cook_along_id);
    CREATE INDEX IF NOT EXISTS class_posts_recipe_idx ON class_posts(recipe_id);
    CREATE INDEX IF NOT EXISTS class_posts_parent_idx ON class_posts(parent_id);

    CREATE TABLE IF NOT EXISTS recipe_classes (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (recipe_id, class_id)
    );
    CREATE INDEX IF NOT EXISTS recipe_classes_class_idx ON recipe_classes(class_id);

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
      reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status);
    CREATE INDEX IF NOT EXISTS reports_recipe_idx ON reports(recipe_id);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
      member_id TEXT REFERENCES class_members(id) ON DELETE CASCADE,
      payload_json TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
    CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id, read_at);
  `);

  // Older installs may have created a simplified class_members table. Keep the
  // additive migrations here so deployments never fail on startup.
  const memberColumns = new Set(
    db.prepare("PRAGMA table_info(class_members)").all().map((column) => column.name),
  );
  const memberMigrations = [
    ["role", "ALTER TABLE class_members ADD COLUMN role TEXT NOT NULL DEFAULT 'parent'"],
    ["status", "ALTER TABLE class_members ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"],
    ["decline_message", "ALTER TABLE class_members ADD COLUMN decline_message TEXT"],
    ["decided_by", "ALTER TABLE class_members ADD COLUMN decided_by TEXT"],
    ["decided_at", "ALTER TABLE class_members ADD COLUMN decided_at TEXT"],
    ["updated_at", "ALTER TABLE class_members ADD COLUMN updated_at TEXT"],
  ];
  for (const [column, statement] of memberMigrations) {
    if (memberColumns.has(column)) continue;
    db.exec(statement);
    memberColumns.add(column);
  }
}

export function createClassStore(
  db,
  {
    sendEmail = async () => false,
    origin = "https://recipetor.barbtech.com",
    canViewRecipe = () => false,
    getRecipe = () => null,
    generateCode = generateJoinCode,
    now = nowIso,
  } = {},
) {
  function uniqueJoinCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = generateCode();
      const existing = db.prepare("SELECT 1 FROM classes WHERE join_code = ?").get(code);
      if (!existing) return code;
    }
    throw new Error("Could not generate a unique join code.");
  }

  function classById(id) {
    return db.prepare("SELECT * FROM classes WHERE id = ?").get(id) ?? null;
  }

  function membershipFor(classId, userId) {
    if (!userId) return null;
    return (
      db.prepare("SELECT * FROM class_members WHERE class_id = ? AND user_id = ?").get(classId, userId) ??
      null
    );
  }

  function approvedMembershipFor(classId, userId) {
    const member = membershipFor(classId, userId);
    return member && member.status === "approved" ? member : null;
  }

  function isClassAdmin(classId, userId) {
    const member = approvedMembershipFor(classId, userId);
    return Boolean(member && member.role === "admin");
  }

  function memberFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      classId: row.class_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      declineMessage: row.decline_message ?? null,
      decidedBy: row.decided_by ?? null,
      decidedAt: row.decided_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function childrenForMember(memberId) {
    return db
      .prepare("SELECT id, display_name, created_at FROM children WHERE member_id = ? ORDER BY created_at ASC")
      .all(memberId)
      .map((row) => ({ id: row.id, displayName: row.display_name, createdAt: row.created_at }));
  }

  function classSummary(row, member) {
    const pendingApprovals = db
      .prepare("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND status = 'pending'")
      .get(row.id).n;
    const memberCount = db
      .prepare("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND status = 'approved'")
      .get(row.id).n;
    const cookAlongCount = db
      .prepare("SELECT COUNT(*) AS n FROM cook_alongs WHERE class_id = ? AND status = 'open'")
      .get(row.id).n;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      joinMode: row.join_mode,
      joinCodeActive: Boolean(row.join_code_active),
      archived: Boolean(row.archived),
      accepting:
        Boolean(row.join_code_active) &&
        !row.archived &&
        (row.join_mode === "open" || row.join_mode === "approve"),
      role: member?.role ?? null,
      status: member?.status ?? null,
      pendingApprovals: member?.role === "admin" ? pendingApprovals : 0,
      memberCount,
      openCookAlongs: cookAlongCount,
      createdAt: row.created_at,
    };
  }

  function getClassForUser(classId, userId) {
    const row = classById(classId);
    if (!row) return null;
    const member = membershipFor(classId, userId);
    if (!member) return null;
    const summary = classSummary(row, member);
    if (member.role === "admin") {
      summary.joinCode = row.join_code;
      summary.joinLink = `${origin.replace(/\/$/, "")}/join/${row.join_code}`;
    }
    summary.children = childrenForMember(member.id);
    summary.declineMessage = member.decline_message ?? null;
    return summary;
  }

  function listClasses(userId) {
    if (!userId) return [];
    const rows = db
      .prepare(
        `SELECT c.* FROM classes c
         JOIN class_members m ON m.class_id = c.id
         WHERE m.user_id = ? AND m.status IN ('approved', 'pending')
         ORDER BY c.archived ASC, c.updated_at DESC`,
      )
      .all(userId);
    return rows.map((row) => classSummary(row, membershipFor(row.id, userId)));
  }

  function lookupClass(code) {
    const normalized = normalizeJoinCode(code);
    if (!normalized) return null;
    const row = db.prepare("SELECT * FROM classes WHERE join_code = ?").get(normalized);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      joinMode: row.join_mode,
      accepting: Boolean(row.join_code_active) && !row.archived,
      archived: Boolean(row.archived),
    };
  }

  function createClass(userId, { name, description = "", joinMode = "approve" } = {}) {
    const cleanName = cleanText(name, 80);
    if (!cleanName) return { error: "INVALID_NAME" };
    const mode = joinMode === "open" ? "open" : "approve";
    const timestamp = now();
    const id = randomUUID();
    const joinCode = uniqueJoinCode();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO classes (id, name, description, join_code, join_mode, join_code_active, archived, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      ).run(id, cleanName, cleanText(description, 300), joinCode, mode, userId, timestamp, timestamp);
      db.prepare(
        `INSERT INTO class_members (id, class_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', 'approved', ?, ?)`,
      ).run(randomUUID(), id, userId, timestamp, timestamp);
      db.prepare(
        `INSERT INTO notifications (id, user_id, type, class_id, payload_json, created_at)
         VALUES (?, ?, 'class_created', ?, ?, ?)`,
      ).run(randomUUID(), userId, id, JSON.stringify({ className: cleanName }), timestamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { class: getClassForUser(id, userId) };
  }

  function notifyClassAdmins(classId, type, payload, subject, body) {
    const admins = db
      .prepare(
        `SELECT u.id, u.email FROM class_members m JOIN users u ON u.id = m.user_id
         WHERE m.class_id = ? AND m.role = 'admin' AND m.status = 'approved'`,
      )
      .all(classId);
    const timestamp = now();
    const insert = db.prepare(
      "INSERT INTO notifications (id, user_id, type, class_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const admin of admins) {
      insert.run(randomUUID(), admin.id, type, classId, JSON.stringify(payload), timestamp);
      void sendEmail(admin.email, subject, emailShell(subject, body)).catch(() => false);
    }
    return admins;
  }

  function notifyUser(userId, type, classId, payload, subject, body) {
    const user = db.prepare("SELECT email FROM users WHERE id = ?").get(userId);
    db.prepare(
      "INSERT INTO notifications (id, user_id, type, class_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), userId, type, classId, JSON.stringify(payload), now());
    if (user?.email) {
      void sendEmail(user.email, subject, emailShell(subject, body)).catch(() => false);
    }
  }

  function addChildren(member, names) {
    const existing = childrenForMember(member.id);
    const existingNames = new Set(existing.map((child) => child.displayName.toLowerCase()));
    const timestamp = now();
    const insert = db.prepare(
      "INSERT INTO children (id, class_id, member_id, parent_id, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const rawName of names) {
      const name = cleanText(rawName, MAX_CHILD_NAME);
      if (!name || existingNames.has(name.toLowerCase())) continue;
      insert.run(randomUUID(), member.class_id, member.id, member.user_id, name, timestamp);
      existingNames.add(name.toLowerCase());
    }
  }

  function joinClass(userId, code, childNames = []) {
    const row = db.prepare("SELECT * FROM classes WHERE join_code = ?").get(normalizeJoinCode(code));
    if (!row) return { error: "NOT_FOUND" };
    if (row.archived) return { error: "ARCHIVED" };
    if (!row.join_code_active) return { error: "CLOSED" };

    const names = (Array.isArray(childNames) ? childNames : [])
      .map((name) => cleanText(name, MAX_CHILD_NAME))
      .filter(Boolean)
      .slice(0, MAX_CHILDREN_PER_REQUEST);
    if (names.length === 0) return { error: "CHILD_REQUIRED" };

    const className = row.name;
    let member = membershipFor(row.id, userId);
    const timestamp = now();
    if (member && member.status === "approved") {
      return { error: "ALREADY_MEMBER", class: getClassForUser(row.id, userId) };
    }
    if (member && member.status === "pending") {
      addChildren(member, names);
      return {
        member: memberFromRow(member),
        class: getClassForUser(row.id, userId),
        pending: true,
      };
    }

    const status = row.join_mode === "open" ? "approved" : "pending";
    db.exec("BEGIN IMMEDIATE");
    try {
      if (member) {
        db.prepare(
          `UPDATE class_members SET status = ?, decline_message = NULL, decided_by = NULL, decided_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(status, timestamp, member.id);
        member = { ...member, status, decline_message: null, decided_by: null, decided_at: null, updated_at: timestamp };
      } else {
        const memberId = randomUUID();
        db.prepare(
          `INSERT INTO class_members (id, class_id, user_id, role, status, created_at, updated_at)
           VALUES (?, ?, ?, 'parent', ?, ?, ?)`,
        ).run(memberId, row.id, userId, status, timestamp, timestamp);
        member = db.prepare("SELECT * FROM class_members WHERE id = ?").get(memberId);
      }
      addChildren(member, names);
      db.prepare("UPDATE classes SET updated_at = ? WHERE id = ?").run(timestamp, row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    if (status === "pending") {
      const parent = db.prepare("SELECT display_name, email FROM users WHERE id = ?").get(userId);
      const parentName = parent?.display_name || parent?.email || "A parent";
      const childList = names.map((name) => `<li>${escapeHtml(name)}</li>`).join("");
      notifyClassAdmins(
        row.id,
        "join_request",
        { memberId: member.id, parentName, childNames: names },
        `New request to join ${className}`,
        `<p><strong>${escapeHtml(parentName)}</strong> asked to join <strong>${escapeHtml(className)}</strong>.</p>
         <p>Children:</p><ul>${childList}</ul>
         <p><a href="${origin.replace(/\/$/, "")}/classes/${row.id}/approvals">Review the request</a></p>`,
      );
    } else {
      notifyClassAdmins(
        row.id,
        "member_joined",
        { memberId: member.id },
        `A family joined ${className}`,
        `<p>A family joined <strong>${escapeHtml(className)}</strong>.</p>`,
      );
    }

    return { member: memberFromRow(member), class: getClassForUser(row.id, userId), pending: status === "pending" };
  }

  function listJoinRequests(classId) {
    return db
      .prepare(
        `SELECT m.*, u.email, u.display_name
         FROM class_members m JOIN users u ON u.id = m.user_id
         WHERE m.class_id = ? AND m.status = 'pending'
         ORDER BY m.created_at ASC`,
      )
      .all(classId)
      .map((row) => ({
        ...memberFromRow(row),
        email: row.email,
        displayName: row.display_name ?? null,
        children: childrenForMember(row.id),
      }));
  }

  function decideJoinRequest(classId, memberId, actorId, decision, message = "") {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    if (actorId === memberId) return { error: "SELF" };
    const member = db.prepare("SELECT * FROM class_members WHERE id = ? AND class_id = ?").get(memberId, classId);
    if (!member) return { error: "NOT_FOUND" };
    if (member.user_id === actorId) return { error: "SELF" };
    if (member.status !== "pending") return { error: "NOT_PENDING" };
    const status = decision === "decline" ? "declined" : "approved";
    const timestamp = now();
    db.prepare(
      `UPDATE class_members SET status = ?, decline_message = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?`,
    ).run(status, status === "declined" ? cleanText(message, 300) || null : null, actorId, timestamp, timestamp, memberId);
    db.prepare("UPDATE classes SET updated_at = ? WHERE id = ?").run(timestamp, classId);
    const className = classById(classId)?.name ?? "your class";
    if (status === "approved") {
      notifyUser(
        member.user_id,
        "join_approved",
        classId,
        { memberId },
        `You are approved to join ${className}`,
        `<p>Your request to join <strong>${escapeHtml(className)}</strong> was approved.</p>
         <p><a href="${origin.replace(/\/$/, "")}/classes/${classId}">Go to the class</a></p>`,
      );
    } else {
      notifyUser(
        member.user_id,
        "join_declined",
        classId,
        { memberId, message: cleanText(message, 300) },
        `Your request to join ${className}`,
        `<p>Your request to join <strong>${escapeHtml(className)}</strong> was declined.</p>
         ${message ? `<p>Message: ${escapeHtml(message)}</p>` : ""}`,
      );
    }
    return { member: memberFromRow(db.prepare("SELECT * FROM class_members WHERE id = ?").get(memberId)) };
  }

  function approveAll(classId, actorId) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const pending = db
      .prepare("SELECT id FROM class_members WHERE class_id = ? AND status = 'pending'")
      .all(classId);
    for (const member of pending) {
      decideJoinRequest(classId, member.id, actorId, "approve");
    }
    return { approved: pending.length };
  }

  function removeMember(classId, memberId, actorId) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const member = db.prepare("SELECT * FROM class_members WHERE id = ? AND class_id = ?").get(memberId, classId);
    if (!member) return { error: "NOT_FOUND" };
    if (member.role === "admin") {
      const admins = db
        .prepare("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'admin' AND status = 'approved'")
        .get(classId).n;
      if (admins <= 1) return { error: "LAST_ADMIN" };
    }
    const timestamp = now();
    db.prepare("UPDATE class_members SET status = 'removed', updated_at = ? WHERE id = ?").run(timestamp, memberId);
    db.prepare("UPDATE classes SET updated_at = ? WHERE id = ?").run(timestamp, classId);
    notifyUser(
      member.user_id,
      "member_removed",
      classId,
      { memberId },
      "You were removed from a class",
      `<p>You were removed from <strong>${escapeHtml(classById(classId)?.name ?? "a class")}</strong>.</p>`,
    );
    return { removed: true };
  }

  function cancelJoinRequest(classId, userId) {
    const member = membershipFor(classId, userId);
    if (!member || member.status !== "pending") return { error: "NOT_FOUND" };
    db.prepare("UPDATE class_members SET status = 'declined', updated_at = ? WHERE id = ?").run(now(), member.id);
    db.prepare("DELETE FROM children WHERE member_id = ?").run(member.id);
    return { cancelled: true };
  }

  function leaveClass(classId, userId) {
    const member = approvedMembershipFor(classId, userId);
    if (!member) return { error: "NOT_MEMBER" };
    if (member.role === "admin") {
      const admins = db
        .prepare("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'admin' AND status = 'approved'")
        .get(classId).n;
      if (admins <= 1) return { error: "LAST_ADMIN" };
    }
    db.prepare("UPDATE class_members SET status = 'removed', updated_at = ? WHERE id = ?").run(now(), member.id);
    return { left: true };
  }

  function addAdmin(classId, memberId, actorId) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const member = db.prepare("SELECT * FROM class_members WHERE id = ? AND class_id = ?").get(memberId, classId);
    if (!member) return { error: "NOT_FOUND" };
    if (member.status !== "approved") return { error: "NOT_APPROVED" };
    db.prepare("UPDATE class_members SET role = 'admin', updated_at = ? WHERE id = ?").run(now(), memberId);
    notifyUser(
      member.user_id,
      "admin_added",
      classId,
      { memberId },
      "You are now a class admin",
      `<p>You are now an admin of <strong>${escapeHtml(classById(classId)?.name ?? "a class")}</strong>.</p>`,
    );
    return { member: memberFromRow(db.prepare("SELECT * FROM class_members WHERE id = ?").get(memberId)) };
  }

  function listMembers(classId) {
    return db
      .prepare(
        `SELECT m.*, u.email, u.display_name
         FROM class_members m JOIN users u ON u.id = m.user_id
         WHERE m.class_id = ? AND m.status = 'approved'
         ORDER BY m.role DESC, m.created_at ASC`,
      )
      .all(classId)
      .map((row) => ({
        ...memberFromRow(row),
        email: row.email,
        displayName: row.display_name ?? null,
        children: childrenForMember(row.id),
      }));
  }

  function updateClass(classId, actorId, changes = {}) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const row = classById(classId);
    if (!row) return { error: "NOT_FOUND" };
    const fields = [];
    const values = [];
    if (changes.name !== undefined) {
      const name = cleanText(changes.name, 80);
      if (!name) return { error: "INVALID_NAME" };
      fields.push("name = ?");
      values.push(name);
    }
    if (changes.description !== undefined) {
      fields.push("description = ?");
      values.push(cleanText(changes.description, 300));
    }
    if (changes.joinMode !== undefined) {
      fields.push("join_mode = ?");
      values.push(changes.joinMode === "open" ? "open" : "approve");
    }
    if (changes.joinCodeActive !== undefined) {
      fields.push("join_code_active = ?");
      values.push(changes.joinCodeActive ? 1 : 0);
    }
    if (changes.archived !== undefined) {
      fields.push("archived = ?");
      values.push(changes.archived ? 1 : 0);
    }
    if (fields.length === 0) return { error: "NO_CHANGES" };
    fields.push("updated_at = ?");
    values.push(now(), classId);
    db.prepare(`UPDATE classes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return { class: getClassForUser(classId, actorId) };
  }

  function regenerateJoinCode(classId, actorId) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const joinCode = uniqueJoinCode();
    db.prepare("UPDATE classes SET join_code = ?, updated_at = ? WHERE id = ?").run(joinCode, now(), classId);
    return { class: getClassForUser(classId, actorId) };
  }

  function addChild(classId, userId, displayName) {
    const member = approvedMembershipFor(classId, userId);
    if (!member) return { error: "NOT_MEMBER" };
    const name = cleanText(displayName, MAX_CHILD_NAME);
    if (!name) return { error: "INVALID_NAME" };
    const count = db.prepare("SELECT COUNT(*) AS n FROM children WHERE member_id = ?").get(member.id).n;
    if (count >= MAX_CHILDREN_PER_REQUEST) return { error: "TOO_MANY" };
    db.prepare(
      "INSERT INTO children (id, class_id, member_id, parent_id, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(randomUUID(), classId, member.id, userId, name, now());
    return { children: childrenForMember(member.id) };
  }

  function deleteChild(classId, childId, userId) {
    const member = approvedMembershipFor(classId, userId);
    if (!member) return { error: "NOT_FOUND" };
    const child = db.prepare("SELECT * FROM children WHERE id = ? AND member_id = ?").get(childId, member.id);
    if (!child) return { error: "FORBIDDEN" };
    db.prepare("DELETE FROM children WHERE id = ?").run(childId);
    return { deleted: true };
  }

  function createCookAlong(classId, actorId, { title, prompt = "", dueDate = null } = {}) {
    if (!isClassAdmin(classId, actorId)) return { error: "FORBIDDEN" };
    const cleanTitle = cleanText(title, 120);
    if (!cleanTitle) return { error: "INVALID_TITLE" };
    const timestamp = now();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO cook_alongs (id, class_id, title, prompt, due_date, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(id, classId, cleanTitle, cleanText(prompt, 500), dueDate ? cleanText(dueDate, 20) : null, actorId, timestamp, timestamp);
    return { cookAlong: getCookAlong(id, actorId) };
  }

  function getCookAlong(cookAlongId, userId) {
    const row = db.prepare("SELECT * FROM cook_alongs WHERE id = ?").get(cookAlongId);
    if (!row) return null;
    if (!approvedMembershipFor(row.class_id, userId)) return null;
    return cookAlongFromRow(row, userId);
  }

  function cookAlongFromRow(row, userId) {
    const isAdmin = isClassAdmin(row.class_id, userId);
    const postCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM class_posts p
         JOIN class_members m ON m.user_id = p.parent_id AND m.class_id = p.class_id AND m.status = 'approved'
         WHERE p.cook_along_id = ? AND (? OR p.hidden = 0)`,
      )
      .get(row.id, isAdmin ? 1 : 0).n;
    return {
      id: row.id,
      classId: row.class_id,
      title: row.title,
      prompt: row.prompt,
      dueDate: row.due_date,
      status: row.status,
      postCount,
      isAdmin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listCookAlongs(classId, userId) {
    if (!approvedMembershipFor(classId, userId)) return null;
    const rows = db
      .prepare(
        `SELECT * FROM cook_alongs WHERE class_id = ?
         ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                  CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
                  due_date ASC, created_at DESC`,
      )
      .all(classId);
    return rows.map((row) => cookAlongFromRow(row, userId));
  }

  function updateCookAlong(cookAlongId, actorId, changes = {}) {
    const row = db.prepare("SELECT * FROM cook_alongs WHERE id = ?").get(cookAlongId);
    if (!row) return { error: "NOT_FOUND" };
    if (!isClassAdmin(row.class_id, actorId)) return { error: "FORBIDDEN" };
    const fields = [];
    const values = [];
    if (changes.title !== undefined) {
      const title = cleanText(changes.title, 120);
      if (!title) return { error: "INVALID_TITLE" };
      fields.push("title = ?");
      values.push(title);
    }
    if (changes.prompt !== undefined) {
      fields.push("prompt = ?");
      values.push(cleanText(changes.prompt, 500));
    }
    if (changes.dueDate !== undefined) {
      fields.push("due_date = ?");
      values.push(changes.dueDate ? cleanText(changes.dueDate, 20) : null);
    }
    if (changes.status !== undefined) {
      fields.push("status = ?");
      values.push(changes.status === "closed" ? "closed" : "open");
    }
    if (fields.length === 0) return { error: "NO_CHANGES" };
    fields.push("updated_at = ?");
    values.push(now(), cookAlongId);
    db.prepare(`UPDATE cook_alongs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return { cookAlong: getCookAlong(cookAlongId, actorId) };
  }

  function createPost(cookAlongId, userId, { childId, recipeId, note = "", visibility } = {}) {
    const cookAlong = db.prepare("SELECT * FROM cook_alongs WHERE id = ?").get(cookAlongId);
    if (!cookAlong) return { error: "NOT_FOUND" };
    const member = approvedMembershipFor(cookAlong.class_id, userId);
    if (!member) return { error: "FORBIDDEN" };
    if (cookAlong.status !== "open") return { error: "CLOSED" };
    const child = db.prepare("SELECT * FROM children WHERE id = ? AND member_id = ?").get(childId, member.id);
    if (!child) return { error: "INVALID_CHILD" };
    if (!canViewRecipe(recipeId, userId)) return { error: "INVALID_RECIPE" };
    const existing = db
      .prepare("SELECT id FROM class_posts WHERE cook_along_id = ? AND child_id = ?")
      .get(cookAlongId, childId);
    if (existing) return { error: "ALREADY_POSTED" };
    if (visibility === "public" && !canPublishRecipe(recipeId, userId)) return { error: "FORBIDDEN_VISIBILITY" };

    const recipe = getRecipe(recipeId, userId);
    if (!recipe) return { error: "INVALID_RECIPE" };
    const timestamp = now();
    const id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO class_posts (id, cook_along_id, class_id, recipe_id, child_id, parent_id, photo_url, note, hidden, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`,
      ).run(id, cookAlongId, cookAlong.class_id, recipeId, childId, userId, cleanText(note, 140), timestamp, timestamp);
      db.prepare(
        "INSERT OR IGNORE INTO recipe_classes (recipe_id, class_id, created_at) VALUES (?, ?, ?)",
      ).run(recipeId, cookAlong.class_id, timestamp);
      if (visibility !== "public" && recipe.visibility === "private") {
        db.prepare("UPDATE recipes SET visibility = 'class', updated_at = ? WHERE id = ?").run(timestamp, recipeId);
      }
      if (visibility === "public") {
        db.prepare("UPDATE recipes SET visibility = 'public', updated_at = ? WHERE id = ?").run(timestamp, recipeId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { post: getPost(id, userId) };
  }

  function canPublishRecipe(recipeId, userId) {
    const owner = db.prepare("SELECT user_id FROM recipes WHERE id = ?").get(recipeId);
    return Boolean(owner && owner.user_id === userId);
  }

  function getPost(postId, userId) {
    const row = db.prepare("SELECT * FROM class_posts WHERE id = ?").get(postId);
    if (!row) return null;
    if (!approvedMembershipFor(row.class_id, userId)) return null;
    return postFromRow(row, userId);
  }

  function postFromRow(row, userId) {
    const isAdmin = isClassAdmin(row.class_id, userId);
    if (row.hidden && !isAdmin) return null;
    const child = db.prepare("SELECT display_name FROM children WHERE id = ?").get(row.child_id);
    const recipe = db.prepare("SELECT title, image_url, visibility FROM recipes WHERE id = ?").get(row.recipe_id);
    return {
      id: row.id,
      cookAlongId: row.cook_along_id,
      classId: row.class_id,
      recipeId: row.recipe_id,
      recipeTitle: recipe?.title ?? "Recipe",
      recipeImageUrl: recipe?.image_url ?? null,
      recipeVisibility: recipe?.visibility ?? "private",
      childId: row.child_id,
      childName: child?.display_name ?? "A child",
      note: row.note,
      hidden: Boolean(row.hidden),
      photoUrl: row.photo_url,
      isMine: row.parent_id === userId,
      canDelete: row.parent_id === userId || isAdmin,
      canHide: isAdmin,
      createdAt: row.created_at,
    };
  }

  function listPosts(cookAlongId, userId) {
    const cookAlong = db.prepare("SELECT * FROM cook_alongs WHERE id = ?").get(cookAlongId);
    if (!cookAlong) return null;
    const member = approvedMembershipFor(cookAlong.class_id, userId);
    if (!member) return null;
    const isAdmin = member.role === "admin";
    const rows = db
      .prepare(
        `SELECT p.* FROM class_posts p
         JOIN class_members m ON m.user_id = p.parent_id AND m.class_id = p.class_id AND m.status = 'approved'
         WHERE p.cook_along_id = ? AND (? OR p.hidden = 0)
         ORDER BY p.created_at DESC`,
      )
      .all(cookAlongId, isAdmin ? 1 : 0);
    return rows.map((row) => postFromRow(row, userId)).filter(Boolean);
  }

  function setPostPhoto(postId, userId, filename) {
    const row = db.prepare("SELECT * FROM class_posts WHERE id = ?").get(postId);
    if (!row) return { error: "NOT_FOUND" };
    if (row.parent_id !== userId) return { error: "FORBIDDEN" };
    db.prepare("UPDATE class_posts SET photo_url = ?, updated_at = ? WHERE id = ?").run(filename, now(), postId);
    return { post: getPost(postId, userId) };
  }

  function hidePost(postId, userId, hidden = true) {
    const row = db.prepare("SELECT * FROM class_posts WHERE id = ?").get(postId);
    if (!row) return { error: "NOT_FOUND" };
    if (!isClassAdmin(row.class_id, userId)) return { error: "FORBIDDEN" };
    db.prepare("UPDATE class_posts SET hidden = ?, hidden_by = ?, hidden_at = ?, updated_at = ? WHERE id = ?").run(
      hidden ? 1 : 0,
      hidden ? userId : null,
      hidden ? now() : null,
      now(),
      postId,
    );
    return { post: getPost(postId, userId) };
  }

  function deletePost(postId, userId) {
    const row = db.prepare("SELECT * FROM class_posts WHERE id = ?").get(postId);
    if (!row) return { error: "NOT_FOUND" };
    if (row.parent_id !== userId && !isClassAdmin(row.class_id, userId)) return { error: "FORBIDDEN" };
    db.prepare("DELETE FROM class_posts WHERE id = ?").run(postId);
    return { deleted: true, photoFile: row.photo_url };
  }

  function getPostForPhoto(postId) {
    return db.prepare("SELECT * FROM class_posts WHERE id = ?").get(postId) ?? null;
  }

  function listPublicPhotosForRecipe(recipeId) {
    return db
      .prepare("SELECT photo_url FROM class_posts WHERE recipe_id = ? AND photo_url IS NOT NULL AND hidden = 0")
      .all(recipeId)
      .map((row) => row.photo_url);
  }

  function listNotifications(userId, limit = 50) {
    return db
      .prepare(
        `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit)
      .map((row) => ({
        id: row.id,
        type: row.type,
        classId: row.class_id,
        memberId: row.member_id,
        payload: parseJson(row.payload_json, {}),
        readAt: row.read_at,
        createdAt: row.created_at,
      }));
  }

  function unreadNotificationCount(userId) {
    return db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL")
      .get(userId).n;
  }

  function markNotificationsRead(userId, ids = null) {
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(
        `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${placeholders})`,
      ).run(now(), userId, ...ids);
    } else {
      db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now(), userId);
    }
    return { unread: unreadNotificationCount(userId) };
  }

  function getClassMembership(classId, userId) {
    return memberFromRow(membershipFor(classId, userId));
  }

  function classAdminIds(classId) {
    return db
      .prepare("SELECT user_id FROM class_members WHERE class_id = ? AND role = 'admin' AND status = 'approved'")
      .all(classId)
      .map((row) => row.user_id);
  }

  return {
    normalizeJoinCode,
    displayJoinCode,
    initClassSchema,
    createClass,
    listClasses,
    getClassForUser,
    lookupClass,
    joinClass,
    listJoinRequests,
    decideJoinRequest,
    approveAll,
    removeMember,
    cancelJoinRequest,
    leaveClass,
    addAdmin,
    listMembers,
    updateClass,
    regenerateJoinCode,
    addChild,
    deleteChild,
    createCookAlong,
    getCookAlong,
    listCookAlongs,
    updateCookAlong,
    createPost,
    listPosts,
    getPost,
    getPostForPhoto,
    setPostPhoto,
    hidePost,
    deletePost,
    listPublicPhotosForRecipe,
    listNotifications,
    unreadNotificationCount,
    markNotificationsRead,
    getClassMembership,
    classAdminIds,
    isClassAdmin,
    approvedMembershipFor,
  };
}
