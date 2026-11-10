import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("./data/recipetor.sqlite");
const users = db.prepare("SELECT email, email_verified FROM users").all();
console.log(JSON.stringify(users, null, 2));