import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const db = new DatabaseSync("./data/recipetor.sqlite");

// Same hashPassword as in recipe-store.js
function hashPassword(password, salt) {
  return createHash("sha256").update(salt + password).digest("hex");
}

const salt = "e42e380c7f6e43e245f0ba5023d6488b";  // Keep existing salt
const password_hash = hashPassword("password123", salt);

const stmt = db.prepare("UPDATE users SET password_hash = ? WHERE email = ?");
stmt.run(password_hash, "coxinha@gmail.com");

console.log("Password reset to: password123");
console.log("Hash:", password_hash);