const { z } = require('zod');

const competitions = z.object({
  query: z.object({
    grade: z.string().optional(),
    subject: z.string().optional(),
    status: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional()
  })
});

const competitionsSearch = z.object({
  query: z.object({
    q: z.string().min(1),
    grade: z.string().optional(),
    subject: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional()
  })
});

const competitionDetail = z.object({
  params: z.object({ id: z.string() })
});

const contact = z.object({
  body: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    subject: z.string().min(1),
    message: z.string().min(1)
  })
});

module.exports = { competitions, competitionsSearch, competitionDetail, contact };
