# EduQuest Backend System Design Blueprint

## Purpose
This document captures complete backend-facing requirements inferred from the current frontend implementation in `frontend/src`.  
It is intended to be the single source for designing and implementing the backend system.

## Scope Covered
- Auth and session lifecycle
- Role-based access and dashboard behaviors
- Admin, School, Student, and Public APIs
- Request/response contracts expected by frontend
- Data model expectations implied by UI and Redux state
- Workflow rules (approval, registration, competition joining)
- Error handling and non-functional expectations
- Known mismatches and risk areas to resolve during backend design

---

## 1) Runtime and Integration Context

## Frontend Stack
- Next.js app (`next`), React, Redux Toolkit, `redux-persist`.
- API calls use browser `fetch`.
- Global API base URL from `NEXT_PUBLIC_API_BASE_URL`, fallback:
  - `http://localhost:5000/api/v1`

## Integration Style
- Frontend expects REST JSON APIs (except CSV template download and CSV upload multipart).
- Protected endpoints use:
  - `Authorization: Bearer <token>`
- Default `Content-Type`:
  - `application/json` for JSON bodies
  - multipart for file upload (browser sets boundary)

---

## 2) Roles and Access Model

Frontend recognizes these user types:
- `admin`
- `school`
- `individual`
- `student` (fallback/default in some flows)

Expected protection:
- Admin APIs: admin role only.
- School APIs: school role; frontend docs indicate approved schools only.
- Student APIs: individual/student role.
- Public/Auth APIs: no token required.

Important:
- Frontend routes all protected pages via `ProtectedRoute` (checks only `isAuthenticated`).
- Role-level authorization must be enforced server-side.

---

## 3) Authentication and Session Requirements

## Login/Registration Flows
- Individual registration creates account but does **not** auto-login.
- School registration creates account but requires approval workflow.
- Login returns `user`, `token`, optional `refreshToken`.
- On success, frontend redirects to `/dashboard` and switches dashboard by `user.role`/`user.userType`.

## Session Behavior
- Frontend stores auth state in Redux persisted storage.
- Auto-expiry after 24 hours based on client `loginTime`.
- No explicit backend logout API currently used.
- Refresh token endpoint exists in config/docs; currently not actively used in UI flow.

## Auth Endpoints Required
1. `POST /auth/register-individual`
2. `POST /auth/register-school`
3. `POST /auth/login`
4. `POST /auth/forgot-password`
5. `POST /auth/reset-password`
6. `POST /auth/refresh-token`

---

## 4) Complete API Catalog (Backend Design Target)

## Auth (Public)
1. `POST /v1/auth/register-individual`
2. `POST /v1/auth/register-school`
3. `POST /v1/auth/login`
4. `POST /v1/auth/forgot-password`
5. `POST /v1/auth/reset-password`
6. `POST /v1/auth/refresh-token`

## School (Protected: school)
7. `POST /v1/school/bulk-registration`
8. `GET /v1/school/bulk-registration-template`

## Student (Protected: student/individual)
9. `GET /v1/student/profile`
10. `PUT /v1/student/profile`
11. `GET /v1/student/my-competitions`
12. `GET /v1/student/available-competitions`
13. `POST /v1/student/competition-join/:id`

## Admin (Protected: admin)
14. `GET /v1/admin/dashboard`
15. `GET /v1/admin/schools`
16. `GET /v1/admin/school/:id`
17. `POST /v1/admin/school-approve/:id`
18. `POST /v1/admin/school-reject/:id`
19. `GET /v1/admin/students`
20. `DELETE /v1/admin/student/:id`
21. `POST /v1/admin/competitions`
22. `GET /v1/admin/competitions`
23. `GET /v1/admin/competition/:id`
24. `PUT /v1/admin/competition/:id`
25. `DELETE /v1/admin/competition/:id`
26. `GET /v1/admin/competition-participants/:id`
27. `DELETE /v1/admin/competition-participant/:id/:studentId`

## Public
28. `GET /v1/public/competitions`
29. `GET /v1/public/competitions-search`
30. `GET /v1/public/competition/:id`
31. `POST /v1/public/contact`

---

## 5) Request Contract Details

## 5.1 Auth Payloads

### `POST /auth/register-individual`
Body expected by frontend:
- `email`
- `password`
- `confirmPassword`
- `class`
- `schoolName` (from UI field `school`)
- `whatsappNumber` (from UI field `phone`)
- `country`
- `city`

### `POST /auth/register-school`
Body:
- `coordinatorName` (from UI field `name`)
- `designation`
- `email`
- `password`
- `schoolName`
- `principalName`
- `principalEmail`
- `branchName`
- `city`

### `POST /auth/login`
Body:
- `email`
- `password`

Response expected shape:
- `token`
- optional `refreshToken`
- `user` object with `role` or `userType`

### `POST /auth/forgot-password`
Body:
- `email`

### `POST /auth/reset-password`
Body:
- `email`
- `resetToken`
- `newPassword`

### `POST /auth/refresh-token`
Body likely expected:
- `refreshToken`

---

## 5.2 School Payloads

### `GET /school/bulk-registration-template`
- Returns CSV text content for download.

