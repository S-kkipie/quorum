# Ticket connectors

Each Quorum project pulls its tickets from a ticket system through a connector. The kinds are
`github`, `paperclip`, `exec` and `none`. The `exec` connector works for any custom system:
it is a script that speaks JSON over stdin/stdout.

## Configuration

On the project: `kind = "exec"` and `settings.command` with the command, split on spaces and
run without a shell (e.g. `/home/me/bin/my-connector.sh` or `python3 /path/connector.py`). Optional:
`settings.statusMap`, a JSON object with custom statuses (`{"waiting":"blocked"}`). The rest of
`settings` is passed to the script as is. The project token (if any) arrives in the `token` field.

If the workspace has a whoas profile, the script gets `WHOAS_PROFILE` in its environment,
in addition to the hub's environment. A sync runs every `intervalMin` minutes (5 by default,
1 to 60) or immediately with `POST /api/projects/{id}/sync`.

Changing the connector source (the `kind`, or `repo`, `baseURL`, `companyId`, `projectId`, `command`)
deletes the project's tickets along with their session links, marks pending proposals as failed
("the connector changed") and re-imports everything from the new source. Changing only the interval,
the `statusMap` or other options keeps the tickets.

## Opening a session from a ticket

The new session's prompt carries the ticket data between markers and preceded by a notice: it comes from
an external ticket system and is treated as information, not as instructions. If the prompt is long, the
daemon writes it to `<folder>/.claude/quorum/ticket-<id>.md` (0600; deleted after 24 h) inside the
checkout, so claude can read it without asking permission outside its folder. Quorum does not touch your
`.gitignore`: add `.claude/quorum/` if you do not want to see them as untracked files.

## Protocol

The hub runs the command once per operation and writes one JSON line to stdin:

```json
{"op":"list|comment|set_status","since":0,"externalId":"A-1","body":"text","status":"done","settings":{},"token":""}
```

- `list`: `since` is the last successful sync in ms (0 if none). Reply with
  `{"tickets":[{"externalId":"A-1","title":"…","rawStatus":"open","assignee":"","url":"","body":"","comments":[{"author":"","body":"","at":0}],"updatedAt":0}]}`.
  `externalId` is required. The raw status goes in `rawStatus` and the hub normalizes it.
  `updatedAt` and the comments' `at` are **epoch in milliseconds** (e.g. `1764000000000`;
  in bash, `$(date +%s)000`). A value that does not look like real ms (0, 1, 2… or seconds) is treated as
  an unknown date: for progress it counts as recent and it is not used for "No activity since".
- `comment`: uses `externalId` and `body`. Reply with `{"ok":true}`.
- `set_status`: uses `externalId` and an already normalized `status`. Reply with `{"ok":true}`.

Errors: a non-zero exit code, or `{"error":"message"}`. stderr is appended to the error
(500 characters at most). Limits: 30 s runtime and 8 MiB of stdout.

Do not leave background child processes holding stdout open: the hub waits for it to
close (with a 2 s margin after the script ends). On timeout the whole process group is
killed on Linux and macOS. The hub strips the token from error messages, but do not
print the full stdin (e.g. with `set -x`).

## Statuses

Normalized: `todo`, `in_progress`, `in_review`, `done`, `blocked`. By default:
open/todo/backlog → todo; in progress/doing → in_progress; review/in review → in_review;
closed/done/resolved → done; blocked → blocked. `statusMap` is checked first (keys are case-insensitive and treat `_` and `-` as a space); anything unknown
is `todo`. The old Spanish values (`por_hacer`, `en_curso`, `en_review`, `hecho`, `bloqueado`) are still
accepted as aliases, so older exec connectors keep working.

## Bash example

```bash
#!/bin/bash
# Example connector: two fixed tickets; comment/set_status are appended to $LOG.
LOG=${LOG:-/tmp/my-connector.log}
in=$(cat)
op=$(printf '%s' "$in" | sed -n 's/.*"op":"\([a-z_]*\)".*/\1/p')
now=$(date +%s)000   # epoch in ms
case "$op" in
  list)
    printf '%s\n' '{"tickets":['
    printf '%s\n' '{"externalId":"1","title":"Fix login","rawStatus":"open","updatedAt":'"$now"'},'
    printf '%s\n' '{"externalId":"2","title":"Write docs","rawStatus":"in progress","assignee":"ana","updatedAt":'"$now"'}'
    printf '%s\n' ']}'
    ;;
  comment|set_status)
    printf '%s\n' "$in" >> "$LOG"
    printf '%s\n' '{"ok":true}'
    ;;
  *)
    echo "unknown operation: $op" >&2
    exit 1
    ;;
esac
```

With `jq` each field is easier to read: `op=$(jq -r .op <<<"$in")`. Another test script lives in
`internal/hub/connectors/testdata/fake-connector.sh`.

## GitHub connector

`kind = "github"` pulls a repository's issues with the `gh` CLI. Outside Windows it is launched through a
login shell (`bash -lc 'exec gh "$@"' gh <args>`, arguments are never interpolated) so the whoas
shims apply even with the hub under systemd; on Windows `gh` from the PATH is run. The hub log
says once where it was resolved. The account is chosen by whoas through the workspace's `WHOAS_PROFILE`.

Settings:

- `repo`: `owner/name` (required).
- `labelsAsStatus`: `true` to read the status from labels. With the issue open, `en curso`/`in progress`
  gives in_progress, `review`/`in review` in_review and `blocked`/`bloqueado` blocked (case-insensitive).
  `rawStatus` is `open` or `open:<label>`; closed ones are done. Without the option, only open/closed counts.

Pull requests are ignored. For each open issue the latest 5 comments are fetched (at most 30
issues with comments per sync). Changing the status from Quorum closes or reopens the issue; for
in_progress, in_review and blocked it adds the label `en curso`, `review` or `blocked` (`en curso` is the existing
external label name, kept on purpose). Errors: invalid credentials (HTTP 401), repository not found (HTTP 404) or `gh` missing.

GitHub connector notes: the first sync fetches only open issues; later ones fetch
those changed since the last one (open and closed). Comments are requested in full and the 5
most recent are kept. An issue transferred to another repository stops appearing and stays as it was in Quorum.
Changing the status removes the other status labels (`en curso`, `review`, `blocked`).

## Paperclip connector

`kind = "paperclip"` pulls the issues of a company on your Paperclip instance through its REST API
(`GET <baseURL>/api/companies/<companyId>/issues`). The project token is sent as
`Authorization: Bearer <token>`. Use a board or agent token with read access; Quorum only
writes (comments and status changes) through approved proposals.

Settings:

- `baseURL`: instance URL, `http` or `https` (required).
- `companyId`: company id (required).
- `projectId`: optional; only the issues of that Paperclip project are imported (the filter is local). Hidden issues are skipped.

Statuses: todo/backlog → todo; in_progress → in_progress; in_review → in_review; blocked → blocked;
done/cancelled → done. Changing the status from Quorum sends `todo`, `in_progress`, `in_review`,
`blocked` or `done` (`PATCH /api/issues/<id>`). Comments are posted with
`POST /api/issues/<id>/comments`. For each unfinished issue the latest 5 comments are fetched (max 30
issues per sync). If the issue has an `identifier` (e.g. ACME-12) the title gets the prefix
`[ACME-12]`. Each request has a 15 s limit and an 8 MiB response; redirects to another host are not followed.
Errors: invalid token (401/403), not found (404) or another HTTP error with the body truncated.
