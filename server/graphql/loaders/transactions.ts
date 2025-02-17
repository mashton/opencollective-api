import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import models, { Op } from '../../models';

export const hostFeeAmountForTransaction: DataLoader<number, number[]> = new DataLoader(
  async (transactions: typeof models.Transaction[]) => {
    // Legacy transactions have their host fee set on `hostFeeInHostCurrency`. No need to fetch for them
    const transactionsWithoutHostFee = transactions.filter(transaction => !transaction.hostFeeInHostCurrency);
    const hostFeeTransactions = await models.Transaction.findAll({
      attributes: ['TransactionGroup', 'type', 'amount'],
      mapToModel: false,
      raw: true,
      where: {
        kind: TransactionKind.HOST_FEE,
        [Op.or]: transactionsWithoutHostFee.map(transaction => ({
          TransactionGroup: transaction.TransactionGroup,
          type: transaction.type,
        })),
      },
    });

    const keyBuilder = transaction => `${transaction.TransactionGroup}-${transaction.type}`;
    const groupedTransactions: Record<string, typeof models.Transaction> = groupBy(hostFeeTransactions, keyBuilder);
    return transactions.map(transaction => {
      if (transaction.hostFeeInHostCurrency) {
        return transaction.hostFeeInHostCurrency;
      } else {
        const key = keyBuilder(transaction);
        const hostFeeTransactions = groupedTransactions[key];
        if (hostFeeTransactions) {
          return hostFeeTransactions[0].amount;
        } else {
          return 0;
        }
      }
    });
  },
);
