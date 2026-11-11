import { HttpError, isRecord } from './errors.js';
import { providerFromConfig } from './providers.js';
import type { AccountRow, Profile, Provider, ProviderInput, ProviderRecord, Snapshot } from './types.js';

export function isSub2api(provider: Pick<Provider, 'template'>): boolean { return provider.template.startsWith('sub2api'); }
export const isSub2Api = isSub2api;
export const isSub2API = isSub2api;

export function profileId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9][0-9]{0,99}$/.test(value) ? value : null;
}

export function responseData(body: unknown, provider: Pick<Provider, 'template'>): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const success = isSub2api(provider) ? typeof body.code === 'number' && Number.isInteger(body.code) && body.code === 0 : body.success === true;
  return success && isRecord(body.data) ? body.data : null;
}

export function roundAmount(value: number): number {
  const amount = Number(value.toFixed(2));
  return Object.is(amount, -0) ? 0 : amount;
}

export function quotaSnapshot(profile: unknown, quotaPerUnit = 500000): Snapshot | null {
  if (!isRecord(profile) || typeof quotaPerUnit !== 'number' || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) return null;
  const quota = profile.quota, used = profile.used_quota;
  if (typeof quota !== 'number' || typeof used !== 'number' || !Number.isFinite(quota) || !Number.isFinite(used) || quota < 0 || used < 0) return null;
  const balance = quota / quotaPerUnit, consumed = used / quotaPerUnit, total = balance + consumed;
  if (![balance, consumed, total].every(Number.isFinite)) return null;
  return { balance: roundAmount(balance), used_quota: roundAmount(consumed), total: roundAmount(total) };
}

export function profileSnapshot(profile: unknown, provider: Pick<Provider, 'template' | 'quota_per_unit'>): Snapshot | null {
  if (!isSub2api(provider)) return quotaSnapshot(profile, provider.quota_per_unit);
  if (!isRecord(profile) || typeof profile.balance !== 'number' || !Number.isFinite(profile.balance)) return null;
  return { balance: roundAmount(profile.balance), used_quota: null, total: null };
}

export function verifiedProfile(body: unknown, provider: Provider, expectedId?: string): Profile | null {
  const data = responseData(body, provider);
  const id = data ? profileId(data.id) : null;
  return data && id && (expectedId === undefined || id === expectedId) ? data as Profile : null;
}

export class ProtocolMismatch extends HttpError {
  constructor() { super(422, '已识别为 Sub2API 站点；请在站点管理中选择 Sub2API 模板并核对接口，再重新添加或授权账号。'); }
}

export interface ProtocolStore {
  providerConfigs(): ProviderRecord[];
  saveProvider(id: string, config: ProviderInput, options?: { active?: boolean }): unknown;
  accounts(enabledOnly?: boolean): AccountRow[];
  runs?(limit?: number): { provider: string; before_balance?: unknown; after_balance?: unknown }[];
  db?: { prepare(sql: string): { get(...args: string[]): unknown } };
}

export function resolveCustomProtocol(provider: Provider, detected: { protocol?: unknown }, store: ProtocolStore | undefined, registry: Record<string, Provider>, hasSnapshot = false): Provider {
  if (!provider.custom || isSub2api(provider) || detected.protocol !== 'sub2api' || !store) return provider;
  const record = store.providerConfigs().find(item => item.id === provider.name);
  if (!record) return provider;
  const current = registry[provider.name];
  if (current && isSub2api(current)) return current;
  const customized = provider.user_info_path !== '/api/user/self' || provider.login_api_path !== '/api/user/login'
    || ![null, '/api/user/checkin', '/api/user/sign_in'].includes(provider.sign_in_path)
    || provider.currency !== 'USD' || provider.quota_per_unit !== 500000;
  let recorded = hasSnapshot || store.accounts().some(row => row.provider === provider.name && Boolean(row.has_snapshot));
  if (!recorded && store.db) recorded = Boolean(store.db.prepare('SELECT 1 FROM runs WHERE provider=? AND (before_balance IS NOT NULL OR after_balance IS NOT NULL) LIMIT 1').get(provider.name));
  if (!recorded && store.runs) recorded = store.runs(1000).some(row => row.provider === provider.name && (row.before_balance != null || row.after_balance != null));
  if (customized || recorded) throw new ProtocolMismatch();
  const input = {
    ...record.config, template: provider.sign_in_path === null ? 'sub2api_balance' : 'sub2api',
    user_info_path: '/api/v1/auth/me', login_api_path: '/api/v1/auth/login',
    sign_in_path: provider.sign_in_path === null ? null : '/api/v1/user/check-in', quota_per_unit: 1,
  };
  const resolved = providerFromConfig(provider.name, input, provider.active);
  store.saveProvider(provider.name, { ...input, template: resolved.template }, { active: provider.active });
  registry[provider.name] = resolved;
  return resolved;
}
