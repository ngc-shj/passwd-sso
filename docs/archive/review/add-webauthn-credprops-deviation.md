# Coding Deviation Log: add-webauthn-credprops
Created: 2026-03-16

## Deviations from Plan

### DEV-1: Prisma Client regeneration required before build
- **Plan description**: Step 1 mentions running `npm run db:migrate`
- **Actual implementation**: `npx prisma generate` was run instead (migration requires DB connection); the `discoverable` column will be created when `npm run db:migrate` is run in an environment with database access
- **Reason**: Dev environment may not have DB running; Prisma Client type generation is sufficient for build
- **Impact scope**: Deployment workflow — migration must be run before first use

No other deviations.
