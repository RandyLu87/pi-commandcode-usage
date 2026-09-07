# pi-commandcode-usage

Persistent Command Code subscription usage line for [pi](https://pi.dev) — shows your **5-hour / weekly / monthly** quota as colored progress bars in a line **above the default footer**, auto-refreshing.

```
usage  5h ▓░░░░░░░░░░░ 9% $1.32/$14 resets in 1h 33m  7d ▓░░░░░░░░░░░ 4% $1.46/$35 resets in 5d 20h  mo ░░░░░░░░░░░░ 2% $1.46/$70 left $68.5  20:40
```

Standalone extension: it reads pi's OAuth credential for `commandcode` and calls Command Code's alpha usage endpoints directly. It does **not** depend on or modify [`pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) — both can coexist.

---

## Features

- **Three quota windows in one line**: 5-hour rolling window, weekly (7-day) window, and monthly credit allocation.
- **Colored progress bars** (`▓` filled / `░` empty): green < 70%, yellow 70–90%, red ≥ 90%, solid red when exhausted.
- **Reset countdown to the minute**: `resets in 1h 33m`, `resets in 5d 20h` — same wording as Command Code's official `/usage`.
- **Auto-refresh**: on startup, every 60 seconds, and after every agent turn settles. A timestamp at the end of the line shows when it was last fetched.
- **Toggle on/off** at runtime with `/ccq-bar` — no restart needed.
- **Graceful failure**: on a fetch error the last good data stays on screen with an error hint; it never interrupts your work.
- **Default footer untouched**: your pwd / token / model line stays exactly as pi renders it.

## Requirements

- [pi](https://pi.dev) coding agent (interactive TUI mode)
- A Command Code account with a subscription (the quota endpoint is what your plan's Provider API access exposes)
- Logged in: run `/login` in pi and select **Command Code** (or set `COMMAND_CODE_API_KEY`)

## Install

Copy the extension into pi's global extensions directory (auto-discovered at startup):

```bash
mkdir -p ~/.pi/agent/extensions
cp ccq-quota-bar.ts ~/.pi/agent/extensions/
```

Then restart pi, or run `/reload` in an existing session. The usage line appears automatically once loaded and a `commandcode` credential is found.

To uninstall, delete the file:

```bash
rm ~/.pi/agent/extensions/ccq-quota-bar.ts
```

### Using it with Oh My Pi

pi and [Oh My Pi](https://github.com/can1357/oh-my-pi) share the same extension API. Copy the file to `~/.omp/agent/extensions/ccq-quota-bar.ts` instead, then restart or `/reload`.

## Usage

The extension registers one command:

```
/ccq-bar <on|off|toggle|refresh|status>
```

| Command | What it does |
|---|---|
| `/ccq-bar` (no arg) | same as `status` |
| `/ccq-bar on` | show the usage line (default) |
| `/ccq-bar off` | hide the usage line and stop the refresh timer |
| `/ccq-bar toggle` | flip between on and off |
| `/ccq-bar refresh` | fetch usage immediately (also refreshes the on-screen line) |
| `/ccq-bar status` | print config + cached quota as a notification |

`/ccq-bar status` output:

```
Command Code usage line
  enabled: yes
  credentials: found
  last fetch: 8:40:07 PM
  state: 5h $1.32/$14 · 7d $1.46/$35 · mo $1.46/$70 ($68.5 left)
  usage: /ccq-bar on|off|toggle|refresh|status
```

## UI

The line is rendered as a widget placed **below the input editor and above the default footer** (pi's `setWidget({ placement: "belowEditor" })`). The default footer — working directory, session name, token/cache/cost stats, model — is untouched.

### Layout

```
  ┌──────────────────────────────────────────────────────────────┐
  │ transcript…                                                 │
  │                                                              │
  │ input editor                                                 │
  ├──────────────────────────────────────────────────────────────┤
  │ usage  5h ▓░░░…  7d ░░░…  mo ▓░…  20:40                     │  ← this extension
  ├──────────────────────────────────────────────────────────────┤
  │ ~/project (main) • mysession                                │  ← default footer (untouched)
  │ ↑12.3k ↓456 R89.1k … $0.012 41%/200k (model)                │
  └──────────────────────────────────────────────────────────────┘
```

### Line anatomy

```
usage  5h ▓░░░░░░░░░░░ 9% $1.32/$14 resets in 1h 33m   7d ▓░░░░░░░░░░░ 4% $1.46/$35 resets in 5d 20h   mo ░░░░░░░░░░░░ 2% $1.46/$70 left $68.5   20:40
└───┘  └window─┘ └bar + pct┘ └── used/cap ──┘ └ reset ┘   └window─┘ …                  └ window: used/cap + left ┘              └ last fetch time
```

| Segment | Meaning |
|---|---|
| `usage` | fixed label |
| `5h` / `7d` / `mo` | quota window: rolling 5-hour, rolling 7-day, monthly allocation |
| `▓░░░… 9%` | progress bar (12 cells) + percent of window used |
| `$1.32/$14` | credits used / window cap |
| `resets in 1h 33m` | when the window resets (minutes precise; `5d 20h` for windows > 24 h) |
| `left $68.5` | monthly remaining credits (shown when cap is known) |
| `20:40` | last successful fetch time |

### Colors

The bar's filled cells are colored by usage ratio of that window:

| Usage | Color |
|---|---|
| < 70% | `success` (green) |
| 70 – 90% | `warning` (yellow) |
| ≥ 90% | `error` (red) |
| exhausted (`used ≥ cap`) | `error` (red), bar filled solid |

Colors follow your active pi theme's `success` / `warning` / `error` palette.

### Monthly cap note

Command Code's usage API returns **remaining** monthly credits but **not** the monthly cap, so the monthly denominator is mapped from your plan (see `PLAN_MONTHLY_CAP` in the source, aligned with Command Code's [pricing table](https://commandcode.ai/docs/resources/pricing-limits)). Current mappings: Go `$10`, GOAT `$70`, Pro `$80`, Max 10× `$100`, Max 20× `$200`, Team Pro `$40`. If your plan is not in the map, the monthly segment degrades to `mo left $X` (no bar) instead of guessing.

### When something goes wrong

| Situation | What you see |
|---|---|
| No `commandcode` credential | `usage fetch failed (commandcode credentials not found (run /login?)) — run /ccq-bar refresh to retry` |
| 401/403 from the API | `usage fetch failed (commandcode credentials rejected (401/403)) …` |
| Network / timeout error | last good data stays on screen; error hint appended until the next successful fetch |

## Configuration

Defaults are constants at the top of `ccq-quota-bar.ts` — edit and reload if you want to change them:

| Constant | Default | Meaning |
|---|---|---|
| `REFRESH_INTERVAL_MS` | `60_000` | auto-refresh interval |
| `FETCH_TIMEOUT_MS` | `8_000` | per-fetch timeout |
| `PLAN_MONTHLY_CAP` | (see above) | plan → monthly cap map |

## Relationship to pi-commandcode-provider

[`pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) is the provider that lets pi talk to Command Code models, and it already ships a one-shot `/commandcode-quota` command that prints a dashboard notification.

This extension is a **companion**: it shows the same data as a persistent, auto-refreshing line so you can see your quota at all times without typing a command. It reads the same OAuth credential and hits the same alpha endpoints, but is fully standalone — no dependency on the provider package. Install both, or this one alone if you reach Command Code through another route.

## License

MIT
