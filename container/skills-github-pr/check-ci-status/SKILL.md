---
name: check-ci-status
description: Check CI status on the current PR. If checks are failing, investigate the failure, diagnose the root cause, and attempt a fix. Use when the user asks about CI, checks, or runs /check-ci-status.
---

# /check-ci-status — Check and Fix CI Failures

Check the CI status of the current PR and fix any failures.

## Step 1: Identify the PR

Read `CLAUDE.md` in the workspace to find the PR number and repository. Look for fields like:
- Issue/PR identifier
- Repository (e.g. `cmraible/seb`)

If you can't determine the PR, ask the user.

## Step 2: Check CI status

```bash
gh pr checks <number> --repo <owner>/<repo>
```

If all checks are passing, report success and stop.

## Step 3: Investigate failures

For each failing check:

```bash
gh run view <run-id> --repo <owner>/<repo> --log-failed
```

Read the logs carefully. Common failures include:
- Lint/format errors
- Type errors
- Test failures
- Build failures

## Step 4: Fix the issue

1. Clone the repo if not already cloned
2. Check out the PR branch
3. Make the fix
4. Commit and push

```bash
cd /tmp
gh repo clone <owner>/<repo> ci-fix -- --depth=50
cd ci-fix
gh pr checkout <number>
# ... make fixes ...
git add <files>
git commit -m "fix: resolve CI failure"
git push
```

## Step 5: Report

Tell the user what failed and what you fixed. If you couldn't fix it automatically, explain the failure and suggest next steps.
