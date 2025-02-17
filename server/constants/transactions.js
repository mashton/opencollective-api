import { TransactionKind } from './transaction-kind';

/** Types of Transactions */
export const TransactionTypes = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
};

export const PLATFORM_TIP_TRANSACTION_PROPERTIES = {
  kind: TransactionKind.PLATFORM_TIP,
  CollectiveId: 8686, // Open Collective (Organization)
  HostCollectiveId: 8686, // Open Collective (Organization)
  hostCurrency: 'USD',
  currency: 'USD',
};

// Pia's account
export const SETTLEMENT_USER_ID = 30;

export const SETTLEMENT_PAYMENT_METHOD = {
  BANK_ACCOUNT: 2955,
  PAYPAL: 6087,
  DEFAULT: 2955,
};

export const SETTLEMENT_EXPENSE_PROPERTIES = {
  FromCollectiveId: 8686,
  lastEditedById: SETTLEMENT_USER_ID,
  UserId: SETTLEMENT_USER_ID,
  payeeLocation: {
    address: '340 S Lemon Ave #3717, Walnut, CA 91789',
    country: 'US',
  },
};
