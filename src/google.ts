type ServiceAccountJSON = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

type GoogleTokenCache = { token: string; expMs: number };

let tokenCache: GoogleTokenCache | null = null;

const GOOGLE_TOKEN_AUD = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

function b64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseServiceAccount(jsonStr: string): ServiceAccountJSON {
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (!parsed?.client_email || !parsed?.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key");
  }
  return parsed as ServiceAccountJSON;
}

function pemToPkcs8Der(pem: string): ArrayBuffer {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(cleaned);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = pemToPkcs8Der(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signJwt(sa: ServiceAccountJSON, scope: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope,
    aud: sa.token_uri || GOOGLE_TOKEN_AUD,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(toSign)
  );
  return `${toSign}.${b64url(new Uint8Array(sig))}`;
}

export type GoogleEnv = {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
};

export async function getGoogleAccessToken(env: GoogleEnv): Promise<string> {
  const jsonStr = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!jsonStr) throw new Error("Google Sheets not configured: GOOGLE_SERVICE_ACCOUNT_JSON is missing");

  // cache for the current worker instance
  const now = Date.now();
  if (tokenCache && tokenCache.expMs - 30_000 > now) {
    return tokenCache.token;
  }

  const sa = parseServiceAccount(jsonStr);
  const scope = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
  ].join(" ");

  const assertion = await signJwt(sa, scope);

  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Google token error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expMs: now + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

async function gfetch(token: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(url, { ...init, headers });
}

export type SpreadsheetInfo = {
  spreadsheetId: string;
  url: string;
};

export async function createAndShareSpreadsheet(
  env: GoogleEnv,
  title: string,
  shareToEmail: string
): Promise<SpreadsheetInfo> {
  const token = await getGoogleAccessToken(env);

  // 1) create spreadsheet
  const createRes = await gfetch(token, `${SHEETS_API}/spreadsheets`, {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: "Responses" } }],
    }),
  });

  if (!createRes.ok) throw new Error(`Sheets create error: ${createRes.status} ${await createRes.text()}`);
  const created = (await createRes.json()) as { spreadsheetId: string };

  const spreadsheetId = created.spreadsheetId;
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // 2) write header row
  const header = [["Response date", "Company", "Vacancy title", "Status", "Role", "Grade"]];
  const headerRes = await gfetch(token, `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/Responses!A1:F1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: header }),
  });
  if (!headerRes.ok) {
    throw new Error(`Sheets header error: ${headerRes.status} ${await headerRes.text()}`);
  }

  // 3) share via Drive permissions
  const permRes = await gfetch(token, `${DRIVE_API}/files/${spreadsheetId}/permissions?sendNotificationEmail=false`, {
    method: "POST",
    body: JSON.stringify({
      role: "writer",
      type: "user",
      emailAddress: shareToEmail,
    }),
  });
  if (!permRes.ok) throw new Error(`Drive share error: ${permRes.status} ${await permRes.text()}`);

  return { spreadsheetId, url };
}

export async function appendRows(
  env: GoogleEnv,
  spreadsheetId: string,
  rows: (string | number | null)[][]
): Promise<void> {
  if (!rows.length) return;
  const token = await getGoogleAccessToken(env);

  const res = await gfetch(
    token,
    `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/Responses!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ values: rows }),
    }
  );
  if (!res.ok) throw new Error(`Sheets append error: ${res.status} ${await res.text()}`);
}

export async function clearAndWriteAll(
  env: GoogleEnv,
  spreadsheetId: string,
  rows: (string | number | null)[][]
): Promise<void> {
  const token = await getGoogleAccessToken(env);

  // Clear existing content
  const clearRes = await gfetch(token, `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/Responses!A:Z:clear`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!clearRes.ok) throw new Error(`Sheets clear error: ${clearRes.status} ${await clearRes.text()}`);

  // Re-write header + rows
  const values = [
    ["Response date", "Company", "Vacancy title", "Status", "Role", "Grade"],
    ...rows,
  ];

  const writeRes = await gfetch(
    token,
    `${SHEETS_API}/spreadsheets/${spreadsheetId}/values/Responses!A1?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: JSON.stringify({ values }) }
  );
  if (!writeRes.ok) throw new Error(`Sheets write error: ${writeRes.status} ${await writeRes.text()}`);
}
