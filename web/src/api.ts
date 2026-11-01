export interface Account {
  id: number;
  name: string;
  kind: 'checking' | 'savings' | 'credit' | 'cash' | 'loan';
  institution: string | null;
  on_budget: number;
  closed: number;
  balance: number;
  bank_balance: number | null;
  unreviewed: number;
  last_date: string | null;
  connection_id: number | null;
  connection_status: string | null;
  last_sync_at: string | null;
  due_day?: number | null;
}

export interface CategoryOption {
  id: number;
  name: string;
  hidden: number;
  group_id: number;
  group_name: string;
  is_income: number;
  /** How often it was used the last 90 days, for "Mest brukt" at the top of the picker. */
  uses?: number;
}

export interface Summary {
  readyToAssign: number;
  /** First day of the budget after "Start på nytt", or null. */
  budgetStart: string | null;
  /** Banks that have gone quiet, or whose automatic sync hasn't run. */
  /** Card bills due within five days, or not paid in full. */
  cardAlerts?: Array<{ id: number; name: string; status: 'due' | 'overdue'; left: number; due: string; days: number; interestPerMonth: number | null; pot: number | null }>;
  /** Refunds waiting for more than two weeks. */
  lateRefunds?: Array<{ id: number; payee: string; amount: number; days: number }>;
  stale?: Array<{ accountId: number; name: string; days: number; usual: number; kind: 'quiet' | 'nosync'; lastSyncAt: string | null }>;
  overspending: 'carry' | 'reset';
  unreviewed: number;
  accounts: Account[];
  attention: Array<{ id: number; name: string; provider: string; status: string; expires_at: string | null; last_error: string | null }>;
  categories: CategoryOption[];
}

export interface CategoryRow {
  id: number;
  group_id: number;
  name: string;
  hidden: number;
  target_type: 'monthly' | 'by_date' | 'balance' | null;
  target_amount: number | null;
  target_date: string | null;
  note: string | null;
  assigned: number;
  activity: number;
  available: number;
  lastMonthAssigned: number;
  lastMonthActivity: number;
  avgActivity: number;
  needed: number;
  targetProgress: number | null;
  card?: { accountId: number; owed: number; dueDay: number | null };
}

export interface BudgetMonth {
  month: string;
  readyToAssign: number;
  income: number;
  assigned: number;
  activity: number;
  available: number;
  uncategorized: { count: number; amount: number };
  unreviewed: number;
  pace: number;
  groups: Array<{ id: number; name: string; hidden: number; categories: CategoryRow[] }>;
}

export interface Split {
  id?: number;
  category_id: number | null;
  category_name?: string | null;
  amount: number;
  memo: string;
}

export interface Transaction {
  id: number;
  account_id: number;
  account_name: string;
  account_kind: string;
  date: string;
  amount: number;
  payee: string;
  raw_description: string;
  memo: string;
  category_id: number | null;
  category_name: string | null;
  transfer_id: number | null;
  transfer_account_id: number | null;
  transfer_account_name: string | null;
  suggested_category_id: number | null;
  suggested_category_name: string | null;
  suggestion_source: 'rule' | 'history' | 'merchant' | null;
  suggested_transfer_id: number | null;
  suggested_transfer_account_id: number | null;
  suggested_transfer_account_name: string | null;
  suggested_transfer_date: string | null;
  reviewed: number;
  source: string;
  splits: Split[];
  attachment_count?: number;
}

export interface Recurring {
  payee: string;
  categoryId: number | null;
  categoryName: string | null;
  accountName: string;
  amount: number;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  lastDate: string;
  nextDate: string;
  occurrences: number;
}

export interface IngestResult {
  added: number;
  duplicates: number;
  matched: number;
  categorized: number;
  transfers: number;
  errors?: string[];
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('budget:logout'));
    throw new ApiError(json.error ?? `Forespørselen feilet (${res.status})`, res.status);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Sends a file as the raw request body. */
  upload: async <T>(path: string, file: Blob, name: string): Promise<T> => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(name) },
      body: file,
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.error ?? `Opplastingen feilet (${res.status})`, res.status);
    return json as T;
  },
};

export interface Attachment {
  id: number;
  name: string;
  mime: string;
  size: number;
  created_at: string;
}