### `POST /school/bulk-registration`
- multipart/form-data
- file field name: `file`

Frontend expects response fields:
- `success`
- `totalRecords`
- `successfulRegistrations`
- `failedRegistrations`
- optional `errors[]` where each item has:
  - `row`
  - `email`
  - `error`

---

## 5.3 Student Payloads

### `GET /student/profile`
- No query/body.

### `PUT /student/profile`
Body: profile update (frontend comment says phone/city only).

### `GET /student/my-competitions`
- No query/body.

### `GET /student/available-competitions`
Query (optional):
- `search`
- `subject`
- `page`
- `limit`

### `POST /student/competition-join/:id`
- Path: competition id
- No request body currently sent by frontend.

---

## 5.4 Admin Payloads

### `GET /admin/dashboard`
- No query/body.

### `GET /admin/schools`
Query (optional):
- `status`
- `search`
- `page`
- `limit`

### `GET /admin/school/:id`
- Path: school id

### `POST /admin/school-approve/:id`
- Path: school id

### `POST /admin/school-reject/:id`
- Path: school id

### `GET /admin/students`
Query (optional):
- `schoolId`
- `search`
- `grade`
- `page`
- `limit`

### `DELETE /admin/student/:id`
- Path: student id

### `GET /admin/competitions`
Query (optional):
- `status`
- `search`
- `page`
- `limit`

### `POST /admin/competitions`
Body: full competition data (schema defined in section Data Models).

### `GET /admin/competition/:id`
- Path: competition id

### `PUT /admin/competition/:id`
- Path: competition id
- Body: full/partial competition data

### `DELETE /admin/competition/:id`
- Path: competition id

### `GET /admin/competition-participants/:id`
- Path: competition id

### `DELETE /admin/competition-participant/:id/:studentId`
- Path params: competition id + student id

---

## 5.5 Public Payloads

### `GET /public/competitions`
Query (optional):
- `grade`
- `subject`
- `status`
- `page`
- `limit`

### `GET /public/competitions-search`
Query:
- required `q`
- optional `grade`
- optional `subject`
- optional `page`
- optional `limit`

### `GET /public/competition/:id`
- Path: id/code

### `POST /public/contact`
Body expected by current contact form:
- `firstName`
- `lastName`
- `email`
- `phone`
- `subject`
- `message`

---

## 6) Response Shape Expectations

Redux reducers are built to support multiple response formats. Backend should standardize to avoid ambiguity.

## Accepted by frontend currently
For list endpoints, frontend can parse:
- `payload.data.<resourceArray>`
- `payload.data` as array
- direct array
- `payload.<resourceArray>`

For detail endpoints:
- often direct object accepted
- some reducers also accept nested `data`

## Recommended unified backend response
- Success:
  - `{ "success": true, "message": "...", "data": ... }`
- Errors:
  - `{ "success": false, "message": "...", "errors": [...] }`

Why:
- Frontend throws with `data.message` on non-OK responses.
- Consistent `message` is required for proper UI errors.

---

## 7) Data Model Requirements (Inferred)

## 7.1 User (base)
Core fields:
- `id` or `_id`
- `email`
- `role` (`admin`, `school`, `individual`/`student`)
- auth/security fields (hashed password, reset tokens, refresh token metadata)

## 7.2 School profile
Fields inferred:
- `schoolName`
- `coordinatorName`
- `designation`
- `principalName`
- `principalEmail`
- `branchName`
- `city`
- `approved` (boolean)
- optional `status` (`pending`, `approved`, `rejected`)

## 7.3 Student profile
Fields inferred:
- `name` (optional in current individual registration UI; fallback email used in UI)
- `email`
- `class` or `grade`
- `schoolName`
- `city`
- `whatsappNumber`/`phone`
- links to school (if bulk registered)

## 7.4 Competition
Fields used by UI:
- `id` or `_id`
- `code` (used in public detail route links)
- `title` or `name`
- `description`
- `grade` or `gradeLevel`
- `subjects` (array preferred) or `subject`
- `date` or `startDate`
- `time` / `startTime` / `endTime`
- `venue`
- `fee` or `fees`
- `registrationDeadline`
- `duration`
- `participants` or `participantCount`
- `status` and/or `active`

## 7.5 Contact submission
Fields:
- `firstName`, `lastName`, `email`, `phone`, `subject`, `message`
- status workflow for admin response (backend-defined)

## 7.6 Enrollment (student-competition relation)
Required for:
- My competitions list
- Available competitions filtering
- Participant lists
- Remove participant workflow

---

## 8) Core Business Rules Needed

1. School approval gate:
- New school should start pending.
- Unapproved school should be blocked from bulk registration.

2. Student join competition:
- Only authenticated individual/student users can join.
- Prevent duplicate joins.
- Validate competition is open.
- Validate grade eligibility.

3. Available competitions:
- Exclude competitions already joined.
- Exclude closed/inactive competitions.
- Filter by grade and optional search/subject.

4. Admin moderation:
- Approve/reject school and persist status transitions.
- Manage competition lifecycle (create/edit/delete).
- View/remove participants.

