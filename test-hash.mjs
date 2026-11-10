import crypto from "node:crypto";
const hash = crypto.pbkdf2Sync("password123", "e42e380c7f6e43e245f0ba5023d6488b", 100000, 32, "sha256").toString("hex");
console.log("Computed:", hash);
console.log("Stored:", "f31bf3995a2001df9edcfdf5b1a9f388ea005e56627fffa8610112d6940bf65d");
console.log("Match:", hash === "f31bf3995a2001df9edcfdf5b1a9f388ea005e56627fffa8610112d6940bf65d");