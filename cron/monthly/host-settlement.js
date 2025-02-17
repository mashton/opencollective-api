#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { parse as json2csv } from 'json2csv';
import { groupBy, sumBy } from 'lodash';
import moment from 'moment';

import activityType from '../../server/constants/activities';
import expenseStatus from '../../server/constants/expense_status';
import expenseTypes from '../../server/constants/expense_type';
// import { SHARED_REVENUE_PLANS } from '../../server/constants/plans';
import { SETTLEMENT_EXPENSE_PROPERTIES } from '../../server/constants/transactions';
// import { uploadToS3 } from '../../server/lib/awsS3';
import { getPendingHostFeeShare, getPendingPlatformTips } from '../../server/lib/host-metrics';
import { parseToBoolean } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';

const today = moment.utc();

const d = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
const rd = new Date(d.getFullYear(), d.getMonth() - 1);

const year = rd.getFullYear();
const month = rd.getMonth();

const date = new Date();
date.setFullYear(year);
date.setMonth(month);

const startDate = new Date(date.getFullYear(), date.getMonth(), 1);
const endDate = new Date(date.getFullYear(), date.getMonth() + 1, 1);

const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';

// Only run on the 1th of the month
if (isProduction && date.date() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
  console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
  process.exit();
}

if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

/*
const ATTACHED_CSV_COLUMNS = [
  'createdAt',
  'description',
  'CollectiveSlug',
  'amount',
  'currency',
  'OrderId',
  'TransactionId',
  'PaymentService',
  'source',
];
*/

export async function run() {
  console.info(`Invoicing hosts pending fees and tips for ${moment(date).subtract(1, 'month').format('MMMM')}.`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId },
    }),
    'type',
  );

  const hosts = await models.Collective.findAll({
    where: {
      isHostAccount: true,
    },
    // TODO: join Transactions to make and startDate/endDate to make sure the Host was active this month
  });

  for (const host of hosts) {
    const pendingPlatformTips = await getPendingPlatformTips(host, { startDate, endDate });
    const pendingHostFeeShare = await getPendingHostFeeShare(host, { startDate, endDate });
    // const settledHostFeeShare = await getSettledHostFeeShare(host, { startDate, endDate });

    if (HOST_ID && host.id != HOST_ID) {
      continue;
    }

    const plan = await host.getPlan();

    let items = [];

    const transactions = await sequelize.query(
      `SELECT t.*
FROM "Transactions" as t
WHERE t."HostCollectiveId" = :HostCollectiveId
AND t."createdAt" >= :startDate AND t."createdAt" <= :endDate
AND t."kind" IN ('PLATFORM_TIP', 'HOST_FEE_SHARE')
AND t."isDebt" IS TRUE
AND t."deletedAt" IS NULL`,
      {
        replacements: { HostCollectiveId: host.id, startDate: startDate, endDate: endDate },
        model: models.Transaction,
        mapToModel: true, // pass true here if you have any mapped fields
      },
    );

    items.push({
      incurredAt: new Date(),
      amount: pendingPlatformTips,
      description: 'Platform Tips',
    });

    items.push({
      incurredAt: new Date(),
      amount: pendingHostFeeShare,
      description: 'Shared Revenue',
    });

    if (plan.pricePerCollective) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        items.push({
          incurredAt: new Date(),
          amount,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const totalAmountCharged = sumBy(items, 'amount');

    if (totalAmountCharged < 1000) {
      console.warn(
        `${host.name} (#${host.id}) skipped, total amound pending ${totalAmountCharged / 100} < 10.00 ${
          host.currency
        }.\n`,
      );
      continue;
    }
    console.info(
      `${host.name} (#${host.id}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${host.currency})`,
    );

    // TODO: reactivate CSV when ready
    // const csv = json2csv(transactions.map(t => pick(t, ATTACHED_CSV_COLUMNS)));

    if (DRY) {
      console.debug(`Items:\n${json2csv(items)}\n`);
      // console.debug(csv);
    } else {
      const connectedAccounts = await host.getConnectedAccounts({
        where: { deletedAt: null },
      });

      let PayoutMethod =
        payoutMethods[PayoutMethodTypes.OTHER]?.[0] || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      if (
        connectedAccounts?.find(c => c.service === 'transferwise') &&
        payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0]
      ) {
        const currencyCompatibleAccount = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
          pm => pm.data?.currency === host.currency,
        );
        PayoutMethod = currencyCompatibleAccount || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      } else if (
        connectedAccounts?.find(c => c.service === 'paypal') &&
        !host.settings?.disablePaypalPayouts &&
        payoutMethods[PayoutMethodTypes.PAYPAL]?.[0]
      ) {
        PayoutMethod = payoutMethods[PayoutMethodTypes.PAYPAL]?.[0];
      }

      // Create the Expense
      const transactionIds = transactions.map(t => t.TransactionId);
      const expense = await models.Expense.create({
        ...SETTLEMENT_EXPENSE_PROPERTIES,
        PayoutMethodId: PayoutMethod.id,
        amount: totalAmountCharged,
        CollectiveId: host.id,
        currency: host.currency,
        description: `Platform settlement for ${moment.utc().subtract(1, 'month').format('MMMM')}`,
        incurredAt: today,
        data: { isPlatformTipSettlement: true, transactionIds },
        type: expenseTypes.INVOICE,
        status: expenseStatus.PENDING,
      });

      // Create Expense Items
      items = items.map(i => ({
        ...i,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      }));

      await models.ExpenseItem.bulkCreate(items);

      // Attach CSV
      // TODO: reactivate CSV when ready
      /*
      const Body = csv;
      const filenameBase = `${HostName}-${moment(date).subtract(1, 'month').format('MMMM-YYYY')}`;
      const Key = `${filenameBase}.${uuid().split('-')[0]}.csv`;
      const { Location: url } = await uploadToS3({
        Bucket: config.aws.s3.bucket,
        Key,
        Body,
        ACL: 'public-read',
        ContentType: 'text/csv',
      });
      await models.ExpenseAttachedFile.create({
        url,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      });
      */

      // Mark transactions as invoiced
      await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, expense.id);
      await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED);
    }
  }
}

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
