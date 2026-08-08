const { z } = require('zod');

// Payment submissions arrive as multipart/form-data, so every scalar reaches us
// as a string and has to be coerced before it is validated.
const amountField = z.coerce
  .number({ invalid_type_error: 'Amount must be a number' })
  .min(0, 'Amount cannot be negative')
  .max(10000000, 'Amount is unrealistically large');

const idField = z.string().min(1, 'competitionId is required');

const studentPayment = z.object({
  body: z.object({
    competitionId: idField,
    amount: amountField,
    payerNote: z.string().trim().max(500).optional()
  })
});

const schoolPayment = z.object({
  body: z.object({
    competitionId: idField,
    amount: amountField,
    payerNote: z.string().trim().max(500).optional(),
    // Parsed in the controller: multipart carries this as a JSON string or a
    // comma-separated list, so it is only shape-checked here.
    studentIds: z.union([z.string().min(1), z.array(z.string())])
  })
});

const paymentIdParam = z.object({
  params: z.object({ id: z.string().uuid('Invalid payment id') })
});

const rejectPayment = z.object({
  params: z.object({ id: z.string().uuid('Invalid payment id') }),
  body: z.preprocess(
    (data) => (data && typeof data === 'object' ? data : {}),
    z.object({
      reason: z.string().trim().min(3, 'Tell the payer why it was rejected').max(500)
    })
  )
});

const listPayments = z.object({
  query: z.object({
    status: z.enum(['submitted', 'verified', 'rejected']).optional(),
    payerType: z.enum(['student', 'school']).optional(),
    competitionId: z.string().uuid().optional(),
    schoolId: z.string().uuid().optional(),
    search: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional()
  })
});

const payableStudents = z.object({
  query: z.object({
    competitionId: z.string().uuid().optional()
  })
});

const updateSettings = z.object({
  body: z.object({
    bankName: z.string().trim().max(120).optional(),
    accountTitle: z.string().trim().max(120).optional(),
    accountNumber: z.string().trim().max(60).optional(),
    iban: z.string().trim().max(60).optional(),
    branch: z.string().trim().max(120).optional(),
    currency: z.string().trim().max(10).optional(),
    instructions: z.string().trim().max(2000).optional()
  })
});

module.exports = {
  studentPayment,
  schoolPayment,
  paymentIdParam,
  rejectPayment,
  listPayments,
  payableStudents,
  updateSettings
};
