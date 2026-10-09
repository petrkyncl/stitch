# HQ submission texts (paste into hq.agents007.ai/submit)

## Project name
Stitch

## One-line pitch
An Android agent that learns a task in any app once, turns it into tested code, and repeats it in seconds with no AI cost.

## What it does (problem, who it is for, how)
Phone automation today is either hand-written per app (brittle scripts, selectors that break with every update) or an LLM driving the screen every single time (slow, expensive, unpredictable). Stitch is for people and small teams who run the same phone tasks again and again, on one phone or a fleet of devices.

Ask Stitch for something on an Android phone. If no installed capability covers it, that is the gap: it explores the app through the accessibility tree, maps it up to the step that saves or sends without pressing it, compiles that into a parameterized program (selectors, templates, trigger patterns, a permission manifest), tests the program from the start on the device, installs it in a versioned registry, and only then lets it press Save (Send asks a person first). Every later request, with any input, runs that program as code: zero model calls, a few seconds, $0. When an app changes, a failing step triggers a repair and v2 is installed; a person can roll back to any version.

Its capabilities grow; its authority does not. It starts with read, tap and type. Any step that sends, pays, deletes or agrees to terms is never pressed by the agent: it stops right before it with everything prepared on screen and asks (allow once, always allow for that one capability, deny). In a fresh session, different requests combine earlier capabilities: "ask Claude for a poem and send it to Petr on WhatsApp" runs two learned capabilities and passes the answer between them. Learned capabilities are also an MCP server, so other agents get each new skill as a tool. With six emulators, one learns and the others reuse it as code.

## What works end-to-end
On a real Samsung phone and six emulators: "Set an alarm for 7:35" with an empty registry: gap, exploration up to Save, compiled program, test from the start, install, one alarm set (about 21 s, 6 calls, $0.04); the other five emulators then ran it as code in about 4 s each with 0 calls and $0. "Send Petr a WhatsApp message saying good night": learns the path (open, tap the chat, type), dry-run test up to Send, then asks before sending; later runs are code. "Prompt Claude to give me a joke and give me the result": types into the Claude app, asks at Send, reads the answer back into the chat (reuse 6 s, 0 calls). "Get 10 pizza places from Google Maps with rating" returns a table with CSV. A Maps capability broke when the app opened in a different state and repaired itself to v2. Every run has a step log with screenshots and a one-click report.

## What is simulated, missing or fragile
"Simulate app update" renames a selector to demonstrate repair; it is not a real app update (a real repair also happened, see Maps). Google Clock on the emulators only sets times on its dial's 5-minute marks. "Delete all alarms" loops until none are left but once stopped on the last item (now retries once and reports progress). Composition passes one result to the next task; no longer chains or branching. Reading an app's answer is a heuristic for chat apps. Learning uses a stronger model (Sonnet 5.5) because Haiku took detours; reuse needs no model. One task at a time per device; apps that draw everything in one view are out of reach. Overall tonight: 179 runs, 92 succeeded, 87 failed, most of them while building the loop; every failure is in the history.

## Stack and partner tools
Node.js engine, Kotlin Android accessibility service and keyboard (Stitch Hands), Next.js 16 + Tailwind 4 studio, scrcpy server and ffmpeg for live video, MCP TypeScript SDK, Claude Haiku 5.5 and Claude Sonnet 5.5, Android emulators. Built with Claude Code.
