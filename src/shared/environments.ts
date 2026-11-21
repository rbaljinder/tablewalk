/**
 * Multi-environment database model shared by the server, MCP tools, and browser UI.
 * Pure TypeScript with zero Node-only imports.
 */

export type EnvironmentTier = 'local' | 'dev' | 'staging' | 'prod' | 'replica' | 'test' | 'other';

export const ENVIRONMENT_PIPELINE: readonly EnvironmentTier[] = ['local', 'dev', 'test', 'staging', 'replica', 'prod', 'other'] as const;

export interface ConnectionEnvMeta {
  database?: string;
  env?: string;
}

export interface ResolvedConnectionEnvironment {
  database: string;
  env?: string;
  tier: EnvironmentTier;
  explicit: boolean;
}

export interface SiblingEnvironment {
  id: string;
  name: string;
  env?: string;
  tier: EnvironmentTier;
  writable: boolean;
  rows?: boolean;
}

export type EnrichedConnection<T extends { id: string; name: string }> = T & {
  database: string;
  env?: string;
  tier: EnvironmentTier;
  explicit?: boolean;
  siblings: SiblingEnvironment[];
};

export interface DatabaseEnvironmentGroup<T> {
  database: string;
  environments: T[];
}

const TOKENS = new Map<string, [EnvironmentTier, string]>();
for (const [tier, canonical, words] of [
  ['local', 'local', 'local localhost'],
  ['dev', 'dev', 'dev develop development'],
  ['dev', '', 'sandbox preview'],
  ['test', 'test', 'test testing'],
  ['test', '', 'qa ci e2e'],
  ['staging', 'staging', 'stage staging stg'],
  ['staging', 'preprod', 'preprod pre-prod'],
  ['staging', 'uat', 'uat'],
  ['replica', 'replica', 'replica ro readonly read-only standby follower reader'],
  ['prod', 'prod', 'prod production prd live'],
] as const) {
  for (const w of words.split(' ')) TOKENS.set(w, [tier, canonical || w]);
}

const PREFIX_TOKENS = new Set(
  'local dev development test testing qa ci stage staging stg uat preprod prod production prd replica'.split(' '),
);
const BARE_TOKENS = new Set('local dev development stage staging stg uat preprod prod production prd'.split(' '));

export function tierRank(tier: EnvironmentTier): number {
  const idx = ENVIRONMENT_PIPELINE.indexOf(tier);
  return idx >= 0 ? idx : 6;
}

export function classifyEnvTier(env?: string, detail?: string): EnvironmentTier {
  const token = (env ?? '').trim().toLowerCase();
  if (token) {
    if (token === 'primary') return 'prod';
    const direct = TOKENS.get(token);
    if (direct) return direct[0];
    for (const part of token.split(/[-_./:\s]+/)) {
      if (part === 'primary') return 'prod';
      const hit = TOKENS.get(part);
      if (hit) return hit[0];
    }
    return 'other';
  }
  const t = (detail ?? '').trim().toLowerCase();
  if (!t) return 'other';
  if (/(?:^|[.@/-])(?:prod|production|prd)(?:[.:/_-]|$)/.test(t)) return 'prod';
  if (/(?:^|[.@/-])(?:staging|stage|stg|uat|preprod)(?:[.:/_-]|$)/.test(t)) return 'staging';
  if (/(?:^|[.@/-])(?:replica|readonly|read-only|standby)(?:[.:/_-]|$)/.test(t)) return 'replica';
  if (/(?:^|[.@/-])(?:dev|development|sandbox)(?:[.:/_-]|$)/.test(t)) return 'dev';
  if (/(?:^|[@/])(?:localhost|127\.0\.0\.1|\[::1\])(?:[:/]|$)/.test(t)) return 'local';
  return 'other';
}

function inferFromName(rawName: string): { database: string; env?: string } {
  const name = rawName.trim();
  if (!name) return { database: rawName };

  const wrapped = /^(.+?)\s*(?:\(([^()]+)\)|\[([^\][]+)\])$/.exec(name);
  if (wrapped) {
    const hit = TOKENS.get((wrapped[2] ?? wrapped[3] ?? '').trim().toLowerCase());
    if (wrapped[1].trim() && hit) return { database: wrapped[1].trim(), env: hit[1] };
  }

  if (!name.includes('://') && !name.includes('/')) {
    const at = /^(.+?)@([a-z0-9_-]+)$/i.exec(name);
    if (at) {
      const hit = TOKENS.get(at[2].toLowerCase());
      if (at[1].trim() && hit) return { database: at[1].trim(), env: hit[1] };
    }
  }

  const compound = /^(.+?)[-_./:\s]+(read[-_]only|pre[-_]prod)$/i.exec(name);
  if (compound) {
    const hit = TOKENS.get(compound[2].toLowerCase().replace('_', '-'));
    if (compound[1].trim() && hit) return { database: compound[1].trim(), env: hit[1] };
  }

  if (!name.includes('://')) {
    const suffix = /^(.+?)[-_./:\s]+([a-z0-9]+)$/i.exec(name);
    if (suffix) {
      const hit = TOKENS.get(suffix[2].toLowerCase());
      if (suffix[1].trim() && hit) return { database: suffix[1].trim(), env: hit[1] };
    }
    const prefix = /^([a-z0-9]+)[-_.:]+(.+)$/i.exec(name);
    if (prefix) {
      const tag = prefix[1].toLowerCase();
      if (prefix[2].trim() && PREFIX_TOKENS.has(tag)) {
        return { database: prefix[2].trim(), env: TOKENS.get(tag)![1] };
      }
    }
  }

  const lower = name.toLowerCase();
  if (BARE_TOKENS.has(lower)) return { database: name, env: TOKENS.get(lower)![1] };
  return { database: name };
}

