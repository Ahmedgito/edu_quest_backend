const { z } = require('zod');

const idParam = z.object({ params: z.object({ id: z.string().uuid() }) });

/**
 * Contest identity artwork an admin may attach to a competition. Kept as an
 * allow-list so only known slugs reach the database; mirrors CONTEST_LOGOS in
 * the client's utils/competitionDisplay.
 */
const CONTEST_LOGOS = ['numerava', 'lexivara', 'scivara', 'solvena', 'innovair', 'creonia'];

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

const timeToMinutes = (time) => {
  if (!time || typeof time !== 'string' || !timeRegex.test(time)) return null;
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

const competitionCreate = z.object({
  body: z.object({
    code: z.string().trim().min(2),
    title: z.string().trim().min(2),
    description: z.string().optional(),
    grade: z.string().min(1).optional(),
    gradeMin: z.coerce.number().int().min(1).max(12).optional(),
    gradeMax: z.coerce.number().int().min(1).max(12).optional(),
    subjects: z.array(z.string().trim().min(1)).min(1, 'At least one subject is required'),
    startDate: z.string().date('startDate must be YYYY-MM-DD'),
    startTime: z.string().regex(timeRegex, 'startTime must be HH:mm'),
    endTime: z.string().regex(timeRegex, 'endTime must be HH:mm'),
    venue: z.string().trim().min(2, 'venue is required'),
    fee: z.coerce.number().min(0, 'fee must be >= 0').optional(),
    registrationDeadline: z.string().date('registrationDeadline must be YYYY-MM-DD'),
    duration: z.string().trim().min(1, 'duration is required'),
    logo: z.enum(CONTEST_LOGOS).nullish(),
    status: z.enum(['active','inactive','closed']).optional()
  })
    .superRefine((val, ctx) => {
      const hasRange = val.gradeMin !== undefined || val.gradeMax !== undefined;
      if (hasRange) {
        if (val.gradeMin === undefined || val.gradeMax === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gradeMin'], message: 'gradeMin and gradeMax are required together' });
          return;
        }
        if (val.gradeMin > val.gradeMax) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gradeMin'], message: 'gradeMin must be <= gradeMax' });
          return;
        }
      } else if (!val.grade) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['grade'], message: 'grade is required' });
      }

      const startMinutes = timeToMinutes(val.startTime);
      const endMinutes = timeToMinutes(val.endTime);
      if (startMinutes === null || endMinutes === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'Invalid competition time' });
      } else if (endMinutes <= startMinutes) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'endTime must be after startTime' });
      }

      const startDate = new Date(`${val.startDate}T00:00:00.000Z`);
      const deadline = new Date(`${val.registrationDeadline}T00:00:00.000Z`);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(deadline.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registrationDeadline'], message: 'Invalid dates provided' });
      } else if (deadline > startDate) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registrationDeadline'], message: 'registrationDeadline cannot be after startDate' });
      }
    })
});

const competitionUpdate = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    code: z.string().trim().min(2).optional(),
    title: z.string().trim().min(2).optional(),
    description: z.string().optional(),
    grade: z.string().min(1).optional(),
    gradeMin: z.coerce.number().int().min(1).max(12).optional(),
    gradeMax: z.coerce.number().int().min(1).max(12).optional(),
    subjects: z.array(z.string().trim().min(1)).optional(),
    startDate: z.string().date('startDate must be YYYY-MM-DD').optional(),
    startTime: z.string().regex(timeRegex, 'startTime must be HH:mm').optional(),
    endTime: z.string().regex(timeRegex, 'endTime must be HH:mm').optional(),
    venue: z.string().trim().min(2).optional(),
    fee: z.coerce.number().min(0, 'fee must be >= 0').optional(),
    registrationDeadline: z.string().date('registrationDeadline must be YYYY-MM-DD').optional(),
    duration: z.string().trim().min(1).optional(),
    logo: z.enum(CONTEST_LOGOS).nullish(),
    status: z.enum(['active','inactive','closed']).optional()
  })
    .superRefine((val, ctx) => {
      const hasRange = val.gradeMin !== undefined || val.gradeMax !== undefined;
      if (hasRange) {
        if (val.gradeMin === undefined || val.gradeMax === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gradeMin'], message: 'gradeMin and gradeMax are required together' });
          return;
        }
        if (val.gradeMin > val.gradeMax) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gradeMin'], message: 'gradeMin must be <= gradeMax' });
        }
      }

      if (Array.isArray(val.subjects) && val.subjects.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subjects'], message: 'At least one subject is required' });
      }

      if (val.startTime && val.endTime) {
        const startMinutes = timeToMinutes(val.startTime);
        const endMinutes = timeToMinutes(val.endTime);
        if (startMinutes === null || endMinutes === null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['startTime'], message: 'Invalid competition time' });
        } else if (endMinutes <= startMinutes) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endTime'], message: 'endTime must be after startTime' });
        }
      }

      if (val.startDate && val.registrationDeadline) {
        const startDate = new Date(`${val.startDate}T00:00:00.000Z`);
        const deadline = new Date(`${val.registrationDeadline}T00:00:00.000Z`);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(deadline.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registrationDeadline'], message: 'Invalid dates provided' });
        } else if (deadline > startDate) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registrationDeadline'], message: 'registrationDeadline cannot be after startDate' });
        }
      }
    })
});

const participants = z.object({
  params: z.object({ id: z.string().uuid(), studentId: z.string().uuid().optional() })
});

const sendCertificates = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.preprocess(
    (data) => (data && typeof data === 'object' ? data : {}),
    z.object({
      studentIds: z.array(z.string().uuid()).optional(),
      // 'winners' = podium only, 'participation' = everyone without a podium
      scope: z.enum(['all', 'winners', 'participation']).optional(),
      resend: z.boolean().optional()
    })
  )
});

const setWinners = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.preprocess(
    (data) => (data && typeof data === 'object' ? data : {}),
    z.object({
      // null / omitted clears the position
      first: z.string().uuid('first must be a student id').nullable().optional(),
      second: z.string().uuid('second must be a student id').nullable().optional(),
      third: z.string().uuid('third must be a student id').nullable().optional()
    })
  )
});

const announcementUpdate = z.object({
  body: z.object({
    enabled: z.boolean().optional(),
    heading: z.string().trim().min(1, 'heading is required').max(120).optional(),
    // null = feature the next upcoming competition automatically
    competitionId: z.string().uuid('competitionId must be a competition id').nullable().optional(),
    ctaLabel: z.string().trim().min(1, 'Button label is required').max(60).optional()
  })
});

module.exports = {
  idParam,
  competitionCreate,
  competitionUpdate,
  participants,
  sendCertificates,
  setWinners,
  announcementUpdate
};
