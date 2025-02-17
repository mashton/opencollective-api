import { GraphQLEnumType } from 'graphql';

export const ExpenseProcessAction = new GraphQLEnumType({
  name: 'ExpenseProcessAction',
  description: 'All supported expense types',
  values: {
    APPROVE: {
      description: 'To mark the expense as approved',
    },
    UNAPPROVE: {
      description: 'To mark the expense as pending after it has been approved',
    },
    REJECT: {
      description: 'To mark the expense as rejected',
    },
    MARK_AS_UNPAID: {
      description: 'To mark the expense as rejected',
    },
    SCHEDULE_FOR_PAYMENT: {
      description: 'To schedule the expense for payment',
    },
    PAY: {
      description: 'To trigger the payment',
    },
    MARK_AS_SPAM: {
      description: 'To mark the expense as spam',
    },
  },
});
