export const meta = {
  name: 'fix-test-type-errors',
  description: 'Fix repo-wide pre-existing tsc errors in test files (root-cause: mock typing), one agent per file',
  phases: [
    { title: 'Fix', detail: 'one agent per test file — fix all tsc errors at root cause' },
    { title: 'Verify', detail: 'full tsc --noEmit, report remaining error count per file' },
  ],
}

// Files with tsc --noEmit errors, passed in via args (array of {file, count}).
// Each agent owns ONE file and fixes every tsc error in it at the root cause.
let files = args
if (typeof files === 'string') files = JSON.parse(files)
if (!Array.isArray(files)) {
  throw new Error('args must be an array of {file,count}; got ' + typeof args + ': ' + JSON.stringify(args).slice(0, 200))
}

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'fixed', 'remainingInFile', 'approach', 'notes'],
  properties: {
    file: { type: 'string' },
    fixed: { type: 'boolean', description: 'true if you believe all tsc errors in this file are resolved' },
    remainingInFile: { type: 'number', description: 'tsc error count you still see in THIS file after your edits' },
    approach: { type: 'string', description: 'one line: how the errors were fixed (e.g. typed the vi.fn mock against the real signature)' },
    notes: { type: 'string', description: 'anything the human should know — structural blockers, a real type bug surfaced, etc. empty string if none' },
  },
}

const FIX_PROMPT = (file, count) => `You are fixing TypeScript type errors in ONE test file in a Next.js 16 + Prisma 7 + Vitest project. The repo has ~314 pre-existing tsc errors across test files; your job is exactly ONE file:

  ${file}   (${count} reported tsc errors)

These errors do not fail CI today (the app's \`tsc --noEmit\` is not yet a gate; vitest does not typecheck), but we are about to make it a gate, so every error must be fixed at the ROOT CAUSE.

Steps:
1. Run \`npx tsc --noEmit 2>&1 | grep '${file}'\` to see this file's exact errors. (Ignore errors in other files — not yours.)
2. Read the file and the real types/modules it references.
3. Fix each error properly. The dominant root cause is under-typed mocks: \`vi.fn(() => ...)\` infers an empty-tuple call signature, so \`mock.calls\` / arguments are typed wrong. Type mocks against the REAL signature: \`vi.fn<typeof realFn>()\`, or type the mocked module with \`vi.mocked()\` / a typed factory. For Prisma client mocks, type against the real delegate types. For React component prop mismatches (TS2739/2322), supply the missing required props or type the mock prop object against the component's Props type.

ABSOLUTE RULES (project policy):
- NEVER suppress: no \`@ts-expect-error\`, no \`@ts-ignore\`, no \`eslint-disable\`, no renaming to \`_\`-prefixed throwaways, no widening to \`any\`. Fix the underlying type.
- Prefer typing the mock to match reality over casting. A localized \`as\` at a single assertion is acceptable only when the value genuinely cannot be expressed (e.g. a partial provider-union member); a blanket \`as any\` is not.
- Do not change the test's BEHAVIOR or assertions — only its types. If removing an assertion would be needed to satisfy types, that's a signal you typed the mock wrong; fix the mock instead.
- Do not edit any file other than ${file} (and only ${file}). If the fix requires a change to production code, DO NOT make it — report it in notes instead.
- Match the surrounding code's existing idioms (this repo uses \`vi.fn<typeof X>()\`, \`vi.mocked()\`, and typed \`vi.hoisted()\` factories elsewhere — grep for examples).

4. Re-run \`npx tsc --noEmit 2>&1 | grep -c '${file}'\` and iterate until it reports 0 for this file (or you hit a genuine structural blocker you must report).
5. If the file has a co-located vitest suite, run it (\`npx vitest run ${file}\`) to confirm you didn't break behavior.

Return the structured result. remainingInFile = the tsc error count you still see in THIS file after your edits (0 if clean).`

phase('Fix')
const results = await pipeline(
  files,
  (f) => agent(FIX_PROMPT(f.file, f.count), {
    label: `fix:${f.file.split('/').pop()}`,
    phase: 'Fix',
    schema: FIX_SCHEMA,
  }),
)

const done = results.filter(Boolean)
const stillDirty = done.filter((r) => r.remainingInFile > 0)
const withNotes = done.filter((r) => r.notes && r.notes.trim().length > 0)

log(`Fix phase done: ${done.length}/${files.length} agents returned; ${stillDirty.length} report remaining errors; ${withNotes.length} left notes`)

phase('Verify')
// One agent runs the FULL tsc once and reports the authoritative remaining count per file.
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['totalRemaining', 'perFile', 'cleanCount'],
  properties: {
    totalRemaining: { type: 'number' },
    cleanCount: { type: 'number', description: 'number of originally-dirty files now at 0 errors' },
    perFile: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'remaining'],
        properties: { file: { type: 'string' }, remaining: { type: 'number' } },
      },
    },
  },
}

const verify = await agent(
  `Run \`npx tsc --noEmit 2>&1 | grep 'error TS'\` for the whole repo. Summarize: total remaining error count, and a per-file breakdown (file path + remaining count) for every file that STILL has at least one error. Also report cleanCount = how many of these originally-dirty files are now at 0:\n${files.map((f) => `  ${f.file} (was ${f.count})`).join('\n')}\nReturn the structured result. Do not edit anything — read-only verification.`,
  { label: 'verify:full-tsc', phase: 'Verify', schema: VERIFY_SCHEMA },
)

return {
  filesProcessed: done.length,
  agentReportedClean: done.length - stillDirty.length,
  authoritative: verify,
  notes: withNotes.map((r) => ({ file: r.file, notes: r.notes, approach: r.approach })),
}