5. Bulk registration:
- Parse CSV safely.
- Row-level validation and partial success reporting.
- Return structured errors compatible with frontend display.

---

## 9) Workflow Specifications

## A) Individual signup to competition join
1. Register individual.
2. Login and receive token + role.
3. Open dashboard, fetch profile + competitions.
4. Browse public competitions.
5. Join competition from detail page.
6. Joined competition appears in `my-competitions`.

## B) School onboarding and student bulk import
1. Register school.
2. Admin reviews school and approves.
3. School logs in.
4. School downloads CSV template.
5. School uploads completed CSV.
6. Backend returns summary and per-row errors.

## C) Admin lifecycle
1. Login as admin.
2. Fetch dashboard summary metrics.
3. Manage schools (approve/reject).
4. Manage competitions CRUD.
5. View students and competition participants.
6. Remove student or participant where needed.

---

## 10) Frontend Route to Backend Dependency Map

- `/register` -> register individual/school APIs
- `/login` -> login API
- `/forgot-password` -> forgot-password API
- `/reset-password` -> reset-password API
- `/dashboard` (role-based):
  - admin -> admin dashboard/schools/students/competitions APIs
  - school -> bulk registration template/upload APIs
  - student/individual -> profile/my competitions/available/join APIs
- `/competitions` -> public list/search APIs
- `/competitions/:id` -> public competition detail + join API
- `/contact` -> public contact API (currently UI-only submission)

---

## 11) Known Inconsistencies and Risks to Resolve

1. Duplicate admin dashboard implementations:
- `src/components/dashboards/AdminDashboard.jsx` uses APIs.
- `src/pages/admin/Dashboard.jsx` is legacy localStorage/mock system.
- Backend design should target API-driven dashboard; legacy should be retired.

2. Parameter naming mismatch in docs:
- One generated `routes.json` path uses `:student-id`, while service expects `:studentId`.
- Standardize backend path variable naming and keep API docs aligned.

3. Response format variability:
- Reducers currently accept many shapes due to inconsistency.
- Standardize backend response contract.

4. Contact form currently not integrated:
- UI only logs and alerts; backend endpoint exists in service layer.

5. Token refresh not wired:
- Endpoint exists but frontend does not auto-refresh currently.

6. Missing export dependency:
- `src/services/index.js` exports `tokenService` but file is absent.
- Non-blocking for backend design, but indicates integration debt.

---

## 12) Security and Validation Requirements

- JWT validation for all protected APIs.
- Role-based authorization at endpoint level.
- Server-side input validation for all request payloads.
- CSV upload safeguards:
  - file type/content validation
  - size limits
  - malicious payload handling
- Password policies and secure reset-token expiry.
- Rate limiting:
  - login
  - forgot password
  - public contact
- Audit logs for admin actions (approve/reject/delete/update).

---

## 13) Pagination, Filtering, and Search Standard

Use consistent query params:
- `page` (default 1)
- `limit` (default 10/20)
- `search` where relevant
- domain-specific filters (`status`, `grade`, `subject`, `schoolId`)

Recommended response wrapper:
- `data.items`
- `data.pagination` (`page`, `limit`, `total`, `totalPages`)

This will support current UI and future scalable list rendering.

---

## 14) Suggested Database Entity Set

Minimum entities:
- `users`
- `schools`
- `students` (or user subtype)
- `competitions`
- `competition_participants`
- `contact_messages`
- `password_reset_tokens`
- optional `refresh_tokens`

Key relationships:
- school -> many students
- competition <-> students (many-to-many via participants)
- school users have approval status

---

## 15) Testing Matrix for Backend Completion

## Auth
- Register individual success/failure validation.
- Register school sets pending status.
- Login returns role and tokens.
- Forgot/reset password end-to-end.

## Admin
- Dashboard metrics accuracy.
- School approval/rejection and state persistence.
- Student list filtering and deletion.
- Competition CRUD full lifecycle.
- Participants list and removal.

## School
- Template download content and format.
- CSV upload partial success and row errors.
- Approval gate enforcement.

## Student/Public
- Public competitions list/search/detail.
- Available competitions filtered by grade and not joined.
- Join flow idempotency and closed competition blocking.
- My competitions sync after join.

---

## 16) Implementation Priority (Backend)

Phase 1 (Critical path):
1. Auth endpoints
2. School approval endpoints
3. Admin competition CRUD
4. Student join + list endpoints
5. Public competitions list/detail/search

Phase 2:
1. Bulk CSV robust processing and reporting
2. Contact form persistence/notifications
3. Refresh-token rotation and session hardening

Phase 3:
1. Reporting/analytics
2. Certificate workflows
3. Notification/event system

---

## 17) Final Backend Contract Recommendation

Adopt:
- Versioned prefix: `/api/v1`
- Uniform success/error envelope
- Strict role middleware
- Consistent naming (`studentId`, not mixed conventions)
- Stable competition schema (`title`, `code`, `grade`, `subjects`, `date`, `status`, etc.)
- Backward compatibility layer if frontend still sends legacy field names

This will satisfy current frontend behavior while enabling clean long-term backend evolution.

