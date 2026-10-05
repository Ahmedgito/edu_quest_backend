const { z } = require('zod');

const MAX_STUDENTS_PER_SAVE = 200;

// Letters (any script), spaces and the punctuation real names carry.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

const personName = (label) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} is required` })
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(2, `${label} must be at least 2 characters`)
        .max(100, `${label} must be at most 100 characters`)
        .regex(NAME_PATTERN, `${label} may only contain letters, spaces, dots, hyphens and apostrophes`)
    );

const classField = z.coerce
  .number({ invalid_type_error: 'Class must be a number from 1 to 12' })
  .int('Class must be a whole number')
  .min(1, 'Class must be from 1 to 12')
  .max(12, 'Class must be from 1 to 12');

const studentEntry = z.object({
  fullName: personName('Student full name'),
  fatherName: personName('Father name'),
  class: classField
});

const competitionParam = z.object({ id: z.string().min(1, 'Competition is required') });

const listStudents = z.object({
  query: z.object({
    search: z.string().optional(),
    status: z.enum(['school', 'active', 'pending', 'disabled']).optional(),
    grade: z.string().optional()
  })
});

const competitionEntries = z.object({ params: competitionParam });

const addEntries = z.object({
  params: competitionParam,
  body: z.object({
    students: z
      .array(studentEntry)
      .min(1, 'Add at least one student')
      .max(MAX_STUDENTS_PER_SAVE, `Save at most ${MAX_STUDENTS_PER_SAVE} students at a time`)
  })
});

const entryParams = competitionParam.extend({ studentId: z.string().uuid('Invalid student') });

const updateEntry = z.object({
  params: entryParams,
  body: studentEntry
    .partial()
    .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
});

const removeEntry = z.object({ params: entryParams });

module.exports = { listStudents, competitionEntries, addEntries, updateEntry, removeEntry };
