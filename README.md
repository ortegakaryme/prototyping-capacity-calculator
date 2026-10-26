# Prototyping Capacity Calculator

**Will each delivery date be met with the people we have, and if not, what should we do?**

A decision tool for a luxury leather goods prototyping workshop in Florence, where artisans make by hand the first piece (prototype or sample) of every bag, wallet, belt or suitcase before a collection is produced. Every morning it shows which delivery is at risk, which station is the bottleneck, how many hours are missing, and lets the team test options before deciding.

> Portfolio case study by **Karyme Ortega**, Industrial Engineer. The data is anonymized: piece names, models and collections are not real. Hours, dates and statuses follow a real PLM download (28 Nov 2025).

## The problem
- ~280 pieces in progress across 8 delivery dates, each going through four stations in order: **CAD / DXF → Cutting → Preparation → Assembly** (1, 3, 3 and 4 people).
- The PLM recorded where each piece was, but never compared the work left with the hours the team actually had.
- One overloaded station could block a whole delivery, and delays were noticed only days before the date.

## The approach
1. **Diagnosis.** Mapped the process and the data. The existing tracking spreadsheet under-estimated the total workload by a third (1,382 h reported vs. 2,071 h real), because every piece was given the standard time of the first one.
2. **Version 1 (Excel).** A capacity model built on the PLM download: standard hours per type × category × difficulty, capacity per station without weekends and holidays, cumulative load per delivery, and a traffic light.
3. **Version 2 (this app).** Built with AI-assisted development (Claude Code), turning the Excel into a decision tool: from an alarm ("you have a problem") to a copilot ("this is the problem and these are your options").

## What the tool shows
- **Current production:** pieces, deliveries and how many need attention, plus the four stations and their team.
- **Delivery picker:** choose any delivery date at the top.
- **Selected delivery:** a plain-language sentence (*"Monday 8 December is at risk. Assembly is 37 hours short. Add one person to Assembly, or move the date."*), key figures, where the pieces are today, and work vs. available hours per station.
- **All deliveries** at a glance.
- **Plan the team:** add or remove people, add overtime or move a delivery, and see every number update at once.
- **Live line (second tab):** the workshop as it runs, as if the page were connected to the PLM. A clock moves every piece through the stations; each card shows who is working on what, the queue in pieces, hours and days of work, and the pieces of at-risk deliveries in red. A feed lists each status change and pushes alerts (a queue above 3 days, a delivery turning red, people with no piece ready), and the delivery forecast is recalculated with every change. People can be moved between stations while the line runs.
- **Factory floor:** one bench per artisan at each station (working, free or absent), the queues as small squares and a moving belt from CAD to finished.
- **Absences:** the forecast starts in normal conditions (everybody in). Report that someone is sick, on holiday or in training for a day, two days or a week, and the page shows the hours the station loses and which deliveries change state.
- **What is on the line:** the product mix of the same pieces: small leather goods are 65% of the pieces, bags take the largest share of the hours left.

Key finding on the 28 Nov 2025 data: the 10 December delivery (124 pieces) needed 1,120 h with 704 h available. That is 455 h short across three stations, flagged almost two weeks in advance.

## How it calculates
- **Hours to do per piece** = standard hours of every station not yet done.
- **Load per station and delivery** = hours to do for that delivery and every earlier one ÷ hours the station has until the date (people × 8 h × working days).
- **Traffic light:** GREEN under 85%, AMBER 85–100%, RED over 100%, LATE if the date has passed with pieces open, DONE when everything is assembled.
- **Options:** extra people per station, overtime per person, and the earliest date that removes the risk.

Assumptions are shown on the page: stations are assumed to work in parallel (so the real risk is higher), and extra people are assumed to be trained and available at once.

## The live line and the PLM
Each status change in the PLM (pattern done, materials in, cut, prepared, accessories in, assembled) is an event. Connected, the page would receive those events and update in seconds. In this demo the feed is **simulated**: it starts from the PLM snapshot and each person works the next piece of their station, earliest delivery first, for its standard hours. Material and accessory arrivals are assumed (half a day to four days), as the download has no supplier dates. The forecast uses the same engine as the overview.

## Run it locally
No installation needed.

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Engine tests (Node 18+): `node --test tests/`.

## Files
| File | What it does |
|---|---|
| `index.html`, `app.js`, `app.css`, `tokens.css` | The interface |
| `engine.js` | Calculation engine, pure functions, also runs in Node |
| `live-sim.js`, `live.js` | Live line: simulated PLM feed (pure) and its tab |
| `data/demo-data.json` | Anonymized workshop data |
| `tests/engine.test.mjs` | Checks the engine against the precomputed deliveries |

## Next steps
- Simulate day by day with the real sequence of stations and material arrivals.
- Suggest the order of work per station.
- Replace the simulated feed with the PLM events and send the alerts by email or chat.
- Replace estimated standard times with measured ones.
