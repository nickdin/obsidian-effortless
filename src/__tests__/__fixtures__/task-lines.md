> A corpus of task lines for the round-trip test in `taskLine.test.ts`.
>
> Every line that does not start with `>` is one case. Between them they cover
> the five fixed checkbox characters and two the plugin has never seen, all four
> list markers, odd indentation, all five priorities, tags, both known dates, a
> handful of Obsidian Tasks fields the plugin does not understand, an emoji no
> plugin writes today, a repeat rule in four positions, and bookkeeping comments
> in three positions.
>
> Nothing here is taken from a real vault: every subject is invented.

- [ ] Write the report
- [x] Write the report
- [/] Write the report
- [-] Write the report
- [>] Write the report
- [S] An unknown checkbox character
- [?] Another unknown one
* [ ] A star marker
+ [ ] A plus marker
1. [ ] An ordered marker
1) [ ] An ordered marker closed with a bracket
	- [ ] One tab of indentation
		- [x] Two tabs of indentation
  - [ ] Two spaces of indentation
 	 - [/] A space, a tab and a space
- [ ] Scheduled ⏳ 2026-01-05
- [ ] Due 📅 2026-02-06
- [ ] Both ⏳ 2026-01-05 📅 2026-02-06
- [ ] No space before the date ⏳2026-01-05
- [ ] Two spaces before the date  ⏳ 2026-01-05
- [ ] Highest priority 🔺
- [ ] High priority ⏫
- [ ] Medium priority 🔼
- [ ] Low priority 🔽
- [ ] Lowest priority ⏬
- [ ] Tagged #work
- [ ] A nested tag #work/admin and a second one #errand
- [ ] A done date the plugin has never heard of ✅ 2026-01-07
- [ ] A recurrence rule 🔁 every week
- [ ] Water the plants 🔁 every week ⏳ 2026-11-03 #home %% note %%
- [ ] Water the plants ⏳ 2026-11-03 #home %% note %% 🔁 every week
- [ ] A rule the grammar refuses 🔁 every weekday please ⏳ 2026-11-03
- [/] Pay the bills 🔁 every month on the 1st when done %% eid:m1abc2de %%
- [ ] A created date ➕ 2026-01-01 and a start date 🛫 2026-01-02
- [ ] A blocker 🆔 abcdef ⛔ 123456
- [ ] An emoji no plugin writes today 🪐 rings
- [ ] A trailing breadcrumb → [[Somewhere]]
- [ ] A link into a heading [[Somewhere#A heading]]
- [ ] An address carrying a fragment https://example.com/page#section
- [/] Copied to the day's log [[Somewhere]] %% eid:m1abc2de %%
- [ ] A comment in the middle %% eid:m1abc2de %% and words after it
- [ ] Two comments %% eid:m1abc2de %% %% note:kept %%
- [ ] A comment holding what looks like a field %% eid:x ⏳ 2026-01-05 #work ⏫ %%
- [ ] Everything at once ⏳ 2026-01-05 📅 2026-02-06 ⏫ #work ✅ 2026-01-07 🔁 every week [[Somewhere]] %% eid:m1abc2de %%
	- [S] An unknown box, odd indentation, a stranger's field 🪐 rings ⏳ 2026-01-05 %% eid:m1abc2de %%
- [x]
- [ ]
