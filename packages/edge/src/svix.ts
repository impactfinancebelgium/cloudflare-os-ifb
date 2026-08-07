// Minimal Svix webhook signature verification (what Resend signs with), on WebCrypto
// instead of the npm svix package: HMAC-SHA256 over `${id}.${timestamp}.${payload}`
// keyed with the base64 secret after the `whsec_` prefix, compared against every
// space-separated `v1,<base64>` candidate in the svix-signature header.

const TOLERANCE_SECONDS = 5 * 60;

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64encode(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

export async function verifySvix(
  secret: string,
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    b64decode(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${payload}`),
  );
  const expected = b64encode(signed);
  return headers.signature
    .split(" ")
    .some((candidate) => {
      const [version, sig] = candidate.split(",");
      return version === "v1" && !!sig && timingSafeEqual(sig, expected);
    });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
