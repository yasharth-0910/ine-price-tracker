# Stitch prompts

Web tab, not App. Generate all screens of a direction in one project so the design language holds.
Export Tailwind, save to `frontend/design/`, use it as a visual target for Claude Code rather than
copying markup.

## Rules that apply to every direction

Put this at the top of the first prompt in a project.

```
Constraints for every screen:
- Never invent infrastructure. No cluster names, node IDs, worker pools, heartbeat counters,
  request rates or anything that implies a distributed system. This runs on one small instance
  and a cron job. Only show numbers the app actually has: run duration, attempt counts, next
  scheduled run, record counts, the extraction method that worked.
- No ALL CAPS labels. No meta strings joined with middle dots. No arrows appended to button text.
- Vary weight between states. A product with failing scrapes must be visually different at a
  glance, not just tinted.
- No drop shadows. Structure comes from rules, borders and spacing.
- Copy is plain and active: "Track", "Pause tracking", "Scrape now". Empty states say what to do.
- Ship both themes. Generate every screen in light and in dark.
```

---

# Direction A: Instrument panel

The one I'd pick. Keeps what's already working, fixes the tells, and puts scrape reliability
where the eye lands first, which is the thing being graded.

The structural idea: a run strip. A horizontal band across the top made of one small block per
2-hour scrape window over the last few days, coloured by outcome. Green block, amber block for a
retry, red for a failure, hollow for a window that hasn't happened yet. It replaces the status
text entirely, it's honest, it makes the schedule legible at a glance, and no generated dashboard
has one. That's the single bold element. Everything else stays quiet.

**Palette**

| role | light | dark |
|---|---|---|
| base | `#F6F7F5` | `#0E1113` |
| surface | `#FFFFFF` | `#161B1E` |
| ink | `#15181B` | `#E7EAE8` |
| muted | `#5E6A6B` | `#8A9495` |
| rule | `#DDE1DE` | `#252C30` |
| ok | `#2F6B4F` | `#4E9B76` |
| retried | `#9C6B1F` | `#C79242` |
| failed | `#9E3A2E` | `#C4594A` |

One accent family (pine) doing double duty as the healthy state, so colour means status and
nothing else. Nothing is coloured for decoration.

**Type**: IBM Plex Sans for everything structural, IBM Plex Mono for prices, timestamps and
durations. Same family, two voices, no clash. Base size 13px, tight leading, tabular figures on.

**Stitch prompt, dashboard**

```
A web dashboard for a tool that scrapes an online store every 2 hours and records prices.
Light theme. Background #F6F7F5, cards #FFFFFF, text #15181B, hairline borders #DDE1DE, no
shadows, 4px corner radius. IBM Plex Sans for labels, IBM Plex Mono for all numbers and times.
Small dense type, 13px base. Status colours: green #2F6B4F, amber #9C6B1F, red #9E3A2E.

Top of the page is a run strip: a full width horizontal band of about 36 small rectangular
blocks in a row, each one representing a 2-hour scrape window over the past three days. Most are
solid green, three are amber, one is red, and the last five are hollow outlines meaning not yet
run. Under the strip, small muted text reading "Next run 16:00, 7 products".

Below that, a search input with placeholder "Search the store to track a product".

Then a list of tracked products, not a card grid. Each product is a full width row separated by
a hairline rule. Left side: product name in medium weight, and under it the store URL in small
muted mono. Middle: current price large in mono, with the 24 hour change beside it in green or
red. Right side: a wide flat sparkline of the last 24 hours, then a stock label, then small mono
text with the time of the last scrape and the record count.

One row is in a failing state: its left edge has a 3px red vertical bar, its name is in the red
colour, and an extra line under it reads "3 failed attempts, last error http_500". Another row
is out of stock and its price is shown in muted grey with a strikethrough-free "Out of stock"
label. Show six rows total.
```

**Stitch prompt, product detail**

```
Same design system. Product detail page. Back link, product name as heading, current price very
large in mono with the stock state beside it, and a row of four plain stat blocks separated by
vertical hairlines rather than boxed cards: 24h change, 7 day low, 7 day high, scrape success
rate.

Main chart is a price line over time, thin 1.5px line, no gradient fill under it. Where the
product was out of stock the plot area behind the line is a light grey band. Where a scheduled
scrape failed, the line is broken with a visible gap and a small red tick on the x axis, so
missing data looks missing instead of being interpolated. Range toggle for 24h, 7d, All.

Below, two tables side by side rather than tabbed. Left is price history: time, price, stock,
method. Right is the scrape log: time, attempt, outcome, duration, detail. Outcome is a small
square colour block plus a word, not a pill. Include a failed row reading "http_500, gave up
after 3 attempts" and a retried row reading "attempt 2 of 3, succeeded after 3.1s". Mono
throughout the tables.
```

