const { z } = require('zod');

const updateProfile = z.object({
  body: z.object({
    city: z.string().optional(),
    whatsappNumber: z.string().optional()
  })
});

const setPassword = z.object({
  body: z.object({
    newPassword: z.string().min(6, 'Password must be at least 6 characters')
  })
});

const completeProfile = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    class: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 12, {
        message: 'Grade must be a number between 1 and 12'
      }),
    schoolName: z.string().trim().optional().nullable(),
    city: z.string().trim().min(1, 'City is required'),
    whatsappNumber: z
      .string()
      .trim()
      .min(1, 'WhatsApp number is required')
      .regex(/^\+?[0-9]{7,15}$/, 'Invalid WhatsApp number'),
    country: z.string().trim().optional().nullable()
  })
});

const joinCompetition = z.object({
  params: z.object({
    id: z.string().min(1)
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

module.exports = { updateProfile, setPassword, completeProfile, joinCompetition, availableCompetitions };
