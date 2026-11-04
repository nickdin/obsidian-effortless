# Effortless

Effortless keeps your tasks and your days in plain notes. A task you have planned appears in the day's log and in its collection at once and stays consistent in both, so you stop copying tasks between pages by hand. What it will not do is decide for you: moving a task to another day, or into a collection, is always something you choose, one task at a time. The name is a promise about the copying, not about the thinking.

That is also the rule for what belongs here. A feature that saves you writing something out twice belongs; a feature that makes a judgement on your behalf does not, however useful it sounds.

It grew out of Ryder Carroll's [bullet journal method](https://bulletjournal.com) and takes what works from it. It is not an implementation of that method, and it is not affiliated with or endorsed by its authors.

Built for one person's way of working, and published in case it suits yours.

**Published, and still growing.** Effortless is in Obsidian's community plugin list, so you can install it from inside Obsidian. This repository holds the plugin's core — what every feature plugs into — and its eight features, listed under *What it does, and does not* below. They began as five separate plugins, and all eight now live here. What each feature still lacks is on the author's tracker, under that feature's spec.

Effortless reads and writes the Tasks plugin's own task-line format — the same ⏳ scheduled and 📅 due stamps — and does not need the Tasks plugin installed to do it.

Numbers such as #588 in the code and its comments refer to the author's private design record, which is not published, and so do the files they cite that are not in this repository.

## What it does, and does not

Eight features, each of which can be switched off on its own.

| Feature | What it does |
|---|---|
| Task consistency | Keeps a task's line the same in its collection and in the day's log, editing one field at a time |
| Migration | Files a task into the collection it belongs to, from the notes heading of a day's log or from any note that is not a collection, and marks the original |
| The day view | Draws the day's calendar table to scale, each meeting's height following its length |
| Building the days ahead | Makes sure a log exists for today and the days ahead, with the day's meetings filled in |
| Meeting notes | A note per meeting, linked from the day, and one in a single tap for a meeting on no calendar |
| Review | Shows how many notes of the last few days you have not gone through yet, lists them, and draws a month of your diary and review days as a chain |
| Date entry | Type a date in Swedish or English and get the date the plugin reads |
| Checkbox cycling | Steps a checkbox through the symbols you have chosen |

Two limits worth knowing before you install:

