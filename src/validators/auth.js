const { z } = require('zod');

const registerIndividual = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6),
    confirmPassword: z.string().min(6),
    class: z.string().min(1),
    schoolName: z.string().optional().nullable(),
    whatsappNumber: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    city: z.string().optional().nullable()
  }).refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  })
});

const registerSchool = z.object({
  body: z.object({
    coordinatorName: z.string().min(1),
    designation: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(6),
    schoolName: z.string().min(1),
    principalName: z.string().min(1),
    principalEmail: z.string().email(),
    branchName: z.string().min(1),
    city: z.string().min(1)
  })
});

const login = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(6)
  })
});

const forgotPassword = z.object({
  body: z.object({
    email: z.string().email()
  })
});

const resetPassword = z.object({
  body: z.object({
    email: z.string().email(),
    resetToken: z.string().min(10),
    newPassword: z.string().min(6)
  })
});

const refreshToken = z.object({
  body: z.object({
    refreshToken: z.string().min(10)
  })
});

module.exports = {
  registerIndividual,
  registerSchool,
  login,
  forgotPassword,
  resetPassword,
  refreshToken
};
