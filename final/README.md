# P3 — Paper Path Pulse

Production-style paper-path diagnostics console built from the supplied P3 specification and printer log corpus.

## Key fixes in this build

- **Log Analyzer worker is actually served by the Node backend** at `/p3-worker.js`; the browser no longer receives a 404 when starting a drag/drop analysis.
- The operator-facing extraction regex is **static and locked** to:
  ```text
  (ppcmd|PPort|SLPQ|pickpage|ImagePositionError|imagepositionerror|qdmg|staging|Page\s+ID|PageId|PgSup\s+Page)
  ```
- The structured parser still admits authoritative `Image-Position Error at ...` and page-context lines needed to preserve real paper-path measurements even when the static regex text does not literally contain the hyphenated spelling.
- **By Page ID** IPE trend is now a paper-path sequence: stages within a page connect in order, and an explicit **2ndXfer → next page Printer Entry** transition is drawn as a dashed bridge.
- Printer Entry remains an **event** when the source provides no numeric IPE; when a real numeric Printer Entry IPE exists, P3 plots it as measured data.
- Dashboard now keeps a **Page history** strip, previous/next page navigation, and a scrollable stack of previous page timelines.
- Selecting a historical page keeps that page selected across live refreshes and opens its complete details/traces.
- Added `test.js` regression checks for the static regex, page correlation, 2ndXfer→next Printer Entry transitions, Page 0x0A lifecycle, SLPQ and QDMG attachment.

## Run

```bash
node server.js
```

Then open:

```text
http://127.0.0.1:8787/
```

## Optional environment variables

```text
PORT=8787
LISTEN_HOST=127.0.0.1
PRINTER_IP=10.194.23.205
SSH_USER=root
SSH_PASSWORD=...
P3_LOG_PATH=/path/to/printer.log
```

## Test

```bash
node test.js
```

To test a different corpus:

```bash
P3_TEST_LOG=/path/to/printer.log node test.js
```

The parser is deliberately evidence-first: unknown PaperPort/SLPQ/QDMG bit fields remain raw instead of being assigned speculative meanings. This follows the supplied P3 requirements, including Page ID/`pgid` as the correlation key and traceability back to source lines. fileciteturn0file0L18-L29
