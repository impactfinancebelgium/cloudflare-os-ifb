/**
 * Signed invite tokens: the only credential members (and their agents) hold.
 *
 * Shape: base64url(payload) + "." + base64url(HMAC-SHA256(payload, SURVEY_TOKEN_SECRET))
 * Payload: { o: orgId, r: roundId, e: expiresEpochSeconds }
 *
 * Security properties relied on elsewhere:
 *  - The organisation id is read ONLY from a verified token, never from a request body.
 *  - sha256(token) must match survey_invite.token_hash, so an invite can be revoked and a
 *    signed-but-unknown token is refused.
 */

export interface TokenClaims {
  o: string; // org id
  r: string; // round id
  e: number; // expiry, epoch seconds
}

const enc = new TextEncoder();

const b64u = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const b64uDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const raw = atob(s.replaceAll("-", "+").replaceAll("_", "/") + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export async function mintToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = enc.encode(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), payload);
  return `${b64u(payload.buffer as ArrayBuffer)}.${b64u(sig)}`;
}

/** Verify signature + expiry. Returns claims or null; never throws on bad input. */
export async function verifyToken(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const [p, s] = token.split(".");
    if (!p || !s) return null;
    const payload = b64uDecode(p);
    const ok = await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), b64uDecode(s) as unknown as ArrayBuffer,
      payload as unknown as ArrayBuffer,
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(payload)) as TokenClaims;
    if (typeof claims.o !== "string" || typeof claims.r !== "string") return null;
    if (typeof claims.e !== "number" || claims.e * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
