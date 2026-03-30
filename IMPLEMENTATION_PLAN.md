# Backend Implementation Plan (Node.js + Express + PostgreSQL)

Last updated: 2026-03-30

## Phase 0 - Project Setup
- [x] Initialize backend project (package.json, scripts, env example)
- [x] Create folder structure and base server bootstrapping
- [x] Add core middleware (cors, helmet, logging, error handler)

## Phase 1 - Database & Core Models
- [x] Define PostgreSQL schema (users, schools, students, competitions, participants, contact, tokens)
- [x] Create DB connection utilities and migration/bootstrap script
- [x] Add base data access helpers

## Phase 2 - Auth & Security
- [x] Register individual
- [x] Register school (pending approval)
- [x] Login + JWT issue
- [x] Forgot/reset password flow
- [x] Refresh token flow (basic)
- [x] Auth middleware + role guard

## Phase 3 - Admin APIs
- [x] Admin dashboard metrics
- [x] School approval/rejection
- [x] Competition CRUD
- [x] Student list + delete
- [x] Competition participants list/remove

## Phase 4 - School APIs
- [x] CSV template download
- [x] CSV bulk upload with row-level validation + partial success response

## Phase 5 - Student APIs
- [x] Profile get/update (restricted fields)
- [x] My competitions
- [x] Available competitions (filters)
- [x] Join competition (eligibility + idempotent)

## Phase 6 - Public APIs
- [x] Public competitions list/search/detail
- [x] Contact submission

## Phase 7 - Hardening & Docs
- [x] Rate limiting for sensitive endpoints
- [x] Input validation via Zod across endpoints
- [x] README with setup, env, and API notes

## Phase 8 - Seed Data & Admin Tooling
- [x] Add seed script for demo data (admin, school, students, competitions)
- [ ] Add optional admin-only seed endpoint (if needed)

---

## Progress Log
- 2026-03-30: Plan created. Setup started.
- 2026-03-30: Core backend implemented (DB schema, auth, admin, school, student, public APIs, docs).
- 2026-03-30: Added seed script and npm task.
