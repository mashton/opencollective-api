import config from 'config';
import moment from 'moment';

import { sequelize } from '../models';

import { getFxRate } from './currency';
import { parseToBoolean } from './utils';

async function computeTotal(results, currency) {
  let total = 0;

  // For sanity reasons, we handle conversion in case there is any currency mismatch
  for (const result of results) {
    const value = result['_amount'];
    const fxRate = await getFxRate(result['_currency'], currency);
    total += Math.round(value * fxRate);
  }

  return total;
}

function computeDates(startDate, endDate) {
  startDate = startDate ? moment(startDate) : moment().utc().startOf('month');
  endDate = endDate ? moment(endDate) : moment(startDate).utc().endOf('month');

  return { startDate: startDate.toISOString(), endDate: endDate.toISOString() };
}

export async function getPlatformTips(host, { startDate, endDate } = {}) {
  const results = await sequelize.query(
    `SELECT
  SUM(
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        t2."amountInHostCurrency"::numeric / (t2."data"->>'hostToPlatformFxRate')::numeric
      ELSE
        t2."amountInHostCurrency"
    END
  ) as "_amount",
  (
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        h."currency"
      ELSE
        t2."hostCurrency"
    END
   ) as "_currency"
FROM "Transactions" as t1
INNER JOIN "Transactions" as t2
ON t1."TransactionGroup" = t2."TransactionGroup"
INNER JOIN "Collectives" as h
ON t1."HostCollectiveId" = h."id"
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND (t1."kind" IS NULL OR t1."kind" NOT IN ('PLATFORM_TIP'))
AND t2."kind" = 'PLATFORM_TIP'
AND t2."type" = 'CREDIT'
AND t2."isDebt" IS NOT TRUE
AND t1."deletedAt" IS NULL
AND t2."deletedAt" IS NULL
GROUP BY "_currency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return computeTotal(results, host.currency);
}

// NOTE: we're not looking at the settlementStatus and just SUM all debts of the month
export async function getPendingPlatformTips(host, { startDate, endDate } = {}) {
  const results = await sequelize.query(
    `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."kind" = 'PLATFORM_TIP'
AND t1."type" = 'CREDIT'
AND t1."isDebt" IS TRUE
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return computeTotal(results, host.currency);
}

export async function getHostFees(host, { startDate, endDate } = {}) {
  let results;
  if (parseToBoolean(config.ledger.separateHostFees) === true) {
    results = await sequelize.query(
      `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."kind" = 'HOST_FEE'
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
      {
        replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );
  } else {
    results = await sequelize.query(
      `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND NOT (t1."type" = 'DEBIT' AND t1."kind" = 'ADDED_FUNDS')
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
      {
        replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
        type: sequelize.QueryTypes.SELECT,
      },
    );
  }

  let total = await computeTotal(results, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  if (parseToBoolean(config.ledger.separateHostFees) === false && total != 0) {
    total = -total;
  }

  return total;
}

// TODO: refactor me using HOST_FEE_SHARE when available
export async function getHostFeeShare(host, { startDate, endDate } = {}) {
  const hostFees = await getHostFees(host, { startDate, endDate });

  const plan = await host.getPlan();
  const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

  return Math.round((hostFees * hostFeeSharePercent) / 100);
}

// TODO: refactor me using HOST_FEE_SHARE when available
export async function getPendingHostFeeShare(host, { startDate, endDate } = {}) {
  const results = await sequelize.query(
    `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
LEFT JOIN "PaymentMethods" pm ON
  t1."PaymentMethodId" = pm.id
LEFT JOIN "PaymentMethods" spm ON
  spm.id = pm."SourcePaymentMethodId"
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
AND (
  pm."service" != 'stripe'
  OR pm.service IS NULL
)
AND (
  spm.service IS NULL
  OR spm.service != 'stripe'
)
GROUP BY t1."hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(results, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  if (total != 0) {
    total = -total;
  }

  const plan = await host.getPlan();
  const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

  return Math.round((total * hostFeeSharePercent) / 100);
}

// TODO: refactor me using HOST_FEE_SHARE when available
export async function getSettledHostFeeShare(host, { startDate, endDate } = {}) {
  const results = await sequelize.query(
    `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
LEFT JOIN "PaymentMethods" pm ON
  t1."PaymentMethodId" = pm.id
LEFT JOIN "PaymentMethods" spm ON
  spm.id = pm."SourcePaymentMethodId"
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."createdAt" >= :startDate AND t1."createdAt" <= :endDate
AND t1."deletedAt" IS NULL
AND (
  pm."service" = 'stripe'
  OR spm.service = 'stripe'
)
GROUP BY t1."hostCurrency"`,
    {
      replacements: { HostCollectiveId: host.id, ...computeDates(startDate, endDate) },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(results, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  if (total != 0) {
    total = -total;
  }

  const plan = await host.getPlan();
  const hostFeeSharePercent = plan.hostFeeSharePercent || 0;

  return Math.round((total * hostFeeSharePercent) / 100);
}
