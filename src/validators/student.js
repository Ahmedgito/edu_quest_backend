const { z } = require('zod');

const gradeField = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 12, {
    message: 'Grade must be a number between 1 and 12'
  });

const whatsappField = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'Invalid WhatsApp number');

// Every field is optional — the profile screen sends only what changed. Email is
// deliberately absent: it is the login identity and cannot be edited here.
const updateProfile = z.object({
  body: z.object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(120).optional(),
    class: gradeField.optional(),
    schoolName: z.string().trim().max(200).optional().nullable(),
    city: z.string().trim().min(1, 'City cannot be empty').max(120).optional(),
    country: z.string().trim().max(120).optional().nullable(),
    whatsappNumber: whatsappField.optional()
  })
});

const setPassword = z.object({
  body: z.object({
    newPassword: z.string().min(6, 'Password must be at least 6 characters')
  })
});

const changePassword = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required'),
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

module.exports = {
  updateProfile,
  setPassword,
  changePassword,
  completeProfile,
  joinCompetition,
  availableCompetitions
};