Then: `Now produce every screen in a dark theme. Background #0E1113, surfaces #161B1E, text
#E7EAE8, borders #252C30, and status colours green #4E9B76, amber #C79242, red #C4594A. Keep the
layout identical.`

---

# Direction B: Market terminal

Price tracking is literally price watching, so borrow from trading terminals. Dark first, light
as the secondary. Numbers are the hero and everything else gets out of the way.

Avoid the obvious version of this. Black plus one acid green is the generated-dashboard default.
Real terminals are ivory and amber on deep blue-black, which is both older and less common.

**Palette**

| role | dark (primary) | light |
|---|---|---|
| base | `#0B0E14` | `#EDEBE5` |
| surface | `#11161F` | `#FFFFFF` |
| ink | `#E8E4DA` | `#16181C` |
| dim | `#78808E` | `#6A6E76` |
| up | `#3F9E6B` | `#2C7A50` |
| down | `#C4553F` | `#A33F2C` |
| key | `#D9A441` | `#9A6B12` |

**Type**: Archivo for headings and labels, JetBrains Mono for every number. Numbers are larger
than the labels around them, always tabular, always right aligned in tables.

**Stitch prompt**

```
A dark price monitoring terminal. Background #0B0E14, panels #11161F, ivory text #E8E4DA, dim
labels #78808E, gains #3F9E6B, losses #C4553F, amber key colour #D9A441. Archivo for labels,
JetBrains Mono for all figures. Zero corner radius. Panels are separated by 1px lines, never by
gaps or shadows. Very dense, closer to a trading screen than a website.

Layout is a fixed grid with no page scroll. Left column, one third width: a watchlist of tracked
products as compact rows, each showing a short product code in amber, the name truncated, the
current price in mono right aligned, and the percent change in green or red. The selected row
has an amber left border.

Right area, two thirds: top half is a large price chart for the selected product, thin line,
dark grid lines, price axis on the right like a trading chart. Below the chart a thin horizontal
band showing stock state over the same time period as solid segments, green for in stock, grey
for out of stock, and hatched for periods where the scrape failed and the state is unknown.

Bottom right is a log panel with a header row and dense mono rows: time, attempt, outcome,
duration, detail. Outcomes are plain coloured text, not badges. Include failures and retries.

Very top of the screen is a single status line in mono: last run time, products succeeded,
products failed, next run time. No logos, no illustrations, no rounded anything.
```

Then: `Now the same screens as a light theme on #EDEBE5 paper with #16181C text, keeping the
amber key colour darkened to #9A6B12 for contrast.`

---

# Direction C: Strip chart

A paper chart recorder, the kind an instrument uses to draw a continuous trace. The idea is that
a price history is a recording, and a failed scrape is a gap in the recording. The visual
metaphor does the explaining for you, which is exactly what the assignment wants you to
demonstrate understanding of.

Riskier. Only take it if Direction A's output comes back boring, because this can tip into
skeuomorphic if Stitch overdoes the paper texture.

**Palette**: paper `#EFF1EC`, ink `#1B1E1A`, grid `#C9D0C5`, trace `#2E4A7D` (pen blue),
fault `#B23A2F`, muted `#6E756B`. Dark: ground `#14171A`, trace `#6E9BD6`, grid `#232A26`.

Keep it off cream and away from terracotta. Cream paper with a big serif and a clay accent is the
single most common generated look right now.

**Type**: Spectral for headings and prose, JetBrains Mono for the ledger and all figures. The
serif is what separates this from every other dashboard, so let it carry the product names at a
real size.

**Stitch prompt**

```
A price monitoring dashboard styled as an instrument chart recorder. Pale grey-green paper
#EFF1EC, dark ink #1B1E1A, faint grid lines #C9D0C5 across the whole page like graph paper,
trace colour ink blue #2E4A7D, fault red #B23A2F. Spectral serif for product names and headings
at generous size, JetBrains Mono for all data. No cards, no shadows, no rounded corners. Content
sits directly on the grid, separated by thin ruled lines.

Each tracked product occupies a horizontal strip across the full page width, like one channel of
a chart recorder. On the left, the product name in serif with the store domain beneath it in
small mono. Across the rest of the strip, a continuous price trace drawn in ink blue over the
grid, with the current price printed at the right end of the trace. Where a scrape failed, the
trace has a clean gap and a small red vertical tick mark at that position on the timeline, with
no interpolation across it.

Above the strips, a ruled header with the recording status in mono: interval, last run, next
run, products recording. Below the strips, a ledger table in mono with hairline rules and no
fills: timestamp, product, price, stock, method, outcome. Failures are typeset in the fault red
with the error text spelled out in full.
```

