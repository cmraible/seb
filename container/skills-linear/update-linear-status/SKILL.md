---
name: update-linear-status
description: Update the Linear issue status after completing work. Syncs the issue state based on what was accomplished. Use when the user asks to update Linear or runs /update-linear-status.
---

# /update-linear-status — Update Linear Issue Status

Update the Linear issue associated with this group based on work completed.

## Step 1: Identify the issue

Read `CLAUDE.md` in the workspace to find the Linear issue identifier (e.g. `CHR-86`).

## Step 2: Check current status

Use the Linear MCP tools to get the current issue state:

```
mcp__linear__get_issue({ id: "<issue-identifier>" })
```

## Step 3: Assess what was done

Review recent activity to determine what was accomplished:
- Was a PR created? → Status should be "In Review"
- Was research completed? → Add a summary comment
- Was a task completed without a PR? → Status may be "Done"
- Is work still in progress? → Keep current status, add progress comment

## Step 4: Update the issue

Update status if appropriate:

```
mcp__linear__save_issue({ id: "<issue-identifier>", state: "<new-status>" })
```

Add a comment summarizing what was done:

```
mcp__linear__save_comment({ issueId: "<issue-identifier>", body: "Summary of work..." })
```

## Step 5: Report

Tell the user what status the issue was updated to and what comment was added.

_Note: If a PR was linked to the issue, Linear may automatically transition the status. Check before making redundant updates._
