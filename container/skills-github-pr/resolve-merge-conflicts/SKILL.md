---
name: resolve-merge-conflicts
description: Detect and resolve merge conflicts on the current PR by rebasing onto the base branch. Use when the user asks to fix conflicts or runs /resolve-merge-conflicts.
---

# /resolve-merge-conflicts — Resolve PR Merge Conflicts

Detect and resolve merge conflicts on the current PR.

## Step 1: Identify the PR

Read `CLAUDE.md` in the workspace to find the PR number and repository.

## Step 2: Check for conflicts

```bash
gh pr view <number> --repo <owner>/<repo> --json mergeable,baseRefName,headRefName
```

If the PR is mergeable (no conflicts), report that and stop.

## Step 3: Clone and rebase

```bash
cd /tmp
gh repo clone <owner>/<repo> rebase-work -- --depth=50
cd rebase-work
gh pr checkout <number>
git fetch origin <base-branch>
git rebase origin/<base-branch>
```

## Step 4: Resolve conflicts

When conflicts occur during rebase:

1. Run `git diff --name-only --diff-filter=U` to list conflicted files
2. For each conflicted file, read it and understand both sides
3. Resolve the conflict by choosing the correct combination
4. `git add <file>` after resolving
5. `git rebase --continue`

Repeat until the rebase is complete.

## Step 5: Push

Force-push the rebased branch (this is expected for rebases):

```bash
git push --force-with-lease
```

## Step 6: Report

Comment on the PR summarizing:
- Which files had conflicts
- How each conflict was resolved
- That the branch is now up to date with the base branch
