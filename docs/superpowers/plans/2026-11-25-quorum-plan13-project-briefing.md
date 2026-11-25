# Project briefing and the admin-site ticket source — Implementation Plan (Plan 13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every project page opens with a "catch me up" briefing built from the owner's sessions, tickets, meeting
notes and pinned notes. A read-only admin-site connector brings the employer's tickets and meeting notes into Quorum.

**Architecture:**
- The hub's ticket upsert diffs into a change log. Connectors can optionally list meeting notes. The summary package
  gains a second cached text, "where you left off".
- A briefing endpoint assembles everything for one project, and a coalesced envelope tells open apps to refetch.
- The app renders the briefing at the top of the lazy Project page.

**Tech Stack:** Go (hub, store, connectors, summary), React 19 with shadcn and AI Elements, vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-quorum-project-briefing-design.md`. Read the whole spec, including
"Decisions made after the builder check", which override the body. The mockup is the local file
`.claude/quorum/artifacts/project-briefing-mockups.html`.

## Global Constraints

- All repo content is in English, with no personal data and no real admin-site data. Tests use made-up products and
  people (product `Acme`, people `Ana`, `Ben`).
- Credentials never appear in the repo, tests, logs or app responses. Errors are redacted as in the existing
  connectors.
- **Quota:**
  - "Where you left off" is at most 3 sentences.
  - It is regenerated only on the spec's triggers, at most once per 10 minutes per project.
  - It goes through the existing quota-guarded summary model path.
  - No sessions means null.
- **Read-only:** the admin-site connector's `Comment` and `SetStatus` return an error containing `read-only source`.
- **Visit rollover:** `POST /api/projects/{id}/visit` moves `seen_at` to `prev_seen_at` only when the stored
  `seen_at` is older than 30 minutes. The app posts it after the project page has been visible for 5 s.
- **Meeting window:** meeting items cover notes dated within the last 14 days.
- **Notes:** pinned notes are at most 500 characters.
- **Continue where I left off:** the prompt is at most 1,500 characters.
- **Envelopes:** `project_briefing_changed {projectId}` is coalesced per project over 2 s.
- **Status map:** `por_hacer`→todo, `en_curso`→in_progress, `hecho`→done, `aparcado`→blocked (raw `aparcado` shown
  as "Parked").
- **Layout:**
  - initial JS stays at 655 kB or less;
  - the briefing lives in the lazy Project chunk;
  - semantic tokens only;
  - 44 px touch targets;
  - 320 px works with no horizontal scroll;
  - two columns when the page container is 900 px or wider.
- **Commits:** author and committer are `S-kkipie <139666018+S-kkipie@users.noreply.github.com>`, and messages end
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests:** `go test ./...` (plus `-race` on `internal/hub/...`), `make proto` after proto changes,
  `cd app && npx vitest run`, `npm run build`.
- **Browsers:** subagents never use a browser or any external site. The controller does the single real admin-site
  check.

## Review Focus

1. **A sync where the admin site is down or returns 401 midway.** Tickets and notes keep their previous state,
   there are no phantom "new" items, and the next sync recovers by logging in again.
2. **The first sync of a project, with an empty store.** It must not flood "New since" with every ticket as "new".
   The first sync seeds the log without `new` entries, or marks them before `prevSeenAt`.
3. **Two devices open the same project.** The visit rollover is stable within 30 minutes, and "New since" does not
   empty itself while the owner reads.
4. **A titlePrefix with different case, spacing or punctuation** ("atlas ·", "Atlas:"). Matching is
   case-insensitive on the trimmed prefix. A note mentioning the prefix in its actions counts.
5. **A project with no ticket source, no sessions and no notes.** The page shows only the hint and the Sessions
   section, with no empty cards and no errors.

---

### Task 1: Store — change log, visits, pinned notes, meeting notes, ticket fields

**Files:**
- `internal/proto/proto.go`, then `make proto`.
  - `Ticket` gains `PlannedStart`, `PlannedEnd` (int64, omitempty) and `NoteTitle` (string, omitempty).
  - New `MeetingNote{ExternalID, Title, Date (YYYY-MM-DD), Summary, Decisions, OpenPoints, Actions, URL, UpdatedAt}`.
  - New `TicketChange{ExternalID, Kind ("new"|"status"|"assigned"), From, To, At}`.
  - New `PinnedNote{ID, Text, At}`.
- `internal/hub/store`:
  - migration;
  - `briefing.go` (new);
  - `ReplaceTickets`: diff into the change log.
- Tests.

**Interfaces — produces:**
- `ReplaceTickets(projectID string, ts []proto.Ticket, now int64) (changes []proto.TicketChange, err error)`.
  It is the existing call extended. When the project had no stored tickets before, it records no `new` rows.
- `TicketChanges(projectID string, since int64) ([]proto.TicketChange, error)`. Changes are kept 60 days.
- `ReplaceMeetingNotes(projectID string, ns []proto.MeetingNote) (changed bool, err error)` and
  `MeetingNotes(projectID string, sinceDate string) ([]proto.MeetingNote, error)`.
- `Visit(projectID string, now int64) (seenAt, prevSeenAt int64, rolled bool, err error)`, which applies the 30-minute
  rule, and `Visits(projectID string) (seenAt, prevSeenAt int64, err error)`.
- `AddPinned(projectID, text string, now int64) (proto.PinnedNote, error)`, which errors when empty or over 500 runes.
  Also `DeletePinned(projectID, id string) error` and `Pinned(projectID string) ([]proto.PinnedNote, error)`.
- `SetWhereLeftOff(projectID, text string, at int64) error` and
  `WhereLeftOff(projectID string) (text string, at int64, err error)`.

- [ ] **Tests first:**
  - The diff records `new`, `status` (from → to) and `assigned` (from → to).
  - The first sync gives zero `new` rows.
  - An unchanged resync records nothing.
  - Changes older than 60 days are pruned.
  - Visit rollover: the first visit sets `seen_at`. A second visit within 30 minutes changes nothing (`rolled` is
    false). After 31 minutes, `prev` equals the old `seen_at`.
  - Pinned notes: 500 runes are accepted, 501 are rejected, and blank text is rejected.
  - Meeting notes: upsert returns `changed` true only on real changes, and filtering by date works.
  - "Where you left off" round-trips.
- [ ] **Commit** `hub: store change log, visits, pinned notes, meeting notes`.

### Task 2: admin-site connector + NoteLister + syncer

**Files:**
- `internal/hub/connectors/moontech.go` (new) and `moontech_test.go`, using an `httptest` fake of the site.
- `internal/hub/connectors/connector.go`: the `NoteLister` interface.
- `internal/hub/connectors/sync.go`:
  - call `ListNotes` when the connector implements it;
  - save notes;
  - report what changed to a callback.
- Tests.

**Interfaces:**
- **Consumes:** Task 1's store calls.
- **Produces:**
  - `type NoteLister interface{ ListNotes(ctx context.Context) ([]proto.MeetingNote, error) }`.
  - The syncer calls a new hook after each project sync:
    `OnSynced func(projectID string, changes []proto.TicketChange, notesChanged bool)`.
    Task 3 wires it to the briefing events and the summary triggers.
- **Connector kind `moontech`:**
  - Settings: `baseUrl` (default: the employer's admin site URL, set in code), `product`, `titlePrefix`, `person`,
    `username`. The token is the password.
  - Login is `POST {baseUrl}/api/auth/login` with the username and password. Find the field names in the site's
    public JS bundle by fetching the bundle **only in the controller's real check**. In code, use a constant pair
    `{"username","password"}` behind one function, `loginBody`, that is easy to change, and test it against the
    fake.
  - It keeps the cookie jar in memory and logs in again once on a 401.
  - `List` maps `/api/tickets` rows to `proto.Ticket`:
    - `ExternalID` = id;
    - `Title`;
    - `Body` = detail;
    - `Status` through the status map, with `RawStatus` kept;
    - `Assignee` = person_name;
    - `PlannedStart` and `PlannedEnd` from `planned_start` / `planned_end` (ISO dates or timestamps to Unix ms);
    - `NoteTitle` = note_title;
    - `URL` = `{baseUrl}/ticket`;
    - `UpdatedAt` = updated_at.

    It keeps only rows whose product equals `product` and whose title starts with `titlePrefix` (case-insensitive,
    trimmed, when set).
  - `ListNotes` maps `/api/notes` rows whose `products` contains `product`. When `titlePrefix` is set, a row must also
    mention it, case-insensitively, in its title, summary, decisions, open points or actions.

- [ ] **Tests first**, against the fake site:
  - A good login, then `List` returns the mapped and filtered tickets: product filter, prefix with different case
    and spacing, the status map, and planned dates.
  - On a 401 mid-session it logs in again once and succeeds; a 401 again returns an error.
  - The site being down returns an error, the syncer keeps the previous tickets and notes, and records no changes.
  - `ListNotes` filters notes.
  - `Comment` and `SetStatus` return `read-only source`.
  - The password never appears in errors or logs (assert this with a captured logger).
  - The syncer calls `OnSynced` with the changes and `notesChanged`.
- [ ] **Commit** `hub: read-only admin-site ticket and meeting-note source`.

### Task 3: Briefing endpoint, "where you left off", events

**Files:**
- `internal/hub/briefing.go` (new) and `briefing_test.go`.
- `internal/hub/summary/`: a second generator for "where you left off".
- `internal/hub/appapi.go`: routes.
- Wire `OnSynced`, session turn-end/close, pinned changes and visit rollover to a per-project coalescer.
- `app/src/lib/api.ts`:
  - `getBriefing(projectId)`, `visitProject(projectId)`, `addPinned(projectId, text)`, `deletePinned(projectId, id)`;
  - the `Briefing` type, mirroring the endpoint.

**Interfaces:**
- `GET /api/projects/{id}/briefing` returns the spec shape:
  `{whereLeftOff:{text, at, sessions} | null, newSince:[{kind, title, detail, at, ref}], myTickets:[Ticket],
  meetings:{decisions, openPoints, actions}, pinned:[PinnedNote], sessions:[SessionInfo], seenAt, prevSeenAt}`.
  - **`newSince`** contains:
    - session items (finished since `prevSeenAt` and not working now, per spec decision 1);
    - change-log items for the owner's tickets (`new`, `status`, `assigned` to the owner);
    - new meeting notes dated after `prevSeenAt`.

    It is sorted newest first and capped at 20.
  - **`myTickets`** holds open tickets assigned to the configured person (trimmed, case-insensitive), sorted by
    planned end, nulls last.
  - **`meetings`** splits notes from the last 14 days into bullets.
    - Each line starting with `- ` is one item.
    - Actions are kept only when the line starts with `<person>:` or `- <person>:`, case-insensitively.
- `POST /api/projects/{id}/visit` returns `{seenAt, prevSeenAt}`.
- `POST /api/projects/{id}/pinned {text}` returns the created `PinnedNote`; 400 when the text is empty or too long.
- `DELETE /api/projects/{id}/pinned/{noteId}` returns 204.
- **"Where you left off" triggers:**
  - a turn end or close of a session of the project;
  - a change-log entry touching the owner's tickets.

  Debounce per project, generate at most once per 10 minutes, and store the result with `SetWhereLeftOff`. The prompt
  uses the 3 most recent sessions by activity (recap plus the last assistant answer, about 600 characters each) and
  the owner's open ticket titles, writes at most 3 sentences, and matches the sessions' language.

- [ ] **Tests first:**
  - The briefing shape for a project with each section.
  - A project with no source, no sessions and no notes returns empty lists and `whereLeftOff: null`.
  - The `newSince` cap and order.
  - Action filtering by person.
  - Visit rollover stability: two devices calling visit within 30 minutes do not move `prevSeenAt`.
  - Coalescing: 5 triggers within 2 s produce 1 envelope.
  - The generator is called at most once per 10 minutes under repeated triggers (fake clock), and not at all for raw
    `updated_at`-only syncs.
  - Pinned validation.
- [ ] **Commit** `hub: project briefing endpoint, where-you-left-off, briefing events`.

### Task 4: App — briefing on the project page, connector form, continue-where-I-left-off

**Files:**
- `app/src/components/briefing/*` (new): `Briefing.tsx`, `WhereLeftOff.tsx`, `NewSince.tsx`, `MyTickets.tsx`,
  `Meetings.tsx`, `PinnedNotes.tsx`.
- `app/src/screens/Project.tsx`:
  - the briefing at the top, replacing the summary line;
  - the Sessions section wraps `NewSessionCard` and `ProjectSessions`.
- `app/src/components/ConnectorForm.tsx`: an admin-site option (kind `moontech`). Fields: base URL, product, title prefix, you are,
  username, and a password that is write-only and shows "Saved". It is read-only, so the write-back UI is hidden.
- `app/src/components/LaunchDialog.tsx`: an optional editable `initialPrompt`.
- `app/src/lib/live.ts` or the store: refetch on `project_briefing_changed`.
- Tests and dev fixtures for a briefing.

**Behaviour:**
- **Layout.** A container query switches to two columns at 900 px:
  - left column: Where you left off, then New since;
  - right column: Your tickets;
  - then Meetings and Pinned notes side by side, then Sessions.
  - Empty sections are hidden.
- **Overdue.** A planned end date before today (device time zone, compared by calendar day) on an open ticket shows
  the warning tone and "Due <date>".
- **"Where you left off".** Shows the label "Written by Haiku from your last N sessions · not a source of truth".
  With null it is hidden.
- **Pinned notes.** An input and a Pin button (44 px). Delete is in each note's ⋯ menu. The limit is 500 characters
  and errors show inline.
- **Visits.** The visit is posted after the page has been visible for 5 s (`document.visibilityState`), once per
  mount.
- **No source.** The hint "Connect a ticket source to see your tickets here" links to the connector settings.
- **"Continue where I left off".** Builds the prompt with `briefingPrompt(b): string` (≤ 1,500 characters, English
  headings, the data copied verbatim). It opens `LaunchDialog` with that prompt, prefilled with the machine and
  folder of the project's most recent session.

- [ ] **Tests first:**
  - Section order and hiding.
  - Overdue by calendar day, including at a time-zone edge.
  - The Haiku label.
  - Pinned add and delete, plus the over-limit error.
  - The visit is posted only after 5 s of visibility.
  - The no-source hint.
  - `briefingPrompt` stays at 1,500 characters or less and includes the open tickets.
  - The connector form saves the admin-site (`moontech`) settings and never echoes the password.
  - The 320 px layout has no overflow (structural).
  - The initial JS budget holds.
- [ ] **Commit** `app: project briefing, admin-site source form, continue where I left off`.

### Task 5: Controller — real check and QA

- [ ] On the dev fixtures, check the briefing at 390, 1024 and 1600 px, light and dark.
- [ ] Do one real check against the employer's admin site, with the owner's authorisation already given.
  - Confirm the login field names from the site's JS bundle.
  - Configure the target project in the deployed hub, with the password typed into the form by the controller.
  - Sync, and check that the briefing shows Adrian's tickets and the meeting items.
- [ ] Report to the owner.