- **Task consistency does not run on a phone.** The service that copies your vault to a phone can write the same two files at any moment, from outside Effortless, and the clash check is built to catch two edits of yours, not that service writing at the same time as you. Its row on the settings screen says so on the device it is unavailable on.
- **No promise that Effortless works alongside [Day Planner](https://github.com/ivan-lednev/obsidian-day-planner).** Day Planner moves task lines between the day's logs, which is the same text Effortless keeps consistent.

What it reads, and what leaves your device: Effortless lists every note in your vault, to find your collections, the notes Review counts, the notes Migration can file a task into, and each meeting's note. That list stays on your device. The only thing Effortless sends anywhere is the calendar fetches described under *Calendars*.

## Calendars

Effortless reads a calendar from one of three places: a published `.ics` link that it fetches, an `.ics` file sitting in your vault, or a calendar account you sign in to. Add as many as you like. Each one has two switches — whether its meetings show up in the day, and whether each meeting gets a note of its own. A birthdays calendar usually wants the first and not the second.

**A published calendar link is a password.** Anyone who has that address can read the calendar for ever, without signing in and without you ever being told. Effortless stores it in the plugin's settings file, which lives inside your vault — so it travels wherever your vault travels: onto every device you use, into every backup you keep. The field on the settings screen is masked for that reason. If an address ever gets out, revoke it where you published the calendar; changing it in Effortless does nothing to the address someone else already has.

**A calendar account reads calendars you keep private.** It signs in to your calendar provider the way a desktop calendar app does, over CalDAV: iCloud, or any other provider that lets an app sign in over CalDAV with a user name and an app-specific password. Press *Add account*, keep or replace the server address (iCloud's, `https://caldav.icloud.com`, is filled in), type your user name and an app-specific password, and press *Fetch calendars*. Then tick each calendar Effortless should read; each one you tick gets its own row and its own two switches.

An app-specific password is a password your provider makes for one app, so your own password is never typed into Effortless. For iCloud, sign in at [account.apple.com](https://account.apple.com), open *Sign-In and Security*, choose *App-Specific Passwords* and make one; other providers have their own page for it. **The app-specific password stays on the device you type it on**, in Obsidian's keychain, which you can see under *Keychain* in Obsidian's own settings. It is not written into the plugin's settings file, so it does not travel with your vault: type it once on each device that should read the account, and a device without it says so on the account and reads none of its calendars. The server address and the user name do travel, so the account appears on every device. If the password ever gets out, revoke it at your provider, which signs Effortless out everywhere; make a new one and type it in again. Why it works this way is [ADR 0007](docs/adr/0007-a-calendar-account-is-a-third-source-kind-and-its-password-stays-on-the-device.md).

Links and calendar accounts are read every fifteen minutes, through Obsidian's own network route. If a fetch fails, Effortless keeps the last copy it got and marks that calendar failed on the settings screen rather than leaving your day empty. Each calendar's row also says how long ago it was last read, which is how you notice a file you dropped in by hand has gone stale.

## Date entry

Type a date in Swedish or English into any note, and Date entry turns it into a stamp — no command, no dialog, just the trigger character and a few words.

**How it works.** Type the trigger — `@` unless you change it — at the start of a line, or after a space or a tab, then a few letters. A popup opens with one suggestion: the phrase it read, and the date. Press Enter and it writes the stamp, where **Where the stamp goes** below says it goes. Press Escape, or click outside the popup, and that one trigger goes quiet — delete it and type it again, and the popup comes back. An email address, such as `name@example.com`, opens nothing.

**The two kinds of date.** Type `s`, `sch` or `schema` and a space for a scheduled date (⏳); type `d` or `due` and a space for a due date (📅). Type nothing before your words and you get scheduled, which is the default. There's no prefix for a start date — this feature only ever writes scheduled and due.

**Where the stamp goes.** On a task line, it goes where the Tasks plugin's own format puts it, replacing a stamp of the same kind if there's already one there. On any other line, it's written exactly where you typed the trigger.

**Repeat rules.** Start a rule word after the trigger — `varje`, `varannan`, `vartannat`, `var `, `den ` or `sista` in Swedish, `every` in English — and from its first letter the rows turn into repeat rules in the language chosen on the card, with no date row beside them. A fragment that is exactly `s`, `d`, `sch`, `schema` or `due` still means a date, so `sista` turns into rules at `si`. Each row shows, beside the phrase, the English `🔁` text it writes, in the wording that Task consistency, below, reads: `varje måndag` writes `🔁 every week on Monday`, and `every month on the 1st` writes `🔁 every month on the 1st`. A number you type fills the interval or the day of the month (`var 5`, `den 20`), a weekday followed by `och` or `and` offers pairs, and the `efter klart` or `when done` version appears once the phrase is typed in full or that word is started. The rule goes where a stamp goes. A task line with no ⏳ and no 📅 gets a first scheduled date with the rule: today for a count of days, a plain week, month or year, or any `when done` rule, and otherwise the first day the rule names from today on. So a rule entered on a task line here always has a round to plan. A task line that already has a date keeps it and gets the rule alone, a task line that already carries a rule has it replaced, and a line that is not a task gets the rule alone, written where the trigger was. One undo puts the line back as it was.

**Which language, and each one's own weekday rules.** Date entry reads Swedish or English, chosen on its own settings card — never Obsidian's own display language. Swedish has three rules of its own: a bare weekday (`tisdag`) is the nearest one coming up and never today — on Tuesday 31 March 2026, `tisdag` gives Tuesday 7 April 2026; `nästa vecka` ("next week") is the coming Monday — on that same Tuesday it gives Monday 6 April 2026; and `nästa <veckodag>` ("next <weekday>") skips past the nearest one and lands 8 to 14 days out, depending on the weekday — `nästa måndag` on that Tuesday gives Monday 13 April 2026. English also has three: a bare weekday (`thursday`) is never today either — on Thursday 3 September 2026, `thursday` gives Thursday 10 September 2026; `next week` is the coming Monday — on that Thursday it gives Monday 7 September 2026; and `next <weekday>` is that weekday in the following Monday-to-Sunday week — `next monday` on that same Thursday also gives Monday 7 September 2026, agreeing with `next week`.

**The two languages disagree about `next <weekday>`, and it is worth knowing which way.** English takes that weekday in the following Monday-to-Sunday week. Swedish skips past the nearest one, wherever it falls. So for a weekday that has already gone this week — and for today's own weekday — Swedish lands a week later than English; for a weekday still to come, the two give the same day. On Thursday 3 September 2026, `next monday` gives Monday 7 September 2026 and `nästa måndag` gives Monday 14 September 2026, a week apart; `next friday` and `nästa fredag` both give Friday 11 September 2026. Within each language nothing disagrees: English `next week` and `next monday` always name the same Monday, and Swedish `nästa måndag` is always a week past `nästa vecka`.

**If you also run the Tasks plugin, Effortless still doesn't need it** — but the two popups can want the same keystroke, so it's worth turning Tasks' own suggester off. In the Tasks plugin's own settings, under its Task entry group, that toggle is named **Auto-suggest task content**. This isn't only an English problem: the Tasks plugin's own suggester has no trigger character of its own, so it can open while you're typing Swedish just as easily.

**On a phone,** `@` sits on the symbol layer of the keyboard, so opening the popup costs one extra tap. Date entry's settings card has a **Trigger character** box if you'd rather use something easier to reach.

## The day view

A note whose calendar table sits inside a `schema` fence gets that table drawn to scale, each meeting's height following its length.

**What it reads.** The two columns named on the core's *Your day's logs* card — *Time* and *Meeting* until you change them — wherever they sit in the table. Any other column is ignored: not drawn, not clickable.

**What it draws.** A band of all-day bars above a grid, gridlines every half hour, meetings placed side by side where they overlap, and a now-line marking the current time on today's log.

**It writes in exactly three cases.** A click turns a plain-text meeting into a link, once the note it names is known to exist. A click on a meeting with no note yet creates one and opens it. A rename anywhere in the vault is followed into the table's own links, because Obsidian does not update a link inside a fence on its own.

**The now-line needs the daily-log folder and filename.** Without both answered on the core's card, the day still draws — it simply draws with no now-line, because Effortless cannot tell which note is today's log.

**On a phone, a tap shows the bubble** — its time, if it has one, and its name where there is no room to show it — and a second tap on the bubble opens the note. An all-day bar has no time, and a meeting whose name already fits has no bubble at all: the first tap opens it.

**It never moves a meeting.** The calendar is where a meeting's time or day changes; the day view only draws and links what the table already says.

## Building the days ahead

Effortless creates the day's log for today and each of the days ahead, from the folder and filename pattern set on the core's day's-log card, with the day's headings and an empty calendar table already in it. No template of your own is needed, and Templater is not needed either.

It then fills that day's meetings into the calendar table, read from your calendar sources: the time, and the meeting's title with its location in brackets. The meetings it writes are the ones your sources show in the day; a source switched on only for notes puts nothing in the table. Of the meetings it does write, one that is also making a note of its own appears as a link to that note, and the rest appear as plain text.

A row whose meeting has left your calendar is removed, on today or a day ahead, while the meeting has not ended — but only when the row still reads exactly as the plugin last wrote it, and only on a run where every calendar source read whole. A row you typed or changed yourself stays exactly where it is and exactly as it reads: it is neither rewritten nor deleted. A meeting the calendar shifts to another time the same day keeps its row; one shifted to another day loses its row on the old day and gains one on the new. Where a row does belong to a meeting, the time cell is this feature's own and is kept in step with the calendar; the meeting's cell beside it is left alone once you have made it a link and that meeting is making no note. A link the plugin wrote itself is not yours: it is corrected like any other cell it wrote, until the meeting's row has ended, even when the meeting makes no note any more — the plugin tells the two apart by a record of the text it wrote, and for a row an older build wrote, by its being exactly the link the plugin writes (a date and the title, or the placeholder title, with a location in brackets allowed). A day before today is never created and never touched.

How far ahead it keeps ready is the **Days ahead** setting, from one to sixty days, seven by default.

Only one device does this, chosen by *Build the days on this device* on the core card. On every other device the feature's row shows it off, with a sentence saying another device builds the days — see the glossary's own entry for the building device.

It runs ten seconds after it starts up — when Obsidian opens, and again if you make this the building device without restarting — and every fifteen minutes after that.

A day whose calendar table it cannot read is left exactly as it is, and said once on the settings screen, naming that day. Nothing is ever written into the note to complain, and the report clears once the day is fixed or once it drops out of the window. A calendar that will not read is said on that calendar's own row instead, and does not leave the day empty.

## Meeting notes

Effortless creates a note for every meeting today that has at least one invited person, on a calendar source switched on to make notes — never a meeting further ahead, never one whose source is switched on only to show in the day's table, and never one with nobody invited, such as a whole-day reminder. Being invited means being on the meeting's own list of attendees; naming an organizer and nobody else does not count.

Each note is created in the folder you name, with the tag, the field names and three headings you have answered on the card: one tag every note carries, a field that holds its effort, a field that lists who was invited, a field that links back to the day's log, and a field left blank for your own use. The note itself opens with the meeting's own title, not a setting; the agenda heading comes right after it, with the invitation's own text below, minus the lines that exist only to join the call (the fenced Skype, SAFOS or Microsoft Teams text; the calendar keeps the whole invitation, and another service's lines stay in the note); the notes heading and the decisions heading follow further down, both left blank for you to fill in. A note made by clicking a meeting in the day view carries two more properties, `effortless-meeting` (which meeting it is) and `effortless-offered` (the names the click offered a place on the note); a name you delete from its list by hand stays removed.

A changed title or a changed day renames the note, correcting the top heading and the day-link field in that same step. A note made while the meeting had no title yet, named with the date and *Untitled meeting*, is the one exception: when Effortless has no record of it and it is the only such note that day, it is renamed to the meeting's real title with its text kept exactly as it was, top heading included — and once the meeting has ended it is left alone. An ordinary later run — nothing renamed — only ever touches the participants list, where a newly invited name is added, never removed. Nothing at or below the agenda heading is ever touched — that half of the note, and every name already on the list, stays exactly as you left it.

A note whose meeting has left your calendar goes to the trash — Obsidian's own, by your *Deleted files* setting — while the meeting has not ended, but only when the note still reads exactly as Effortless last wrote it, and only on a run where every calendar source read whole and the meeting is nowhere in the year ahead. A note you have written in, or one Obsidian refuses to remove, is kept, and the settings screen says so once. A note made before Effortless kept this record, or one it adopted, is kept without a word. A meeting shifted to another day keeps its note.

A note already at the path where a meeting's note would go, with none of Effortless's own record of it, is adopted rather than written over: at that moment its text is left exactly as it is, never read, compared or corrected, and everyone invited so far is treated as already on the list. From then on it is treated as this feature's own note: a name invited later is added, and a changed title or day renames it like any other.

Meeting notes runs on the same one device that builds the days ahead, chosen by *Build the days on this device* on the core card. On every other device the feature's row shows it off, with a sentence saying another device builds the days and the meeting notes — see the glossary's own entry for the building device.

**A meeting on no calendar.** The command *New note for an unplanned meeting*, or the calendar-with-a-plus icon in the ribbon, makes a note for a meeting starting now and opens it at once, with the cursor under the notes heading — nothing is asked first, so a recorder's own button can be pressed straight after. It is offered on every device while the feature is switched on, the ones that do not build the days included, and is named in Swedish when Obsidian is. The note is built from the same template as every other meeting note, named with today's date, the words *Unplanned meeting* and the start time as four digits (`2026-11-04 Unplanned meeting 1405`), so two such meetings in a day get two notes; pressed twice within one minute, the second press opens the note the first made. It has nobody on its participants list and no `effortless-meeting` property, and the calendar never adopts, renames or trashes it: a calendar meeting that later turns up at the same time gets a note of its own. A link to it is added to today's log, under the notes heading after whatever is written there — never in the calendar table, which building the days ahead rewrites. Today's log is created first if it is not there yet; a day without the notes heading is not rearranged, and a message says the link could not be added. It needs the meeting notes folder and the daily-log folder and filename answered.

A rescheduled meeting keeps its note: it is renamed to the new day rather than left behind or duplicated, with its heading and day link corrected in the same step. If that new path is already taken, the rename is refused, the note stays where it was, and a line on the settings screen says so until you move things by hand.

**The settings**, each answered once on the card:

- **Meeting notes folder** — the vault path notes are created in. Blank means the feature does not run.
- **Your email address** — left off every note's participants list once you answer it. Left blank, creating a note raises a line on the settings screen explaining that your own name may be on it, which clears once you fill this in.
- **Tag** — the one tag every meeting note carries.
- **Effort field** — the frontmatter field a note records its effort in.
- **Participants field** — the frontmatter field that lists who was invited.
- **Notes heading** — the heading a meeting note carries for your own notes.
- **Agenda heading** — the heading the invitation's own text goes under.
- **Decisions heading** — the heading left for your decisions and actions.

Two more property names appear in every meeting note, the **day link field** (links the note to its day's log) and the **processed field** (left blank for you to fill in once you have gone through the note). They are not on this card: they are answered once on the core's card, in the layout section, so that every feature that reads them means the same property. A vault that answered them on this card before keeps those answers the first time the plugin loads.

## Task consistency

Keeps a task's line the same in its collection and in the day's log, editing one field at a time. A task lives in its collection; the day's log holds a copy of it for the days it is due, and Effortless keeps the two copies agreeing.

**What it reads.** Every collection with at least one open or finished task under its tasks heading — a note is a collection when it carries the tasks heading set on the core's card — and the tasks under that heading, down to the completed-tasks heading. A finished task counts because a ticked recurring task, below, is owed its next round. It reads today's log, and an earlier day's log, so that a task left unfinished can move on to the next day. A collection with no task under its tasks heading is not read at all.

**When it runs.** A second or two after you stop typing in a collection or in today's log, on that one file. And once ten seconds after Effortless starts and every fifteen minutes after that, which is what notices a task that became due only because midnight passed. A file you have open is never written to; what is owed to it waits until you leave it.

**What it writes.** One field at a time, and every other byte of a line is left exactly as you typed it — a repeat rule, which the task-line reader does read, is not compared or carried between a log and its collection by this feature and stays where it was.

- **A copy in.** A task with a scheduled or due date of today or earlier, and no copy yet, is copied under the today heading, or under the overdue heading if it is earlier than today. The collection's own line is marked `[/]`, and the copy in the log ends with the collection's name as a link. A due subtask comes in indented under its due parent; a subtask whose parent is not due comes in under one plain line with the parent's words and no checkbox. If the log lacks the today or overdue heading, the heading is added. The notes heading is never added.
- **The five fields that travel.** The checkbox, the scheduled date, the due date, the priority and the tags. Change one on either copy and the other follows. The task's words do not travel.
- **A finished task.** Ticking a task in either file finishes it in both. In the collection it moves, with its subtasks, to the end of the completed-tasks heading, which is added beneath the tasks heading if it is missing.
- **A task left unfinished.** It reappears in the next day's log under the overdue heading, and the day it left keeps its line, marked `[>]`. That line is then frozen: Effortless never edits it again. Changing a task's date from the log does the same to today's line.
- **A hidden comment on both lines**, `%% task-consistency:<id> <hash> %%`. It is the only thing this feature remembers, and it lives in the files, not in the plugin's settings.

**A recurring task comes back when ticked.** A task in a collection whose line carries a repeat rule in the Tasks plugin's own wording — `Vattna blommorna 🔁 every week`, with a ⏳ or 📅 date — is a recurring task, and each line of it is one round. A rule on a subtask is carried with its parent's round as text and never read on its own. Tick the round, in the log or in the collection, and it moves with its subtasks under the completed-tasks heading, while a fresh open line takes its place under the tasks heading: the same words and rule, every box open again, and the next date, with a second date shifted by the same number of days so the gap between them is kept. Cancelling a round skips it and brings the next round just the same. Only ticking brings the next round, never the date arriving: a round left undone rolls over to the next day like any task left unfinished, and no second round appears beside it. A fixed rule keeps its own rhythm whichever day you tick, and a late tick never dates the next round in the past — you get one fresh round, never a pile to catch up on. A round ticked on a phone comes back the first time a desktop with Task consistency on sees the tick, and a rule ending in `when done` counts from the day Effortless sees it. Nothing is shown of a recurring task beyond its own lines, and no done date is written.

**Which repeat rules are read.** Only the wording the Tasks plugin itself writes, with letter case ignored: `🔁 every day`, `🔁 every 3 days`, `🔁 every week`, `🔁 every 2 weeks`, `🔁 every month`, `🔁 every 6 months`, `🔁 every year` and `🔁 every 2 years`, a count running from 2 to 999; weekdays by their full English names, Monday first and joined by a comma, as in `🔁 every week on Monday`, `🔁 every week on Monday, Thursday` and `🔁 every 2 weeks on Monday`, with `🔁 every weekday` for Monday to Friday and `🔁 every day` for all seven, never the list; one or two days of the month as ordinals, smallest first, or its last day alone, as in `🔁 every month on the 1st`, `🔁 every month on the 1st and 15th`, `🔁 every 3 months on the 15th` and `🔁 every month on the last`; and ` when done` after any of them, as in `🔁 every 3 days when done`. A rule naming a day skips a month that lacks it — `on the 31st` passes over February — while a plain `🔁 every month` or `🔁 every year` from a day the month lacks lands on that month's last day. A rule that can never give another date — `every 12 months on the 30th` from a day in February — brings no round, and the ticked task finishes like any other. **A rule in any other form is reported, never guessed at** — `every week on Mon`, `every 1 week`, `every month on the 31`, `every week on Thursday, Monday`, anything with `until` — and the task then behaves as one that does not repeat: it is copied in, rolls over and finishes like any task. A rule on a line with no ⏳ or 📅 date is reported too, because no round can be planned from it, and the line stays where it is, ticked or not, until it has one. Each report is on the settings screen, names the collection and quotes the line, and clears by itself once the line has a date, the rule is readable or the line is gone. A collection whose completed-tasks heading is blank gets no rounds at all, and says so on the settings screen too. **The Tasks plugin itself is not needed**, and running it beside Effortless is not promised to work.

**What it never does on its own.**

- It never files a task. A task you type in the log with a collection's name on it and no hidden comment is left exactly as you typed it. Moving a task into a collection stays your act.
- It never picks a side in a clash. If you change the same task in both files before Effortless has caught up, both copies stay as they are, and the settings screen says so, showing the words as they read on each side. You edit one of them and the line clears. Nothing about a clash is ever written into either note.
- It never deletes a task from a collection. Delete a line in the log and it comes back on the next run, keeping its id. To take a task off a day, change its date.
- It never runs on a phone, whatever the settings say, for the reason under **Two limits worth knowing** above.
- It never guesses when a pairing breaks. If a collection's heading is renamed or the note leaves reach, both files are left untouched and the settings screen says so once; it heals by itself when the collection matches again.

**Go to the task.** The command *Task consistency: go to the task in its collection* opens the collection with the cursor on the paired line. It has no default hotkey — you set one in Obsidian's hotkey settings if you want one — and it is available only on a line that carries a pairing. Clicking the collection's name on a log line does the same, in Live Preview and in reading view. A click inside a popout window does not yet jump.

## Migration

Puts a task into the collection it belongs to, and marks the original, so the note it was written in still shows what became of it. It starts from **two places**: the notes heading of a day's log, or any note that is not a collection (a meeting note, a reading note, a phone-call note), under any heading. It is the move you would otherwise make by hand: copy the task into its collection, then change its box on the original line to `[>]`. Nothing happens unless you ask, and it never chooses the collection for you.

**Three ways to ask.**

- The command *Migration: file this task into a collection*, from Obsidian's command palette.
- The same command on a hotkey. **It has no default hotkey** — you set one in Obsidian's hotkey settings if you want one.
- Right-click a line: the entry *File this task into a collection*. In a day's log it shows on any line under the notes heading that is not inside a fence; on a line that is not a task it still shows, and choosing it says why nothing was done. In any other note it shows only on a line that can be filed. Whether a long press on a phone opens the same menu has not been checked.

Both the command and the entry start from the line under the cursor, or from every task line in a selection. Nothing in the code refuses a phone, but the feature has not been checked on one yet; that check is still to come. It needs the daily-log folder, the daily-log filename and the tasks heading answered on the core's card; until then its row says what is missing.

**What it takes.** A task line under the notes heading of a day's log, or a task line anywhere in a note that is not a collection, outside fenced text and frontmatter, with one of the five checkbox symbols the plugin understands: `[ ]`, `[/]`, `[x]`, `[-]` and `[>]`. A note, an idea, a plain bullet, or a task with any other symbol, such as `[I]`, is left where it is and a message says why. **A collection is refused**: putting a task away from inside a collection is never done, and the message says the task already lives in a collection. So is a note other than a day's log in an excluded folder, and a line inside fenced text or frontmatter. So is a task that carries a hidden `%% … %%` comment, since it may already be put somewhere or paired. Whatever is indented under a task travels with it. In a selection, blank lines are ignored, and every line left out is named in one message.

**Choosing the collection.** A box opens with your collections, the ten you put a task into most recently first. Type, and every other note in the vault appears after the collections that match, except the days' logs, notes in an excluded folder and the note the task comes from, which are never offered. Escape, or a click outside, writes nothing. Choose a note that is not a collection yet and you are asked once: *Yes, write the heading* adds the tasks heading at the end of the note, as a level-2 heading, and puts the task under it; *No*, Escape and a click outside change nothing in either note. A vault with no collection yet still opens the box, so the first one can be made this way.

**What is written.** The collection gets the task's line as you wrote it, with its own indentation taken off if it was indented (what sits under it keeps its indentation relative to the line), plus a hidden comment `%% migration:<id> <hash> <box> L %%` (the third word is the box the task had when you put it there; the `L` says the line also carries a link the plugin added, and a task put away by an older version has no `L`), at the bottom, under its tasks heading. When the task goes into a section that held no task yet, the hidden comment on the collection's copy gets a fifth word saying which blank lines, and which heading, were added around it — `b/b@7910451b`, say, for a blank line above and one below, and after `@` a short code for the heading it went under — so that undo takes out exactly those. If you have since put the line somewhere else, away from that heading, undo takes out the line alone and leaves the blank lines around it, which are then yours. The first task filed after its tasks heading was written records that heading too, so undoing it gives the note back without the heading, unless another task sits under it by then; a task put into a section that already held one has nothing added around it, and its hidden comment has no fifth word. A done task goes instead under the completed-tasks heading, still ticked, and that heading is added if it is missing; if the completed-tasks heading is blank in the settings, a done task is refused and a message says it has nowhere to go; a cancelled task stays under the tasks heading, still cancelled. A task filed since this landed gets, on its copy in the collection, a link to the note it was filed from too, after the task's own words; a task filed before then has none. If you rename that note afterwards, or give it another folder, the plugin rewrites the link on the collection's copy to name it where it is now, even with Obsidian's own "Automatically update internal links" off; a link of your own to the same note, on that line or any other, is left as you wrote it. The copy Task consistency later puts in a day's log never carries it. The note it came from (the day's log, or the other note) keeps the line with its box changed to `[>]`, `[[the collection's name]]` added after your words, and the same hidden comment. Nothing else on either line changes. The collection is written first: if it refuses, the note the task came from is not touched, and if its line changed while you were choosing, the task is in the collection and the message says its line was not marked.

**It never adds a date.** A scheduled or due date already on the line goes with it, and a task with none goes with none. When a task is done is yours to decide, and this feature does not decide it.

**A task dated today shows up twice, and that is correct.** The task in the collection is an ordinary task with a date. If that date is today or earlier and Task consistency is switched on, its next run copies the task into today's log, under the today heading, or the overdue heading if the date is earlier. The same day's log can then show the frozen `[>]` line under the notes heading and a live copy under the today or overdue heading. Read the first time, it looks like a duplicate. It is the two features each doing their own job, and Task consistency does not read the frozen line. This holds for an ordinary open task: a task filed while it was marked `[/]` (in progress) is never copied. Task consistency also marks the collection's copy `[/]` when it copies it in; undo does not count that mark as a change (see **Undo**).

**Undo.** The message that says a task was put in a collection carries an *Undo migration* button for ten seconds. Afterwards, right-click the frozen `[>]` line (in the day's log or in the note it was filed from) and choose *Undo migration*. The button on that message undoes every task of a selection; the right-click entry undoes the one line you pressed. It works only while the task in the collection is untouched, meaning its own line still reads as it did when it was put there; reworded or ticked, and undo refuses, names the collection in its message and writes nothing. The `[/]` that Task consistency puts on the copy when it copies the task into today's log is not your doing and does not stop an undo; a task that was already `[/]` when you put it there, and that you have not touched since, undoes too. A task put in done, cancelled or forwarded, and later set to `[/]` by you, is refused: Task consistency never marks those. A task put in by an earlier version of the plugin is refused once Task consistency has marked it `[/]`, because that version did not record the box the task had. Undoing puts the line back in the note it came from exactly as you wrote it, box included, and takes the copy, with whatever is under it, out of the collection. For a task that came from a day's log, if Task consistency has copied it into today's log, that live copy is taken out too, so the log reads as it did before you filed the task; a comment you added to the copy yourself comes back on the line. For a task that came from any other note, a live copy Task consistency put in today's log stays there for now. If the collection cannot be written while undoing, the line in the note the task came from is put back as it stood and the message says both notes are as they were; if even that cannot be done, the message says the task is back in that note and its copy was left in the collection, to delete by hand.

**A `[>]` line carrying Migration's hidden comment, in a note that is neither a day's log nor a collection, always means the task went into a collection**; roll-over never writes outside the day's log.

**Go to the task.** On a frozen `[>]` line, in a day's log or in any note that is not a collection, the command *Migration: go to this task in its collection*, or the right-click entry *Go to this task in its collection*, opens the collection with the cursor on the task. It finds the task by its hidden id, so lines added above it since do not matter, and the command has no default hotkey either. If the collection is gone or is not one any more, or the task has left it, a message says so and nothing opens; for a collection that is gone, a line on the settings screen says so too until a later jump from that line reaches the task; nothing watches for the note's return, so the line stays until then.

## Review

Shows what you have not gone through yet of the last few days, so that deciding does not depend on remembering to. It shows and never decides: a task is still filed with Migration, one at a time, in the note itself, and the only thing Review ever writes into a note is the answer to *Mark as processed*.

**What it shows.** A count in Obsidian's bottom bar, which says how many notes are waiting and disappears when none is. No note whose day is today is counted, today's log and a meeting note linked to today alike, so the count can reach zero while you are still writing today. And a list, opened from the *Review* icon in the ribbon, on a computer and on a phone, of every waiting note, today's included, oldest first. Each row gives the note's date and name, how many open tasks and how many plain bullets it holds, and a *Mark as processed* button. Clicking a row opens the note. **Open tasks are the ones nothing else handles.** In a day's log only those under the notes heading are counted, since Task consistency already carries what sits under Today and Overdue; in any other note every section counts. A task with a hidden `%% … %%` comment, filed by Migration or paired by Task consistency, is not counted anywhere, and the symbol, the place and the comment are judged by Migration's rules. A collection is the one exception to "every section counts": Migration refuses every line of one, so its row is still listed but shows 0 open tasks. And in a day's log a code fence opened inside the note's header (the lines between the first two `---`) counts as still open below it, as Migration reads it; in any other note a fence in the header opens nothing. **A phone has no count**, because Obsidian on a phone does not draw the bottom bar; the list is the same.

**The diary.** The core writes a *Diary* heading into every new day's log, as its last section, and what you write under it is yours: Effortless puts no questions there. Any text you write counts as a diary, one word or a dash; the lines your day's-log template puts there do not, until you change them, and a log built for a day after today is not dated. A log built from your template carries a property, `effortless-built-diary`, holding a short fingerprint of those lines, so it still reads as untouched after you reword the template, on whichever device it is opened; leave it be. The first time Effortless sees text under the heading in a day's log, it writes that day's date into a property of the log, named by the core card's `Diary date field` row (`diary` by default). It writes it once and never changes it, and a date you typed there yourself is left as it is. That date is how a diary written on its own day is told from one written later. A diary left empty on a past day is never listed as waiting in the list above. Today's, while still empty, is named: the list says *diary empty* for today, on today's row or, when today's log has no row in the list (it is marked processed, or has no processed field at all), on a line of its own, until today's diary holds text; the lines your day's-log template put there count as empty. It is never counted.

**The chain.** Above the list is one month, Monday first. Every day shows as it is, weekends included. Each day carries a small mark for each of two routines: the *diary* and the *review*. A check means kept and a cross means missed. A day shows nothing when the routine is still open, as the diary is on today. A day with no log, or a log with no diary heading, is blank for the diary: neither kept nor missed. A diary is **kept** when the date in that property is the day itself, and **missed** when a past day has no such date, because it was written later or not at all. A review is **kept** when every note of the day has its processed field filled by the day after: the day's log and every note whose day link field points at it. It is **missed** when one is still empty by then, or was filled later. A note with no processed field at all is not counted, because the list never shows it and *Mark as processed* cannot fill it; a day none of whose notes has the field is blank for the review. Above the grid, *Diary* and *Review* each show a number: how many kept days in a row you have, counted back from the latest day that is decided. A day that is still open or blank does not break the number and a missed day ends it. Each count is the run as of today, whichever month is shown, and it reaches back as far as the run does, through any number of earlier months. The arrows step to earlier months and never past the current one; each time you open the list it starts on the current month. The chain shows and never decides, like the rest of Review.

**What makes a note a waiting note.** Two things, and nothing about its tags. The note has a **processed field** that is present and empty, and it has a day within the last few days. A day's log has the date its name carries. Any other note has the day of the day's log its **day-link field** links to, which is how a meeting note finds its day. A note with neither has no day and is never waiting, and neither is a note whose day has not come yet, such as tomorrow's log, or a note in a folder listed under *Excluded folders* on the core's card, whatever else it has. A template note falls out by itself: its name is not a date and it links to no day. To bring a note of your own kind into Review, give it an empty processed field and a day-link field that links to a day's log.

**How a note stops waiting.** Press *Mark as processed* on its row, or run the command *Mark as processed* from the command palette while the note is open; the command is offered only on a waiting note and ships with no hotkey. Either fills the processed field with today's date. On a note you have open for editing the date appears at once, and one undo takes it out. On a note shown in the reading view, or one whose file uses Windows line endings or begins with a byte-order mark, it appears when you leave the note: Obsidian's editor would rewrite every line ending of such a note, and Review changes the one line and no other byte. Typing any value into the field yourself, a date or `true`, does the same.

**Followed tasks.** A task you are not doing yourself but want to see land is a *followed task*. To follow one, write `@` directly followed by a link to the person, anywhere on the task's line: `- [ ] Send the contract @[[Ada Example]] ⏳ 2026-03-25`. The task's ordinary scheduled date is the day to chase it; with no scheduled date its due date is used, and a task with neither has no day. The list shows every open followed task in the vault below the waiting notes, under a heading with how many there are, grouped by person, earliest day first and the ones without a day last. A row shows the task's words, its day if it has one and the note's name, and clicking it opens the note at that line. Nothing is drawn when nothing is followed, and the heading follows Obsidian's display language: Swedish when that is Swedish, English otherwise. A task stops being followed when you tick it or cancel it. The date popup of *Date entry* steps aside before `[[`, so typing `@[[` to name a person does not open it.

**The settings.** The two field names are answered once on the core's card, in the layout section, as *Processed field* and *Day link field*, so that Meeting notes and Review mean the same properties; the defaults are `processed` and `day`. The window is Review's own setting, *Days to look at*: seven by default, today included, a whole number of at least one. The chain adds two rows to the core's card, in the layout section: *Diary heading* and `Diary date field`. The heading is `Diary` at the top level and the field is `diary` by default. A vault that upgrades arrives with the heading blank, so its new days grow no section nobody asked for; a blank heading leaves the diary's marks and its number out of the chain, and the review is drawn alone. Type a heading to switch the diary on. A name or number read from the settings file that cannot be used is refused with a message rather than silently replaced.

## What a feature is

A feature is one thing you would plausibly switch off on its own. Each one declares its name, a line describing itself, its own settings and a check on whether it has what it needs. It never refers to another feature: anything two features must agree on lives in the core instead, so switching one off can never break another.

That makes the feature list open-ended. Adding a feature is a new folder under `src/features/` and one line in `src/main.ts`; the core never learns what any of them do.

## The core

Every file in `src/core/`, and what it owns.

| File | What it owns |
|---|---|
| `src/core/feature.ts` | The contract. What a feature declares, and everything it is allowed to reach. |
| `src/core/coreParts.ts` | The one bundle the core builds at start-up, so the registry and the settings screen cannot end up holding different copies of it. |
| `src/core/registry.ts` | The list of features and the switch on each one. Catches a feature that fails to start so the rest carry on. |
| `src/core/settings.ts` | The single `data.json`, as `{ core, features: { <id> } }`. The only writer. |
| `src/core/unrecognisedKeys.ts` | The core settings in `data.json` this build does not recognise, carried and written back unchanged so an older build never removes a newer one's settings. |
| `src/core/noteWriter.ts` | Writes to notes you are not looking at — atomic, and queued per file so two writes cannot lose each other. |
| `src/core/vaultLayout.ts` | Where the day's log lives, which headings it has, and what a new one is framed with. |
| `src/core/dailyLogTemplate.ts` | Building a new day's log from the person's own template note instead of the built-in frame, with its date placeholders filled for the day being created. |
| `src/core/builtDiaries.ts` | What each day's log held under its diary heading when it was built, kept in the settings file, so an untouched log is never taken for a written one after the template is reworded. |
| `src/core/builtDiaryMark.ts` | The same, carried inside the log itself: a property holding a fingerprint of the diary section it was built with, so the log answers for itself whichever arrives first on another device, it or the settings file. |
| `src/core/fingerprint.ts` | A short fingerprint of a text, kept in place of the text: one rule for meeting notes and the diary mark. |
| `src/core/datePattern.ts` | Writing a date out under a filename pattern, and reading one back. Knows nothing about vaults. |
| `src/core/markdownSections.ts` | Which lines of a note a heading owns, worked out from the note's text alone. |
| `src/core/taskLine.ts` | The one place that understands a task line. Changes one field and leaves every other byte as it was. |
| `src/core/repeatRule.ts` | The repeat rule: the text after `🔁` read into a rule or refused, a rule written as its canonical text, and the date of the next round counted from the rule, the round's own date and today, or a dateless line's first date counted from the rule and today. Today is always handed in. |
| `src/core/markedLine.ts` | Going to the line a feature's hidden comment names: finding it in a note's text, opening the note, and putting the cursor there. |
| `src/core/calendarTable.ts` | The day's calendar table: finding it by its column names, reading its rows, and writing back one cell or every row at once. |
| `src/core/timeCell.ts` | The day's-log time cell, both ways: read to `{ startMin, endMin, allDay }` or a refusal, and written back from the same three. |
| `src/core/calendarSources.ts` | Where a calendar's bytes come from — a link, a vault file or a calendar account — and what happens when one fails. |
| `src/core/calendarSourcesSection.ts` | The calendar sources on that screen: one group of rows per calendar, and what its last read came to. |
| `src/core/calendarAccounts.ts` | A calendar account: its server address and user name, which travel with the vault, and the source row each calendar ticked on it becomes. Its app-specific password stays on the device, in Obsidian's keychain (`DeviceStore` in `settings.ts`). Whether a row can be read from this device is decided here, before anything is sent. |
| `src/core/calendarAccountsSection.ts` | The calendar accounts on that screen: the three boxes, *Fetch calendars*, and one switch per calendar the server lists. |
| `src/core/calDav.ts` | Signing in to a calendar server with an app-specific password and finding the calendars the account holds. |
| `src/core/calDavRead.ts` | Reading one calendar of a calendar account over a fixed span, seven days back to four hundred ahead, and unwrapping the server's answer into the same calendar text a link gives. |
| `src/core/icsReader.ts` | Calendar bytes in, a day's meetings out. It never learns which of the two places filled it. |
| `src/core/icsOccurrences.ts` | The only file that knows the two calendar libraries exist. Works out repeats, and survives one bad entry. |
| `src/core/meetingNoteFill.ts` | The one slot through which the day view asks meeting notes for the filled-in note of a meeting just clicked, so neither feature references the other. |
| `src/core/meetingName.ts` | What a meeting is called: the title, the note's filename, the target a wikilink points at, the plain text of its cell, and the location that trails it. |
| `src/core/collections.ts` | Which notes are collections, and how many open tasks each one holds, from Obsidian's own index. |
| `src/core/collectionsSection.ts` | The collections list at the foot of the core card, with each one's open count beside its name. |
| `src/core/collectionRename.ts` | Rewrites a renamed collection's link, or one whose folder changed, on the task lines that carry it: in a day's log every task line, wherever the log sits; in any other note that is not a collection and not in an excluded folder, only a `[>]` line with a hidden comment, outside frontmatter and fenced text; whatever shape the link was written in, found without reading every file. For a renamed note (or one given another folder) that is not a collection, it rewrites the link back a feature appended to a collection's copy, and reads only the collections the link index says link to the old path. |
| `src/core/linkReading.ts` | The one reading of the wikilinks and markdown links on a task line: path, heading, text, and where each sits. |
| `src/core/personMarks.ts` | Which people a line names: every `@` directly followed by a wikilink, in order, with where each sits, built on the link reading and leaving the question of a live task to the reader of followed tasks. |
| `src/core/markerLink.ts` | The link a feature appends right before its own hidden comment, and how a second feature copying the line tells it from a link the person typed. |
| `src/core/reason.ts` | The one place a caught thrown thing is turned into a sentence, so everything that has a failure to announce announces it alike. |
| `src/core/saveFailureAnnouncer.ts` | The one sentence for a setting that would not save, and the rule that one failed write is said once however many rows of the settings screen joined it. |
| `src/core/problems.ts` | How a feature says something is wrong and has it stay said, until that feature clears it again. |
| `src/core/problemsSection.ts` | Those reports on that screen, one row each. Draws nothing at all when there is nothing wrong. |
| `src/core/settingsTab.ts` | The settings screen: a pinned core card, a count line, one collapsed row per feature, each a row Obsidian's settings search finds by the names of the settings inside it. |
| `src/core/focusKeeper.ts` | Keeps the focus and the caret in the box you were typing in when the settings screen redraws a card under you. |

Work under the cursor does not go through `noteWriter`. Obsidian's `Editor` already edits the open note correctly and keeps your selection and undo history.

The features sit beside the core, one folder each under `src/features/`. There are eight folders there, one per feature in the table above, from `src/features/checkboxCycling/` to `src/features/taskConsistency/`.

## Adding a feature

1. Make a folder under `src/features/` — `src/features/checkboxCycling/` is the one that is there — and a class in it that extends `Feature` (`src/core/feature.ts`).
2. Give it an `id`, a `name`, a one-line `description`, and a `readiness()` that says what is missing when it is not ready.
3. Register everything it needs in `onload()`, through the `Component` methods it inherits — they detach by themselves when the feature is switched off.
4. Add one `registry.register(...)` line to `src/main.ts`.

## Working on it

```
npm install       # once
npm run dev       # rebuild main.js on every change
npm test          # run the suite
npm run lint      # type-check without emitting
npm run build     # type-check, then build a minified main.js
```

Requires Obsidian 1.13.0 or later. `docs/releasing.md` § `minAppVersion` says why, and how the floor moves.

## Versions

Effortless is on `0.x` and stays there: the minor number moves for anything you would notice, the patch number for fixes only. A release that needs you to go and re-do something says so in its first line — but that will not happen while the plugin has no way to tell you inside Obsidian, so until it does, an update never asks anything of you. `docs/releasing.md` holds the rules in full.

## Licence

MIT — see [`LICENSE`](LICENSE). Effortless bundles `ical.js`, which is MPL-2.0 — see [`NOTICE.md`](NOTICE.md). Settled by issue #21. The source is public as a release copy: the author develops in a private repository, and each release is exported from it into the public one.
