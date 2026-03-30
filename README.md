# EduQuest Backend

## Tech
- Node.js + Express
- PostgreSQL
- JWT auth
- Zod validation
- bcrypt password hashing

## Setup
1. Create database and update `.env` from `.env.example`.
2. Install dependencies:
   - `npm install`
3. Initialize schema and bootstrap admin user:
   - `npm run db:init`
4. Start server:
   - `npm run dev`

## Environment
See `.env.example` for required values.

## API Base
`/api/v1`

## Notes
- School accounts cannot log in until approved by admin.
- Bulk CSV template columns: `name,email,class,whatsappNumber,city`
- All responses use `{ success, message, data }` or `{ success, message, errors }`.
