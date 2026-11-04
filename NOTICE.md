# Notices

Effortless itself is MIT-licensed; see `LICENSE`. The plugin ships as a single
bundled `main.js`, so the libraries below are compiled into the file Obsidian
loads and are distributed with it. This file acknowledges them.

## ical.js — Mozilla Public License 2.0

- Copyright the Mozilla Foundation and contributors
- <https://github.com/kewisch/ical.js>
- Licence text: <https://www.mozilla.org/MPL/2.0/>, and in the package's own
  `LICENSE` file under `node_modules/ical.js/`

`ical.js` parses `.ics` files and expands repeating events. It is the only part
of Effortless not under the MIT licence.

**MPL-2.0 is file-level copyleft.** It asks that the source of the MPL-licensed
files themselves stays available under the MPL, and it puts no such condition on
the code around them. `ical.js` is used unmodified, and its source is public at
the address above, so nothing further is owed. Effortless's own source stays MIT.

**If a future change ever modifies an `ical.js` file rather than just calling
it**, that modified file must be published under the MPL. Keeping the library
unmodified is the cheapest way to keep this a one-paragraph obligation.

## ical-expander — MIT

- Copyright Mikael Finstad
- <https://github.com/mifi/ical-expander>

`ical-expander` turns a parsed calendar into the occurrences a day actually
holds: it applies `RRULE` and `EXDATE`, lets a `RECURRENCE-ID` override replace
the occurrence it belongs to, and resolves `VTIMEZONE` against a timezone table
it ships. It uses `ical.js` underneath, and the two are pinned to one shared
copy through the `overrides` entry in `package.json`.