export function resolveConnectionEnvironment(conn: {
  id: string;
  name: string;
  detail?: string;
  database?: string;
  env?: string;
}): ResolvedConnectionEnvironment {
  const explicitDb = conn.database?.trim() || undefined;
  const explicitEnv = conn.env?.trim() || undefined;
  const inferred = inferFromName(conn.name || conn.id);
  const database = explicitDb ?? inferred.database;
  const env = explicitEnv ?? inferred.env;
  return {
    database,
    ...(env ? { env } : {}),
    tier: env ? classifyEnvTier(env, conn.detail) : 'other',
    explicit: Boolean(explicitDb || explicitEnv),
  };
}

export function parseEnvironmentSelector(raw: string): { database?: string; env: string } | null {
  const s = raw.trim();
  if (!s || s.includes('://') || s.includes('/')) return null;
  const m = /^([^@\s]*)@([a-z0-9._-]+)$/i.exec(s);
  if (!m || !m[2].trim()) return null;
  const db = m[1].trim();
  return db ? { database: db, env: m[2].trim() } : { env: m[2].trim() };
}

export function filterConnectionsByEnv<T extends { env?: string; tier: EnvironmentTier }>(
  candidates: readonly T[],
  wantedEnv: string,
): T[] {
  const needle = wantedEnv.trim().toLowerCase();
  if (!needle) return [];
  const exact = candidates.filter((c) => c.env?.toLowerCase() === needle);
  if (exact.length) return exact;
  const canonical = TOKENS.get(needle)?.[1];
  if (canonical) {
    const byCanonical = candidates.filter((c) => c.env?.toLowerCase() === canonical);
    if (byCanonical.length) return byCanonical;
  }
  const tier = classifyEnvTier(needle);
  return tier !== 'other' ? candidates.filter((c) => c.tier === tier) : [];
}

export function enrichConnectionsWithEnvironments<
  T extends {
    id: string;
    name: string;
    detail?: string;
    writable?: boolean;
    rows?: boolean;
    database?: string;
    env?: string;
    explicit?: boolean;
    tier?: EnvironmentTier;
    siblings?: SiblingEnvironment[];
  },
>(list: readonly T[], explicitById?: ReadonlyMap<string, ConnectionEnvMeta>): Array<EnrichedConnection<T>> {
  const resolved = list.map((item, index) => {
    if (!explicitById && Array.isArray(item.siblings) && typeof item.tier === 'string') {
      return {
        item,
        index,
        envInfo: {
          database: item.database ?? item.name,
          ...(item.env ? { env: item.env } : {}),
          tier: item.tier,
          explicit: Boolean(item.explicit),
        },
      };
    }
    const meta = explicitById?.get(item.id);
    return {
      item,
      index,
      envInfo: resolveConnectionEnvironment({
        id: item.id,
        name: item.name,
        detail: item.detail,
        database: meta ? meta.database : item.database,
        env: meta ? meta.env : item.env,
      }),
    };
  });

  const dbLabel = new Map<string, string>();
  const buckets = new Map<string, typeof resolved>();
  for (const r of resolved) {
    const key = r.envInfo.database.toLowerCase();
    if (!dbLabel.has(key)) dbLabel.set(key, r.envInfo.database);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(r);
  }
  for (const b of buckets.values()) {
    b.sort((a, c) => tierRank(a.envInfo.tier) - tierRank(c.envInfo.tier) || a.index - c.index);
  }

  return resolved.map(({ item, envInfo }) => {
    const key = envInfo.database.toLowerCase();
    const siblings: SiblingEnvironment[] = (buckets.get(key) ?? [])
      .filter((o) => o.item.id !== item.id)
      .map((o) => ({
        id: o.item.id,
        name: o.item.name,
        ...(o.envInfo.env ? { env: o.envInfo.env } : {}),
        tier: o.envInfo.tier,
        writable: Boolean(o.item.writable),
        ...(o.item.rows === false ? { rows: false } : {}),
      }));
    return {
      ...item,
      database: dbLabel.get(key) ?? envInfo.database,
      ...(envInfo.env ? { env: envInfo.env } : {}),
      tier: envInfo.tier,
      ...(envInfo.explicit ? { explicit: true } : {}),
      siblings,
    };
  });
}

export function groupConnectionsByDatabase<
  T extends {
    id: string;
    name: string;
    detail?: string;
    writable?: boolean;
    rows?: boolean;
    database?: string;
    env?: string;
    tier?: EnvironmentTier;
  },
>(list: readonly T[]): Array<DatabaseEnvironmentGroup<EnrichedConnection<T>>> {
  const enriched = enrichConnectionsWithEnvironments(list);
  const groups = new Map<string, DatabaseEnvironmentGroup<EnrichedConnection<T>>>();
  const order = new Map<string, number>(enriched.map((item, i) => [item.id, i]));
  for (const item of enriched) {
    const key = item.database.toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { database: item.database, environments: [] }));
    g.environments.push(item);
  }
  for (const g of groups.values()) {
    g.environments.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }
  return [...groups.values()];
}
