const { z } = require('zod');

// Multipart upload — the file itself is validated by multer, not zod.
const bulkUpload = z.object({});

const listStudents = z.object({
  query: z.object({
    search: z.string().optional(),
    status: z.enum(['active', 'pending', 'disabled']).optional(),
    grade: z.string().optional()
  })
});

module.exports = { bulkUpload, listStudents };
