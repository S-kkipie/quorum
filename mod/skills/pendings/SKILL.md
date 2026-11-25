---
name: pendings
description: Use when something must not be forgotten for the current Quorum project, such as a question for the client, a task, or a point to raise, or when the owner says "anota", "recuérdame" or "pendiente". Records it in the project's pending list with the pending_add tool.
---

# Pending items

The project's pending list is the owner's memory for things that must not be forgotten. It lives in Quorum and is
shared by every session of the project. Use these tools:

- `mcp__quorum__pending_add` with `text` (short) and optional `detail` (context)
- `mcp__quorum__pending_list` to see what is open (`status: "all"` includes done items)
- `mcp__quorum__pending_done` with the item `id` and an optional `note`

## When to use

- The owner says "anota", "recuérdame", "pendiente" or similar.
- Something comes up that the owner must not forget for this project: a question for the client, a task, a point to
  raise in a meeting.

## How

- One item per point. Keep `text` short and put the context in `detail`.
- Check `pending_list` first if the item may already exist, and use `pending_done` when the owner says it is resolved.
- Always tell the owner what you added (the tool result says it).

## Never

- Do not use it for your own to-do list or progress notes; use your normal task tools for that.
- Do not add items the owner did not ask for or would not want to be reminded of.