Then: `Produce the same screens on a dark ground #14171A with grid #232A26, trace #6E9BD6 and
paper-white text, keeping the ruled structure identical.`

---

## Both themes, done properly

Don't let Stitch or Claude Code invert the light theme to make the dark one. Three things break
if you do.

Chart lines need more weight in dark. A 1.5px line that reads clearly on white disappears on a
dark ground, so go to 2px and lift the lightness of the trace colour.

Status colours need different saturation. The green that works on white is muddy on near-black,
and the red that works on near-black glows on white. That's why each palette above lists both.

Grid and rule lines are not symmetric. On light, rules go darker than the background by a little.
On dark, they go lighter by less than you expect, or the whole screen turns into a cage.

Implementation, once you pick a direction:

```
Define the palette as CSS custom properties on :root with semantic names, not colour names:
--bg, --surface, --ink, --muted, --rule, --status-ok, --status-retried, --status-failed,
--trace. Redefine all of them under .dark. Wire Tailwind to those variables in
tailwind.config.js with darkMode: 'class'. No hex values anywhere in component files.
Theme toggle writes to localStorage and defaults to the system preference.
```

Do that before building the second screen. Retrofitting themes across finished components on
Saturday night is how the frontend eats four hours it doesn't have.

---

# Direction D: Monochrome console (Backpack-influenced)

Takes what actually works about Backpack's interface and drops what doesn't transfer.

Keep: near-black low-chroma ground, ivory text, high density, hairline dividers, almost no corner
radius, numbers carrying the page, a very small number of colours.

Drop: gradient washes, glow and bloom, glass panels, and the brand red.

The red matters. Backpack uses red as its brand colour, on buttons and highlights. Here red has
to mean a failed scrape. Using it for both destroys the only signal that counts. So the shell is
strictly monochrome and status is the only colour anywhere on screen. When a red block appears in
the run strip it is the single chromatic event in view, which is exactly the right weight for it.

**Palette**

| role | dark (primary) | light |
|---|---|---|
| base | `#0A0A0B` | `#FAFAF9` |
| surface | `#131316` | `#FFFFFF` |
| raised | `#1A1A1F` | `#F3F3F1` |
| ink | `#F2F2F0` | `#0A0A0B` |
| dim | `#8A8A93` | `#6E6E76` |
| rule | `#232329` | `#E5E5E2` |
| ok | `#3FBF7F` | `#1F8A56` |
| retried | `#E0A33E` | `#9A6A18` |
| failed | `#E5484D` | `#B8322F` |

Nothing else gets colour. No accent, no brand hue, no tinted buttons. Buttons are ink on raised
surface with a 1px rule.

**Type**: Geist for interface text, Geist Mono for every number, timestamp, duration and error
code. Tight tracking on headings, tabular figures everywhere, 13px base.

**Stitch prompt**

```
A dark monitoring console for a tool that scrapes an online store every 2 hours. Strictly
monochrome interface: background #0A0A0B, panels #131316, raised elements #1A1A1F, ivory text
#F2F2F0, dim labels #8A8A93, hairline dividers #232329. Geist for text, Geist Mono for every
number. 2px corner radius. No gradients, no glows, no glass effects, no shadows. Very dense,
13px base type.

The only colours on the entire screen are status: green #3FBF7F, amber #E0A33E, red #E5484D.
Buttons are ivory text on #1A1A1F with a thin #232329 border, never filled with colour.

Top of the page: a run strip made of about 36 small rectangles in a row, one per 2-hour scrape
window across the past three days, coloured green, amber or red by outcome, with the final five
as empty outlines for windows that have not run yet. A single line of mono text beneath it:
"Next run 16:00 . 7 products . last run 4.2s".

Below: a list of tracked products as full width rows divided by hairlines, no cards. Each row has
the product name in ivory, the store path beneath in dim mono, the current price large in mono,
the 24h change in green or red, a flat sparkline, the stock state, and the last scrape time.
One row is failing: a 2px red bar on its left edge and an extra dim line reading "3 failed
attempts . http_500".

Bottom of the page: a live log strip, six dense mono rows of recent scrape attempts, each one
time, product, attempt number, outcome word in its status colour, and duration.
```

Then: `Produce the same screens as a light theme on #FAFAF9 with #FFFFFF panels, #0A0A0B text,
#E5E5E2 rules, and status colours darkened to green #1F8A56, amber #9A6A18, red #B8322F. Keep
the monochrome discipline: still no accent colour anywhere.`

**Where to get the real values**

Open backpack.exchange, inspect, and pull the computed background, text and divider colours
directly rather than trusting any palette written down second hand, including the one above.
