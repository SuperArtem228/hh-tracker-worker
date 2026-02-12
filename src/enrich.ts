import { getCompanyEnrichment, upsertCompanyEnrichment } from "./storage";

export type CompanyEnrichment = {
  company: string;
  domain?: string | null;
  industry?: string | null;
  employees?: number | null;
  size_bucket?: "S" | "M" | "L" | "XL" | null;
  source: "clearbit" | "wikidata" | "none";
};

function sizeBucket(n: number | null | undefined): CompanyEnrichment["size_bucket"] {
  if (!n || !Number.isFinite(n)) return null;
  if (n < 50) return "S";
  if (n < 250) return "M";
  if (n < 1000) return "L";
  return "XL";
}

function hostnameFromUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    const h = new URL(u).hostname;
    return h ? h.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 6000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// 1) Clearbit suggest: name -> domain (часто без ключа)
async function enrichViaClearbit(company: string): Promise<Pick<CompanyEnrichment, "domain" | "source"> | null> {
  const q = encodeURIComponent(company);
  const data = await fetchJson(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${q}`);
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0];
  const domain = typeof first?.domain === "string" ? first.domain : null;
  if (!domain) return null;
  return { domain, source: "clearbit" };
}

// 2) Wikidata: name -> industry + employees (+ иногда website -> domain)
async function enrichViaWikidata(company: string): Promise<Pick<CompanyEnrichment, "domain" | "industry" | "employees" | "source"> | null> {
  const q = encodeURIComponent(company);
  const search = await fetchJson(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&format=json&limit=1&origin=*`
  );
  const id = search?.search?.[0]?.id;
  if (!id) return null;

  const entityData = await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`);
  const entity = entityData?.entities?.[id];
  if (!entity?.claims) return null;

  // website (P856)
  const website = entity.claims.P856?.[0]?.mainsnak?.datavalue?.value;
  const domain = typeof website === "string" ? hostnameFromUrl(website) : null;

  // employees (P1128)
  const empRaw = entity.claims.P1128?.[0]?.mainsnak?.datavalue?.value?.amount;
  const employees = typeof empRaw === "string" ? Number(empRaw) : null;

  // industry (P452) -> get label (one more request)
  let industry: string | null = null;
  const indId = entity.claims.P452?.[0]?.mainsnak?.datavalue?.value?.id;
  if (typeof indId === "string") {
    const indData = await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${indId}.json`);
    const indEntity = indData?.entities?.[indId];
    const label = indEntity?.labels?.en?.value;
    if (typeof label === "string") industry = label;
  }

  if (!domain && !industry && !employees) return null;
  return { domain, industry, employees, source: "wikidata" };
}

export async function enrichCompany(env: { DB: D1Database }, company: string): Promise<CompanyEnrichment> {
  // cache
  const cached = await getCompanyEnrichment(env, company);
  if (cached) return cached;

  const viaClearbit = await enrichViaClearbit(company);
  const viaWikidata = await enrichViaWikidata(company);

  const domain = viaClearbit?.domain ?? viaWikidata?.domain ?? null;
  const industry = viaWikidata?.industry ?? null;
  const employees = viaWikidata?.employees ?? null;

  const result: CompanyEnrichment = {
    company,
    domain,
    industry,
    employees,
    size_bucket: sizeBucket(employees),
    source: (viaClearbit?.source ?? viaWikidata?.source ?? "none") as CompanyEnrichment["source"],
  };

  await upsertCompanyEnrichment(env, result);
  return result;
}

export async function enrichCompanies(env: { DB: D1Database }, companies: string[], max = 30): Promise<void> {
  const uniq = Array.from(new Set(companies.map((c) => c.trim()).filter(Boolean))).slice(0, max);
  for (const c of uniq) {
    try {
      await enrichCompany(env, c);
    } catch {
      // silent
    }
  }
}
