# Agents 0.0.7, Dusk Till Dawn: the brief Stitch is built for

Case 03, **Frankenstein**: build an agent that can build itself: recognize what capability it is missing, create it,
test it, install it, and use it again later. CREATE / TEST / INSTALL / EVOLVE.
Jury: David Bečvařík (Etnetera), Luděk Šafář (prg.ai).

## The real problem
Writing a tool to finish one task is not enough. The agent must build and evolve an ecosystem that makes its
capabilities discoverable, composable and manageable across sessions. **Its capabilities may grow; its authority may not.**

## Definition of done
- A task exposes a missing capability. The agent creates, tests and registers it, then completes the task.
- It also builds or extends the tooling for discovering and managing its capabilities.
- In a **fresh session**, a **different task combines previously generated capabilities**, without rebuilding or manual wiring.

## In bounds
Gap detection; generating code tools, MCP servers or skills; automatic tests before install; a persistent tool registry
with versions and rollback; eyes, hands or a voice; agent-built discovery and management tooling.

## Out of bounds
Tools pre-written by the team; picking from a fixed tool library (routing, not building); fine-tuning; rewriting its
own core loop or system prompt without tests; toy capabilities; demonstrating only a harness's built-in features.

## Hard rules (non-negotiable)
1. Generated code runs in a sandbox, never on a host holding your credentials.
2. No install without passing tests; the test run is visible in the log.
3. The gap must come from a task, not from a hardcoded "now build tool X".
4. Self-iterations and spend per run are capped in code.

## Real vs. faked
The gap is real: show the tool registry before the run. Code the team wrote or seeded is the one unforgivable fake.
Speed up waiting in the video; never cut failures.

## What wins
A useful, agent-built ecosystem, not a one-off script. Show creation, fresh-session composition and real operator control.
A capability can be a code tool, an MCP server or a prompt-skill, with explicit interfaces, declared permissions and
executable tests. A human approval gate is encouraged; detection, creation and testing stay with the agent.

## Judging (each 0 to 5, weighted)
35% value and track relevance, 25% originality, 20% working end-to-end result, 10% technical execution,
10% validation and honest limitations.

## Deliverables and timing
Code freeze at sunrise, **07:14** (snapshot of the latest commit). Public GitHub repository plus a demo video of at most
**90 seconds** (unlisted YouTube), both submitted in HQ. Suggested video: 15 s problem, 60 s live demo, 15 s what is
real, simulated, next. Submission form: project name, one-line pitch, what it does (3000), what works end-to-end (2000),
what is simulated, missing or fragile (2000), stack. Pick the topic on the team page first.
Side prize (optional): Best ElevenLabs Use (give the agent a voice).
