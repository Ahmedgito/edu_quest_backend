const { z } = require('zod');

const updateProfile = z.object({
  body: z.object({
    city: z.string().optional(),
    whatsappNumber: z.string().optional()
  })
});

const joinCompetition = z.object({
  params: z.object({
    id: z.string().uuid()
  })
});

const availableCompetitions = z.object({
  query: z.object({
    search: z.string().optional(),
    subject: z.string().optional(),
    page: z.string().optional(),
    limit: z.string().optional()
  })
});

module.exports = { updateProfile, joinCompetition, availableCompetitions };
