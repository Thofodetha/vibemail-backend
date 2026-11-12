---
description: Verify the current build unit (typecheck, tests, file scope). Reports only; fixes nothing.
argument-hint: "[unit number 1-7]"
allowed-tools: Bash(npx tsc --noEmit:*), Bash(npm test:*), Bash(git diff --name-only:*), Bash(git ls-files --others --exclude-standard:*), Read
---

# Verify build unit

You are running a **read-only verification**. Report results only.

**Do not fix anything.** Do not edit, create, move or delete any file. Do not install packages, change config, retry with different flags to make a check pass, or suggest code changes beyond naming what failed. If a check fails, record the failure and keep going: run all three checks even if an earlier one fails.

The unit under verification is `$ARGUMENTS`. If it is empty, read `build_sequence.md`, infer the current unit from the changed files (Check 3), and say which unit you assumed and why. If you cannot tell, report the scope check as UNKNOWN and treat it as a failure.

## Check 1: Typecheck

Run `npx tsc --noEmit`.

- Exit code 0: PASS.
- Non-zero: FAIL. List every type error as `file:line  TSxxxx  message`.

## Check 2: Tests

Run `npm test`.

Report:
- **Passed** count, **failed** count, **skipped** count and suites run (from the Jest summary lines `Tests:` and `Test Suites:`).
- For every failing test: its full name and the failure message.
- If the script is missing, Jest has no config, or no tests were found, that is a FAIL. Quote the error.

PASS only if the exit code is 0, at least one test ran, failed = 0, and skipped = 0 (the project rule is no skipped tests, `CONTRACT.md` AC-15).

## Check 3: Modified files and scope

Run `git diff --name-only`. It lists tracked files changed since the last commit but not new untracked files, so also run `git ls-files --others --exclude-standard` and list those separately as "new, untracked".

Compare every file against the expected scope for the unit (from `build_sequence.md` and the layout in `CLAUDE.md`). Paths are globs relative to the repo root.

| Unit | Expected scope |
|---|---|
| 1. Provider abstraction interface | `src/providers/**`, `src/types/**`, `tests/unit/**` |
| 2. Gmail OAuth layer, token persistence | `src/providers/gmail/**`, `src/db/**`, `src/middleware/**`, `src/types/**`, `tests/unit/**` |
| 3. Sync and read layer | `src/sync/**`, `src/providers/**`, `src/db/**`, `src/types/**`, `tests/unit/**` |
| 4. Pub/Sub webhook receiver | `src/webhook/**`, `src/sync/**`, `src/types/**`, `tests/unit/**` |
| 5. Send layer | `src/send/**`, `src/providers/**`, `src/types/**`, `tests/unit/**` |
| 6. Vercel API function entry points | `api/**`, `src/middleware/**`, `vercel.json`, `vercel.ts`, `tsconfig.json`, `tests/unit/**` |
| 7. Integration tests | `tests/integration/**`, `tests/unit/**` |

Allowed in every unit, but still listed under "shared config" so the user sees them: `package.json`, `package-lock.json`, `tsconfig.json`, `jest.config.*`.

Never expected in any unit, always flag as OUT OF SCOPE:
- `migrations/**` and top-level `types/**`: owned by the schema session.
- `CONTRACT.md`, `CLAUDE.md`, `build_sequence.md`: planning documents.
- `.env*`, and any file that looks like it contains a secret.
- Anything under `src/` or `api/` that belongs to a different unit than the one being verified.

Check 3 PASSES only if there are no out-of-scope files. Shared config files do not fail it.

## Report format

Print exactly this structure, then stop:

```
Unit: <number and name>   (assumed | given)

Check 1  tsc --noEmit    PASS | FAIL
  <type errors, if any>

Check 2  npm test        PASS | FAIL
  passed: N   failed: N   skipped: N   suites: N
  <failure names and messages, if any>

Check 3  file scope      PASS | FAIL
  in scope:        <files>
  shared config:   <files>
  OUT OF SCOPE:    <files, each with the reason>
  new, untracked:  <files>

UNIT VERIFIED
```

The last line is `UNIT VERIFIED` if all three checks passed with no out-of-scope files. Otherwise it is `UNIT FAILED`, followed by one bullet per specific failure (check number, what failed, which file or test). Add nothing after it: no fixes, no advice, no offer to continue.
