# Project briefing ("Catch me up") and the Moontech ticket source — Design

Date: 2026-11-25. Status: approach A chosen by the owner; mockups approved
(`.claude/quorum/artifacts/project-briefing-mockups.html`, local, not committed).

## Intent

The owner works for 3 to 5 remote employers at once, each with several projects, tickets and people. Quorum exists
to make that load manageable, and the ticket system is part of it. The hardest moment is switching back to a project
after days in another job.

The owner asked for help remembering context per project. The context is **for the owner**, not for Claude: they
want to be up to date in about 30 seconds. The unit is the **project**, for example Moonchat or Atlas, not the
whole employer.

## Goals

1. **The briefing.** A briefing at the top of every project page, on desktop (the centre pane) and on the phone, with
   six sections in this order:
   - **Where you left off.** At most 3 sentences, written by Haiku from the project's latest sessions and the owner's
     open tickets. It is labelled "Written by Haiku from your last N sessions · not a source of truth".
   - **New since you were here.** Data only:
     - sessions that finished or ended since the last visit;
     - tickets newly assigned to the owner, or tickets of the owner's that changed status;
     - new meeting notes for the project.
     Each item has a time and a one-line detail.
   - **Your tickets.** The owner's open tickets for the project, with status and planned dates. Overdue ones are
     highlighted.
   - **From meetings.** Decisions, open points and the owner's actions, taken from meeting notes from the last 14 days
     that belong to the project.
   - **Pinned notes.** Short free-text notes the owner pins to a project. They can be added and removed, and are
     stored by the hub, so every device sees them.
   - **Sessions.** The project's sessions, plus two buttons:
     - **New session**, the existing launch.
     - **Continue where I left off**: a new session whose first prompt is a compact text version of the briefing,
       which the owner can edit before sending.
2. **The Moontech ticket source.** A read-only connector for Moontech's admin site (the `moontecx-admin` app).
   - It reads tickets, people and meeting notes through the site's JSON API, after logging in.
   - Each Quorum project gets a filter, set once in its connector settings:
     - **product**, for example Moontecx or MUVO;
     - an optional **title prefix**, for example "Atlas";
     - **you are**: the person name used for "your tickets", here `Adrian`.
3. **Last visit per project.** The hub records when the owner last looked at a project. "New since" is computed from
   the previous visit.

## Non-goals

- Writing back to the Moontech ticket system: no comments, no status changes.
- The Flightdeck-style session panel. It is a separate, later plan.
- Multi-user support. Quorum stays single-owner, so "you" is one configured person per ticket source.
- Briefings per employer.

## Anti-goals

- **Quota.** The briefing must not burn Claude quota.
  - The Haiku paragraph is regenerated only when its inputs change, at most once per 10 minutes per project, and
    through the existing summary path (ccapi / Haiku, quota-guarded).
  - Everything else is plain data.
- **Leaking credentials.** Ticket-system credentials are never stored in the repo or logs, and never sent to the app.
- **Inventing facts.** Every line except "Where you left off" comes from stored data, and that paragraph is labelled
  as generated.

## Approaches (owner chose A)

| Approach | Trade-off |
|---|---|
| **A. Hub-built briefing: data sections + one Haiku paragraph** | Reliable, cheap, and the same on every device. **Chosen.** |
| B. Data only | Free, but the owner has to piece "where I left off" together themselves. |
| C. Claude writes a `BRIEF.md` in the repo | Serves Claude more than the owner, and depends on sessions running. |

## Design

### Hub

**Store:**
- `project_visits(project_id PRIMARY KEY, seen_at, prev_seen_at)`.
- `pinned_notes(id, project_id, text ≤ 500 chars, created_at)`.
- `meeting_notes(source_id, project_id, external_id, title, date, summary, decisions, open_points, actions, url,
  updated_at)`, with a unique key on `(project_id, external_id)`.
- The existing ticket table gains these fields:
  - `plannedStart` and `plannedEnd` (Unix ms, optional);
  - `noteTitle`, the meeting a ticket came from (optional);
  - `assignee`, which already exists and holds the person's name.

  Add them to `proto.Ticket` as optional, omitempty fields.

