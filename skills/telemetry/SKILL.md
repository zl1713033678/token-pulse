---
name: telemetry
description: Open the Token Pulse side panel to inspect Antigravity context window breakdown, generation speed (tok/s), cache hit rate, 5h/weekly model-pool consumption & rolloff countdown, and multi-day token analytics.
---

# Token Pulse Telemetry

Use this skill whenever the user asks to view Antigravity token usage, context window occupancy, prompt cache hit rate, generation speed (`tok/s`), TTFT/latency, 5-hour / weekly model-pool consumption & window rolloff countdown, or multi-day trends.

## Procedure

1. Call `open_telemetry_panel` from the `token-pulse_telemetry` MCP server.
2. Map the user's intent to optional arguments (all arguments are optional):
   - `tab`: `"live"` (default: DSH-style real-time status strip, full inline context breakdown + `/compact` command reminder, and 5h/weekly model-pool consumption & rolloff timers) or `"trends"` (7d/14d/30d stacked chart, model/project/session drill-down, and SQLite diagnostics).
   - `surface`: `"all"` (default), `"desktop"`, or `"cli"`.
3. Keep your chat response concise (1–2 sentences summarizing the active session or directing the user to the opened side pane), because the interactive MCP App UI displays the full dashboard.
