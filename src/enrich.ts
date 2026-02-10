import type { Env } from "./storage";
import { upsertCompanyEnrichment, getCompanyEnrichment } from "./storage";

export type CompanyEnrichment = {
  name: string;
  domain?: string | null;
  industry?: string | null;
  employees?: number | null;
  size_bucket?: string | null; // "S" | "M" | "L" | "XL"
  source?: string | null; // "clearbit" | "wikidata"
  updated_at?: string | null;
};

function sizeBucket(n?: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n < 50) return "S";
  if (n < 250) return "M";
  if (n < 1000) return "L";
  return "XL";
}

function normCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// Clearbit autocomplete (обычно работает без ключа)
async function enrichViaClearbit(name: string): Promise<Pick<CompanyEnrichment, "domain" | "industry" | "employees" | "source"> | null> {
  const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as any;
  if (!Array.isArray(data) || !data.length) return null;

  // берём первый матч
  const first = data[0];
  return {
    domain: typeof first?.domain === "string" ? first.domain : null,
    industry: typeof first?.category?.industry === "string" ? first.category.industry : null,
    employees: typeof first?.metrics?.employees === "number" ? first.metrics.employees : null,
    source: "clearbit",
  };
}

// Wikidata fallback: пытаемся найти по названию и вытащить индустрию/число сотрудников (если есть)
async function enrichViaWikidata(name: string): Promise<Pick<CompanyEnrichment, "industry" | "employees" | "source"> | null> {
  const searchUrl =
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    `&language=en&format=json&limit=1`;
  const sres = await fetch(searchUrl, { headers: { "Accept": "application/json" } });
  if (!sres.ok) return null;
  const sdata = (await sres.json().catch(() => null)) as any;
  const id = sdata?.search?.[0]?.id as string | undefined;
  if (!id) return null;

  // P452 (industry), P1128 (employees)
  const entUrl =
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(id)}` +
    `&props=claims&format=json`;
  const eres = await fetch(entUrl, { headers: { "Accept": "application/json" } });
  if (!eres.ok) return null;
  const edata = (await eres.json().catch(() => null)) as any;
  const claims = edata?.entities?.[id]?.claims;

  let industry: string | null = null;
  let employees: number | null = null;

  // employees
  const empVal = claims?.P1128?.[0]?.mainsnak?.datavalue?.value?.amount;
  if (typeof empVal === "string") {
    const n = Number(empVal);
    if (Number.isFinite(n)) employees = Math.abs(n);
  }

  // industry label: needs another call for label; keep it simple: store Q-id
  const indId = claims?.P452?.[0]?.mainsnak?.datavalue?.value?.id;
  if (typeof indId === "string") {
    industry = indId; // Qxxxx (лучше чем пусто, и не требует доп. вызова)
  }

  if (!industry && !employees) return null;
  return { industry, employees, source: "wikidata" };
}

export async function enrichCompany(env: Env, companyName: string, force = false): Promise<CompanyEnrichment | null> {
  const name = companyName?.trim();
  if (!name) return null;

  const key = normCompanyName(name);
  const cached = await getCompanyEnrichment(env, key);
  if (cached && !force) return cached;

  let best: any = null;

  // 1) clearbit
  try {
    best = await enrichViaClearbit(name);
  } catch (e) {
    console.log("clearbit enrich error", e);
  }

  // 2) wikidata fallback
  if (!best) {
    try {
      best = await enrichViaWikidata(name);
    } catch (e) {
      console.log("wikidata enrich error", e);
    }
  }

  if (!best) return null;

  const record: CompanyEnrichment = {
    name,
    domain: best.domain ?? null,
    industry: best.industry ?? null,
    employees: best.employees ?? null,
    size_bucket: sizeBucket(best.employees ?? null),
    source: best.source ?? null,
    updated_at: new Date().toISOString(),
  };

  await upsertCompanyEnrichment(env, key, record);
  return record;
}

export async function enrichCompanies(env: Env, companyNames: string[], force = false): Promise<void> {
  const uniq = Array.from(new Set(companyNames.map((n) => n.trim()).filter(Boolean)));
  for (const name of uniq) {
    await enrichCompany(env, name, force);
  }
}