**Endpoints:**
- `GET /api/projects/{id}/briefing` returns
  `{whereLeftOff:{text, at, sessions:int} | null, newSince:[{kind, title, detail, at, ref}],
  myTickets:[Ticket], meetings:{decisions:[Item], openPoints:[Item], actions:[Item]}, pinned:[{id, text, at}],
  sessions:[SessionInfo], seenAt, prevSeenAt}`.
  - An `Item` is `{text, noteTitle, date}`.
  - `newSince` covers the time since `prevSeenAt`.
- `POST /api/projects/{id}/visit` records a visit.
  - It moves `seen_at` to `prev_seen_at` only when the last visit is more than 30 minutes old, so the "new since"
    view stays stable while the owner is working.
  - The app calls it when a project page has been open for 5 seconds.
- `POST /api/projects/{id}/pinned {text}` and `DELETE /api/projects/{id}/pinned/{noteId}`.
- All of these are device-auth routes.

**"Where you left off":**
- Extend the existing summary package with a per-project "where you left off" text.
- Inputs: the recaps and last assistant answers of the project's 3 most recent sessions (excerpts capped at about 600
  characters each), plus the titles of the owner's open tickets.
- Output: at most 3 sentences, in the language the sessions use, the same rule as today's project summaries.
- It is regenerated when a session of the project ends or the owner's tickets change, debounced, at most once per 10
  minutes per project.
- It is cached in the store and served as is.

**Briefing updates:** they are pushed to apps as a `project_briefing_changed {projectId}` envelope, so an open page
refetches.

### Moontech connector (`kind: "moontech"`)

**Settings:**
- `baseUrl` (default `https://moontecx-admin.pages.dev`), `product`, `titlePrefix` (optional), `person`.
- `username` (not secret). The password is the connector's secret (see Credentials).

**Login:**
- `POST {baseUrl}/api/auth/login` with the username and password. The builder confirms the exact body field names
  from the site's login form or its JS bundle.
- It keeps the session cookie in memory only and logs in again on a 401.

**Reads:**
- `GET /api/tickets`. Fields: `id, title, detail, track, status, person_id, person_name, note_id, note_title,
  note_summary, product, action_key, planned_start, planned_end, started_at, completed_at, closed_at, closing_note,
  created_at, updated_at`.
- `GET /api/notes`. Fields: `id, title, body, kind, meeting_date, summary, decisions, open_points, actions, status,
  products, source_url, notion_url, created_at, updated_at`. `decisions`, `open_points` and `actions` are text with
  one `- ` bullet per line.
- `GET /api/people`.

**Filters:**
- A ticket belongs to the project when `product == settings.product` and, if set, the title starts with
  `titlePrefix` (case-insensitive, trimmed).
- A meeting note belongs when its `products` contains the product and, if `titlePrefix` is set, its title, summary,
  decisions, open points or actions mention the prefix.
- "Your" tickets are those with `person_name == person`. "Your actions" are action bullets that start with
  `<person>:`.

**Status map:** `por_hacer`→todo, `en_curso`→in_progress, `hecho`→done, `aparcado`→blocked (raw status kept for
display as "Parked").

**Read-only:** `Comment` and `SetStatus` return a "read-only source" error, and the app hides the write-back UI for
this kind.

**Credentials:**
- The connector's secret is stored with the existing write-only connector secret (the one GitHub and Paperclip
  tokens use), which is never returned to apps.
- The owner can instead provide it through whoas on the hub host when that works with the workspace's
  `WHOAS_PROFILE`. The builder checks what whoas exposes there. Without a whoas path, the hub secret is used.
- It is never logged; errors are redacted, as the existing connectors do.

**Sync:** the existing periodic syncer, with the same interval setting.

### App

