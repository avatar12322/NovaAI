import { z } from 'zod';
import { Space } from './common';
import { AMOUNT_RE, isCurrency, looksLikeSecret, safePanelUrl } from './money';

/** Moduł „Usługi i koszty”: rejestr usług, wpisy kosztów, suma miesiąca (DECISIONS D-029). */
export const ServiceCategory = z.enum([
  'model_api',
  'vps',
  'database',
  'domain',
  'backup',
  'subscription',
  'other',
]);
export type ServiceCategory = z.infer<typeof ServiceCategory>;
export const BillingPeriod = z.enum(['monthly', 'quarterly', 'yearly', 'one_time', 'usage']);
export type BillingPeriod = z.infer<typeof BillingPeriod>;
export const ServiceStatus = z.enum(['active', 'trial', 'paused', 'cancelled']);
export type ServiceStatus = z.infer<typeof ServiceStatus>;
/** Szacunek (np. z wywołań modeli), raport dostawcy, faktura (opłacona, gdy ma datę zapłaty). */
export const CostKind = z.enum(['estimate', 'report', 'invoice']);
export type CostKind = z.infer<typeof CostKind>;
export const CostAdapterId = z.enum(['anthropic', 'openai']);
export type CostAdapterId = z.infer<typeof CostAdapterId>;

const NO_SECRET = 'Nie wpisuj tu haseł ani kluczy API — ten moduł ich nie przechowuje';
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !looksLikeSecret(v), NO_SECRET);

export const CurrencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCurrency, 'Nieznany kod waluty (ISO 4217, np. PLN, USD, EUR)');
export const AmountText = z
  .string()
  .trim()
  .regex(AMOUNT_RE, 'Kwota: liczba, np. 12,34 (bez waluty i znaku)');
export const MonthText = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Miesiąc: RRRR-MM');
export const DateText = z.iso.date();
export const PanelUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => safePanelUrl(v) !== null,
    'Link do panelu: tylko https://, bez loginu, hasła ani tokenu w adresie',
  );

const ModelProvider = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,60}$/, 'Nieprawidłowy dostawca modeli');

const ServiceFields = {
  name: text(120).pipe(z.string().min(1, 'Podaj nazwę')),
  category: ServiceCategory,
  purpose: text(500).default(''),
  panelUrl: PanelUrl.nullable().default(null),
  billingPeriod: BillingPeriod,
  currency: CurrencyCode,
  plan: text(120).default(''),
  renewsOn: DateText.nullable().default(null),
  remindDaysBefore: z.number().int().min(0).max(60).default(7),
  monthlyBudget: AmountText.nullable().default(null),
  status: ServiceStatus.default('active'),
  modelProvider: ModelProvider.nullable().default(null),
  costAdapter: CostAdapterId.nullable().default(null),
  notes: text(1000).default(''),
};

export const CreateService = z.object({ ...ServiceFields, space: Space.default('private') });
export type CreateService = z.infer<typeof CreateService>;
export const UpdateService = z
  .object({
    name: ServiceFields.name,
    category: ServiceCategory,
    purpose: text(500),
    panelUrl: PanelUrl.nullable(),
    billingPeriod: BillingPeriod,
    currency: CurrencyCode,
    plan: text(120),
    renewsOn: DateText.nullable(),
    remindDaysBefore: z.number().int().min(0).max(60),
    monthlyBudget: AmountText.nullable(),
    status: ServiceStatus,
    modelProvider: ModelProvider.nullable(),
    costAdapter: CostAdapterId.nullable(),
    notes: text(1000),
  })
  .partial();
export type UpdateService = z.infer<typeof UpdateService>;

export const CreateCost = z
  .object({
    kind: CostKind,
    amount: AmountText,
    currency: CurrencyCode,
    month: MonthText,
    description: text(300).default(''),
    invoiceNumber: text(80).pipe(z.string().min(1)).optional(),
    issuedOn: DateText.optional(),
    paidOn: DateText.optional(),
  })
  .refine((c) => c.kind === 'invoice' || (!c.invoiceNumber && !c.paidOn), {
    message: 'Numer faktury i data zapłaty dotyczą tylko faktur',
  });
export type CreateCost = z.infer<typeof CreateCost>;

/**
 * Import faktur z CSV (separator „;” lub „,”), nagłówek wymagany:
 * `numer;data_wystawienia;kwota;waluta;miesiac;data_zaplaty` (data_zaplaty opcjonalna, pusta = nieopłacona).
 */
export const ImportCosts = z.object({ csv: z.string().min(1).max(200_000) });

export const ListServicesQuery = z.object({
  space: z.enum(['private', 'shared', 'all']).default('all'),
  month: MonthText.optional(),
});
export const SummaryQuery = z.object({
  space: z.enum(['private', 'shared', 'all']).default('all'),
  month: MonthText.optional(),
});

// ---------- Odpowiedzi (kształt JSON) ----------

export type Money = { micros: number; currency: string };
export type BudgetState = 'none' | 'ok' | 'near' | 'exceeded';

export interface CostEntryInfo {
  id: string;
  kind: CostKind;
  month: string;
  amountMicros: number;
  currency: string;
  description: string;
  invoiceNumber: string | null;
  issuedOn: string | null;
  paidOn: string | null;
  source: string;
  /** Czy wpis wchodzi do sumy miesiąca (fałsz = zastąpiony dokładniejszym źródłem). */
  counted: boolean;
  createdAt: string;
}

export interface ServiceMonth {
  month: string;
  /** Źródło wliczone do sumy: faktura > raport dostawcy > szacunek (null = brak danych). */
  countedKind: CostKind | null;
  /** Suma wliczona, osobno dla każdej waluty. */
  totals: Money[];
  /** Szacunek z zapisanych wywołań modeli (gdy usługa ma powiązanego dostawcę modeli). */
  modelEstimate: Money[];
  budget: { micros: number; currency: string; spentMicros: number; state: BudgetState } | null;
  /** Kwoty w innej walucie niż waluta usługi — nie są porównywane z budżetem. */
  otherCurrencies: string[];
}

export interface ServiceInfo {
  id: string;
  name: string;
  category: ServiceCategory;
  purpose: string;
  panelUrl: string | null;
  billingPeriod: BillingPeriod;
  currency: string;
  plan: string;
  renewsOn: string | null;
  remindDaysBefore: number;
  reminderScheduled: boolean;
  monthlyBudgetMicros: number | null;
  status: ServiceStatus;
  modelProvider: string | null;
  costAdapter: CostAdapterId | null;
  notes: string;
  visibility: 'private' | 'shared';
  ownerUserId: string;
  ownerName: string | null;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
  current: ServiceMonth;
}

export interface CostSummary {
  month: string;
  /** Suma miesiąca per waluta — każda opłata liczona raz. */
  totals: Money[];
  /** Z czego: kwoty wliczone według źródła (faktury opłacone / do zapłaty, raporty, szacunki). */
  byKind: Array<Money & { kind: CostKind | 'invoice_unpaid' }>;
  exceeded: Array<{ serviceId: string; name: string }>;
  services: number;
}

export interface CostAdapterInfo {
  id: CostAdapterId;
  title: string;
  docsUrl: string;
  docsVerifiedAt: string;
  /** Klucz administracyjny obecny w konfiguracji serwera (sam klucz nigdy nie jest zwracany). */
  keyConfigured: boolean;
  /** „podłączony” wyłącznie po udanej synchronizacji. */
  state: 'not_configured' | 'not_connected' | 'error' | 'connected';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  serviceId: string | null;
}
