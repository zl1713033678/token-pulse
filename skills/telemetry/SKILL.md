---
name: telemetry
description: Open the Token Pulse side panel to inspect Antigravity context window usage, cache hit rate, latency, 5h rolling pace, and 7-day token analytics.
---

# Token Pulse Telemetry

Use this skill whenever the user asks to view Antigravity token usage, context window occupancy, prompt cache hit rate, TTFT/latency, 5-hour rolling pace, 7-day consumption trends, or telemetry diagnostics.

## Procedure

1. Call `open_telemetry_panel` from the `token-pulse_telemetry` MCP server.
2. Map the user's intent to optional arguments (all arguments are optional):
   - `tab`: `"overview"` (default), `"context"` (context ring, breakdown, `/compact`), `"pace"` (5h rolling pace & model family share), or `"trends"` (7d/14d/30d stacked chart & model/project/session drill-down).
   - `surface`: `"all"` (default), `"desktop"`, or `"cli"`.
3. Keep your chat response concise (1–2 sentences summarizing the active session or directing the user to the opened side pane), because the interactive MCP App UI displays the full dashboard.