- **Project page.** The briefing sits at the top of the project page (`Project.tsx`), in the section order of the
  mockup, built with shadcn and AI Elements components and the semantic tokens.
  - Desktop shows two columns: "Where you left off" and "New since" on the left, "Your tickets" on the right. Then
    "From meetings" and "Pinned notes" side by side, then "Sessions". The phone shows one column.
  - Empty sections are hidden.
  - With no ticket source configured, the page shows a one-line hint, "Connect a ticket source to see your tickets
    here".
- **"Continue where I left off".** It opens the existing launch dialog with a prefilled first prompt: a compact
  English text of the briefing, about 1,500 characters at most.
- **Connector settings form.** The project's connector form gains a "Moontech" option with these fields: base URL,
  product, title prefix, you are, username, and a password field that is write-only and shows "Saved" once set.
- **Visit tracking.** The project page posts the visit after it has been visible for 5 seconds.

## Constraints

- All repo content in English, with no personal data in committed fixtures. Use made-up products and people in
  tests.
- Real Moontech data and credentials never enter the repo, tests or logs.
- Initial JS stays at 655 kB or less. The briefing lives in the lazily loaded Project page.
- Use semantic tokens only, 44 px touch targets, and no horizontal scroll at 320 px.

## Left to the builder

- The exact login body field names. Confirm them from the site without logging in where possible; the controller can
  do one real check.
- Whether whoas on the hub host can provide the password, and how.
- The debounce implementation, and how the Haiku prompt is worded within the limits above.

## Decisions made after the builder check (designer's calls)

1. **Change log.** A `ticket_changes(project_id, external_id, kind: new|status|assigned, from, to, at)` table is
   written by diffing in the ticket upsert. "New since" uses it, so a detail can read "To do → In progress".
   - A session counts as "finished since" when its last turn end or close time is after `prevSeenAt` and it is not
     working now.
   - A resumed session that is working again only appears in Sessions.
2. **Meeting notes.**
   - **Source:** connectors may implement an optional `NoteLister { ListNotes(ctx) ([]proto.MeetingNote, error) }`.
     The syncer calls it after `List`.
   - **Failure:** a notes failure is logged and leaves the previous notes in place; tickets are still saved.
   - **Schema:** drop `source_id`, because connectors are per project.
3. **Credentials.** The password goes in the existing write-only connector secret slot. The form labels it
   "Password" and shows "Saved" once set. whoas is not used for this connector in v1.
4. **"Where you left off" is a separate cached field** (`where_left_off`, `where_left_off_at`) beside the existing
   project summary, generated through the same quota-guarded path.
   - **Inputs:** the 3 sessions with the latest activity, live ones included, plus the owner's open tickets.
   - **Triggers:** a session of the project ending a turn or closing, or a status or assignee change of one of the
     owner's tickets in the change log. Raw `updated_at` changes do not trigger it. Debounced, at most once per 10
     minutes per project.
   - **No sessions:** the field is null.
5. **Tickets.**
   - Open means not done. Parked (`blocked`) stays open.
   - Overdue means the planned end's calendar day is before today in the device's time zone (the app decides).
   - "You" matches `person_name` trimmed and case-insensitive.
   - Action bullets match lines starting with `<person>:` or `- <person>:`, case-insensitive.
6. **Last visit is global per project** (single owner): a visit on any device counts.
7. **Page layout.**
   - The briefing replaces the summary line at the top of the project page. Board cards keep the summary.
   - The Sessions section wraps the existing `NewSessionCard` and `ProjectSessions`.
   - Two columns when the page's own width is 900 px or more (container query), one column below.
8. **"Continue where I left off".**
   - `LaunchDialog` gets an optional editable `initialPrompt`, prefilled with the briefing text.
   - The machine and folder are those of the project's most recent session; the owner can change them.
   - No ticket is linked.
9. **`project_briefing_changed` events** are sent, coalesced per project over 2 s, when:
   - a sync actually changed something (change-log rows or notes changed);
   - a project session ends a turn or closes;
   - the paragraph is regenerated;
   - a pinned note is added or removed;
   - a visit rolls over.
10. **Notes and projects.** A meeting note may belong to several projects, with one row per project.
