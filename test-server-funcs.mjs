import { createHash } from 'node:crypto';

function base64UrlEncode(data) {
  return Buffer.from(data).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(data) {
  let base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  if (pad) base64 += "=".repeat(4 - pad);
  return Buffer.from(base64, "base64").toString("utf8");
}

const JWT_SECRET = process.env.RECIPETOR_JWT_SECRET;
console.log('JWT_SECRET:', JWT_SECRET?.slice(0, 8) + '...');

function signJwt(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = header + "." + body;
  const signature = createHash("sha256").update(signatureInput + "." + JWT_SECRET).digest();
  return signatureInput + "." + base64UrlEncode(signature);
}

function verifyJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const signatureInput = header + "." + body;
    const expectedSignature = createHash("sha256").update(signatureInput + "." + JWT_SECRET).digest();
    if (base64UrlEncode(expectedSignature) !== signature) return null;
    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const payload = { sub: 'test', email: 'test@test.com', exp: Date.now() + 86400000 };
const token = signJwt(payload);
console.log('Generated token:', token);

const verified = verifyJwt(token);
console.log('Verified:', verified);
