const { z } = require('zod');

const idParam = z.object({ params: z.object({ id: z.string().uuid() }) });

const competitionCreate = z.object({
  body: z.object({
    code: z.string().min(2),
    title: z.string().min(2),
    description: z.string().optional(),
    grade: z.string().min(1),
    subjects: z.array(z.string()).default([]),
    startDate: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    venue: z.string().optional(),
    fee: z.number().optional(),
    registrationDeadline: z.string().optional(),
    duration: z.string().optional(),
    status: z.enum(['active','inactive','closed']).optional()
  })
});

const competitionUpdate = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    code: z.string().min(2).optional(),
    title: z.string().min(2).optional(),
    description: z.string().optional(),
    grade: z.string().min(1).optional(),
    subjects: z.array(z.string()).optional(),
    startDate: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    venue: z.string().optional(),
    fee: z.number().optional(),
    registrationDeadline: z.string().optional(),
    duration: z.string().optional(),
    status: z.enum(['active','inactive','closed']).optional()
  })
});

const participants = z.object({
  params: z.object({ id: z.string().uuid(), studentId: z.string().uuid().optional() })
});

module.exports = { idParam, competitionCreate, competitionUpdate, participants };
