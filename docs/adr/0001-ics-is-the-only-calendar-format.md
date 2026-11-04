# 0001 — `.ics` is the only calendar format the plugin reads

- **Status**: accepted
- **Date**: 2026-09-04
- **Deciders**: the author
- **Ticket**: #26

## Context

Building the days ahead reads a calendar. Until this decision it read `~/Scripts/synk-gcal/data/kalender.json` — one merged, time-normalised view of eight calendars, written outside the vault by a daemon on one machine, in a format nothing else in the world produces. Two of the eight sources are the Google Calendar API and an Outlook `.ics` export on disk.

Three things had to be true at once, and no route satisfied all three:

- **A stranger installing the plugin must be able to run the feature.** Reading `kalender.json` means the feature says *not configured* for ever on anyone else's machine.
- **One of the eight calendars has no link and probably cannot have one.** Microsoft publishes calendars as ICS URLs, but the control is a tenant setting employers commonly disable ([Microsoft, Exchange sharing policy](https://learn.microsoft.com/en-us/exchange/disable-internet-calendar-publishing-exchange-2013-help)). So a file route exists whether or not it is wanted.
- **Reading outside the vault forces `isDesktopOnly: true` on the whole manifest**, which would cost every feature its mobile support to serve one.

## Decision

**The plugin parses `.ics` and no other calendar format.** A *calendar source* is either an HTTPS `.ics` link the plugin fetches, or a path to an `.ics` file inside the vault. Both produce the same internal shape; nothing downstream learns which was used.

**Amended 2026-10-21 by [ADR 0007](0007-a-calendar-account-is-a-third-source-kind-and-its-password-stays-on-the-device.md)**: a source may also be one calendar of a *calendar account*, read over CalDAV and arriving as the same `.ics` text, so the plugin still reads no other format.

`ical.js` (MPL-2.0) parses; `ical-expander` (MIT) expands recurrence and resolves timezones. Both are pure JavaScript.

The calendar becomes a piece the **core** owns, because two features read it — building the days ahead, and meeting notes — and #14 forbids one feature referencing another.

## Alternatives considered

- **Keep `kalender.json` and publish its format.** Honest, and nobody would ever produce it. It also keeps the out-of-vault read, so it costs the whole plugin mobile support.
- **Move `kalender.json` into the vault, unchanged.** The cheapest change and it restores mobile — but it leaves a bespoke format that only one daemon writes, so the feature still serves nobody else.
- **Connect to Google directly with the plugin's own OAuth.** Rebuilds half the daemon, needs a registered application and a consent screen for every user, and still cannot see the Outlook calendar.
- **Two sources, one feature** — a link for strangers, the local file for the author. Rejected in this form: it is the right *outcome*, but expressed as two code paths. Making `.ics` the single format reaches the same outcome with one reader and a two-line adapter.
- **Depend on the ICS Calendar plugin as the fetcher**, as `docs/research/templating-family.md` § 6 suggested. Rejected: a hard dependency on another community plugin for a core capability, when the library underneath it is directly installable.

## Consequences

- **`synk-gcal` retires** as far as Effortless is concerned. Google calendars arrive by link; the Outlook `.ics` export is dropped into the vault by hand, as it already is today.
- **`isDesktopOnly` stays `false`** and five of six features run on a phone, amending #23, which had four.
- **The plugin inherits work the daemon was doing**: merging several calendars, expanding repeating events, resolving timezones. This is work it could not avoid anyway, since a stranger with three calendars needs all of it.
- **The core owns four pieces, not three**, amending #15.
- **The first bundled dependency under a licence that is not MIT.** MPL-2.0 is file-level copyleft, compatible inside an MIT work, and must be acknowledged in the repository — #21 did not anticipate this.
- **A pasted link is a bearer credential.** Anyone holding a Google secret link reads that calendar for ever without signing in, and it lives in `data.json` inside the vault. The settings field is masked and the README says so plainly.
- **Before the daemon is switched off**, all eight calendars must be confirmed to offer a secret link. Google documents it for calendars you manage and is silent about calendars shared with you; the API the daemon uses has no such limit.
- **Two more calendar-reading gains landed the same way, and for the same reason**. `Meeting.organizer`, `Meeting.attendees` and `Meeting.occurrenceKey` sit in the core's `icsReader.ts` rather than in meeting notes, because meeting notes reads all three and #14 forbids one feature reaching into another's own reading of the same bytes. A third gain from the same spec, creating and renaming a note at any path through the queue, sits in `src/core/noteWriter.ts` for the identical reason rather than this one's own module: building the days ahead and meeting notes both write notes, so the one queue that guarantees a single writer per file has to be core, whichever file it happens to be reading or writing.
