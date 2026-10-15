export interface CPayOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  currency?: string;
}
/** @deprecated utiliser CPayOptions */
export type CPlusOptions = CPayOptions;

export interface CollectMomoParams {
  amount: number;
  customerPhone: string;
  method: 'airtel_money' | 'mtn_momo';
  description?: string;
  reference?: string;
  currency?: string;
}

export interface PayLinkParams {
  amount: number;
  description?: string;
  psp?: 'cybersource' | 'migs';
  currency?: string;
  recipientPhone?: string;
}

export interface DisburseParams {
  amount: number;
  recipientPhone: string;
  operator: 'airtel_money' | 'mtn_momo';
  description?: string;
  reference?: string;
  currency?: string;
}

export interface TransactionResponse {
  txnId: string;
  status: 'pending' | 'authorized' | 'failed';
  reference: string;
  amount: number;
  currency: string;
}

export interface PayLinkResponse {
  pay_link_id: string;
  short_id: string;
  short_url: string;
  amount: number;
  currency: string;
  status: string;
  expires_at: string;
}

export class CPayError extends Error {
  code: string;
  statusCode: number;
}

export class CPayClient {
  constructor(options: CPayOptions);
  readonly sandbox: boolean;

  collection: {
    momo(params: CollectMomoParams): Promise<TransactionResponse>;
    payLink(params: PayLinkParams): Promise<PayLinkResponse>;
    contactless(params: { amount: number; description?: string; reference?: string }): Promise<TransactionResponse>;
  };

  disbursement: {
    momo(params: DisburseParams): Promise<TransactionResponse>;
  };

  transactions: {
    list(params?: { page?: number; limit?: number; status?: string; type?: string }): Promise<{ data: TransactionResponse[]; total: number }>;
    get(txnId: string): Promise<TransactionResponse>;
  };

  payLinks: {
    list(params?: { page?: number; limit?: number; status?: string }): Promise<{ data: PayLinkResponse[]; total: number }>;
    create(params: PayLinkParams): Promise<PayLinkResponse>;
    cancel(payLinkId: string): Promise<{ success: boolean }>;
  };

  /** Lit X-CPay-Signature, puis X-CPlus-Signature (ancien nom). */
  static signatureFromHeaders(headers: Record<string, string | string[] | undefined>): string | null;
  /** `signature` peut etre la valeur de l'en-tete ou l'objet req.headers. */
  static verifyWebhook(payload: string | Buffer | object, signature: string | Record<string, string | string[] | undefined>, webhookSecret: string): boolean;
}

/** En-tetes de signature acceptes, par ordre de preference. */
export const SIGNATURE_HEADERS: readonly string[];

/** @deprecated utiliser CPayClient */
export const CPlusClient: typeof CPayClient;
/** @deprecated utiliser CPayError */
export const CPlusError: typeof CPayError;
