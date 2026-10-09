# Stitch

**The phone agent that grows new limbs, not new privileges.**

Stitch drives real Android phones. Ask it for something it cannot do yet and it notices the gap, explores the app,
writes the missing capability as a program, tests it, installs it in a versioned registry, and from then on runs it as
code with **zero model calls**. When an app changes, it repairs the capability and installs the next version. Anything
that sends, posts, pays, deletes or agrees to terms waits for a person, every time, unless that person chose otherwise
for that one capability.

Built from scratch on the night of October 8 to 9, 2026, for the Frankenstein case of Agents 0.0.7 (Etnetera, Prague).
The first commit is from 20:44. The brief is in [docs/hackathon-brief.md](docs/hackathon-brief.md).

## The loop, against the brief

| Brief | What Stitch does |
|---|---|
| **Gap detection** | A request matches no installed capability (checked by the capabilities' own patterns, no model call), so Stitch says so and starts building. The gap always comes from a request; nothing is pre-written. |
| **Create** | A model explores the app screen by screen through the accessibility tree (no screenshots), then a compiler turns the trace into a parameterized program: steps with stable selectors, templates like `{{hour}}`, trigger patterns, the app it needs and a permission manifest. |
| **Test** | Before install, the program runs on the device with a **different input** and must show its result on screen. A program that ends in a send or delete gets a **dry run** with the request's own values up to that step, which the test does not press. No passing test, no install. The test is in the run log. |
| **Install** | Code, test result and manifest go to `registry/<name>/`, every version kept (`v1.json`, `v2.json`). |
| **Reuse** | Every later request with any input runs the program as code: 0 model calls, $0. A **new chat is a fresh session** that only has what is on disk. |
| **Evolve** | When a step no longer finds its element, Stitch explores again from that app, recompiles, retests and installs v2. A person can roll back to any earlier version. |
| **Authority does not grow** | The agent starts with `read_screen, tap, type` and the effect `local`. A step that sends, posts, pays, deletes or agrees (by its label, or by what the model says the step is for) is never pressed by the agent on its own: it stops right before it, with everything else ready on screen, and asks. "Always allow" applies to that one capability and can be revoked. |

**Composition in a fresh session.** "Ask Claude for a short poem and send it to Petr on WhatsApp" is split into two
tasks, each run by its own installed capability, and the answer read back from the Claude app fills the WhatsApp
message. "Delete all alarms" turns a program learned on one alarm into a loop that repeats while one is left.

**Discovery and management tooling.** The studio lists every capability with its app, inputs, test result, versions,
permission switch and rollback. The same registry is served as an **MCP server** (`npm run mcp`): every capability
Stitch learns becomes a tool other agents can call, and the tool list updates while it learns. Every failed run has a
one-click report (steps with times, the model's raw decisions, the program, the screen), also saved to `runs/reports/`.

**Learn once, run everywhere.** With several emulators, a request goes to one first. If it has to learn, only that
one learns, and the others run the new capability as code once it works.

## Hard rules

| Rule | How |
|---|---|
| Generated code runs in a sandbox, never on a host holding credentials | A capability is **data**, not code: a list of steps (`tap`, `type`, `find`, `extract`...) run by a fixed interpreter. Nothing the model writes is executed on the computer, which holds the API key. The only model-written text that is evaluated is the trigger patterns, as regular expressions. The emulators are the sandbox for learning; the personal phone is guarded by the approval gate. |
| No install without passing tests, test run visible | `testAndInstall` and `dryRunAndInstall` in `src/agent.mjs`; every test step is in the chat log and the report. |
| The gap comes from a task | Learning starts only when a request matches nothing. The registry is empty at the start of a demo. |
| Self-iterations and spend capped in code | Per run: 40 model calls and $0.50 (`MAX_CALLS_PER_RUN`, `MAX_SPEND_PER_RUN`, checked before every call), 18 exploring steps, 3 compile attempts, 100 rounds of a loop. `test/limits.test.mjs`. |

## Measured on real devices

Samsung Galaxy (Android 16) over USB, and six Pixel emulators (Android 17). Learning explores with Claude Sonnet 5.5,
everything else uses Claude Haiku 5.5; costs are at API list prices.

| Capability | Learning (first time) | Reuse as code |
|---|---|---|
| Set an alarm (Samsung Clock) | 24.6 s, 8 calls, $0.053 | about 5 s, **0 calls, $0** |
| Set an alarm (Google Clock, emulator 1) | 24.2 s, 8 calls, $0.052 | the other five emulators: 3.6 to 4.4 s each, **0 calls, $0** |
| Send a WhatsApp message (asks at Send) | 18.7 s, 6 calls | about 6 s, **0 calls** |
| Ask Claude in its app and read the answer | 14.6 s, 6 calls | 6.1 s, **0 calls, $0**, the answer shown in the chat |
| Search Google Maps, repaired after the screen changed | v2 in 31.2 s, 5 calls, $0.042 | as code again |
| Read YouTube Studio metrics into a table | 16.9 s, 5 calls | as code |

**Honest totals for the night** (all devices): 179 runs, 92 succeeded, 87 did not; 33 capabilities learned, 4
repaired, 22 held at a send or delete; 52 of 55 reuses ran with zero model calls; $2.07 and 1,170 model calls in total.
Most failures happened while the loop was being built; each one led to a fix in the history.

## How it works

- **Hands** (`hands/`, Kotlin): an accessibility service and its own keyboard on the phone. It reads the screen in about
  20 ms, taps, holds, types, opens apps, scrolls with gestures, and draws live boxes around the elements the agent sees
  (a switch in the studio). ADB is only the cable and the video.
- **Engine** (`src/`, Node): explorer, compiler, runner, registry, policy, extraction, a JSON and server-sent events API,
  live video (scrcpy server to ffmpeg). One engine per device; the emulators share one registry.
- **Studio** (`studio/`, Next.js 16 + Tailwind 4): chats, the live phone or a grid of emulators, step screenshots,
  the permission prompt, data tables with CSV, the capability registry with versions, permissions and rollback.
- **MCP server** (`mcp/server.mjs`): `phone_do` plus one tool per learned capability.

## Run it

```bash
ADB=/path/to/adb hands/install.sh      # build, install and enable Hands and its keyboard on the USB phone
cp .env.example .env                   # model endpoint and key, ADB path, serial
npm install && npm start               # engine on :4400
cd studio && npm install && npm run dev  # studio on http://localhost:3400
scripts/emulators.sh up 6              # optional: six emulators with their own engines
npm test                               # offline tests
```

`hands/restore-keyboard.sh` puts the phone's own keyboard back.

## What is simulated, missing or fragile

- **"Simulate app update"** on a capability card renames one of its selectors to show the repair; it does not install an
  app update. Repairs after real screen changes also happened tonight (Google Maps above).
- **Google Clock on the emulators** sets times on its dial, which only labels every fifth minute: 6:20 and 6:35 work,
  6:43 does not. Its keyboard mode confused the model (two fields with the same id). Samsung Clock takes any time.
- **"Delete all"** deleted six alarms in a row; on the last one the card did not open selection mode twice and the run
  stopped. It now retries once and then reports how many it did.
- **Composition** passes the previous task's answer or first table row to the next task; longer chains and branching
  are not built.
- **Reading an app's answer** takes the longest new block of text after the send; it works for chat apps, not for
  every screen.
- Exploring with Haiku alone took detours (searching for a chat that was already on screen, looping); the stronger
  model fixed that for learning, which is a one-time cost per capability.
- One task at a time per device. Elements are found by resource id and stable label text; apps that draw everything in
  one view (games, some web views) are out of reach. Tested on Samsung and Pixel images only.
- No voice (ElevenLabs) was built.

Built with Claude Code by Petr Kynčl (MationX).
