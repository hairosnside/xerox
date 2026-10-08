
'use strict';

(function (rootFactory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = rootFactory();
  } else {
    self.PaperPathPulseParser = rootFactory();
  }
})(function () {
  const DEFAULT_FILTER =
    '(ppcmd|PPort|SLPQ|pickpage|ImagePositionError|imagepositionerror|qdmg|staging|Page\\s+ID|PageId|PgSup\\s+Page)';

  const STAGES = [
    { key: 'trayPassThru', label: 'Tray Pass Thru' },
    { key: 'printerEntry', label: 'Printer Entry' },
    { key: 's1', label: 'S1 Sensor' },
    { key: 'bumpNip', label: 'Bump Nip' },
    { key: 'bumpExit', label: 'Bump Exit' },
    { key: 'xfer2', label: '2ndXfer' }
  ];

  function normalizeHex(hex) {
    return '0x' + String(hex || '').replace(/^0x/i, '').padStart(2, '0').toUpperCase();
  }

  function hexToDec(hex) {
    return parseInt(String(hex).replace(/^0x/i, ''), 16);
  }

  function classifyIpe(mm) {
    if (mm == null || Number.isNaN(Number(mm))) return 'UNKNOWN';
    const n = Number(mm);
    if (n < 0) return 'EARLY';
    if (n > 0) return 'LATE';
    return 'NOMINAL';
  }

  function stageKeyFromLabel(label) {
    const s = String(label || '').toLowerCase();
    if (s.includes('tray') && s.includes('pass thru')) return 'trayPassThru';
    if (s.includes('printer entry')) return 'printerEntry';
    if (s.includes('s1')) return 's1';
    if (s.includes('bump nip')) return 'bumpNip';
    if (s.includes('bump exit')) return 'bumpExit';
    if (s.includes('2ndxfer') || s.includes('2nd xfer')) return 'xfer2';
    return null;
  }

  function stageLabel(key) {
    return STAGES.find(s => s.key === key)?.label || key;
  }

  function parseEngineTime(line) {
    const m = String(line).match(/(?:^|\s)(\d{1,7}\.\d{3,6})(?=:|,)/);
    return m ? Number(m[1]) : null;
  }

  function parseRealTime(line) {
    const m = String(line).match(/RealTime=['"]([^'"]+)['"]/i);
    return m ? m[1] : null;
  }

  function parsePageId(line) {
    const patterns = [
      /page\s*id\s*[:=]\s*(0x[0-9a-f]+)/i,
      /PageID\s*[:=]\s*(0x[0-9a-f]+)/i,
      /PgSup\\s+Page\s+(0x[0-9a-f]+)/i,
      /Opt\s+Page\s+(0x[0-9a-f]+)/i,
      /\bPage\s+(0x[0-9a-f]+)\b/i,
      /\bpage\s+(0x[0-9a-f]+)\b/i,
      /GAP:\s+PageID:(0x[0-9a-f]+)/i,
      /pgid\s*=\s*(0x[0-9a-f]+)/i
    ];
    for (const re of patterns) {
      const m = String(line).match(re);
      if (m) return normalizeHex(m[1]);
    }
    const data = String(line).match(/OC_OPCODE_SLPQ\s*=\s*0x97\b.*?\bData:\s*(0x[0-9a-f]+)/i);
    if (data) {
      const h = data[1].replace(/^0x/i, '').padStart(8, '0');
      // Observed log shape: 0x09 SS GG 01 -> GG is the pgid byte.
      const bytes = h.match(/../g);
      if (bytes && bytes.length === 4 && bytes[0].toUpperCase() === '09' && bytes[3].toUpperCase() === '01') {
        return normalizeHex(bytes[2]);
      }
    }
    return null;
  }

  function extractPrinterSideCount(line) {
    let m = String(line).match(/PrinterSideCount(?:Start|Stop)?=['"](\d+)['"]/i);
    if (!m) m = String(line).match(/PrinterSideCount\s*=\s*['"](\d+)['"]/i);
    return m ? Number(m[1]) : null;
  }

  function extractPass(line) {
    const m = String(line).match(/\bpass\s+(0x[0-9a-f]+|\d+)\b/i);
    return m ? (m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : Number(m[1])) : null;
  }

  function extractStageIpe(line) {
    const re = /Image-Position Error at\s+([^:]+):\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*mm,\s*page\s*ID:\s*(0x[0-9a-f]+)/i;
    const m = String(line).match(re);
    if (!m) return null;
    const key = stageKeyFromLabel(m[1]);
    if (!key) return null;
    return {
      stage: key,
      stageLabel: m[1].trim(),
      ipeMm: Number(m[2]),
      status: classifyIpe(Number(m[2])),
      pageIdHex: normalizeHex(m[3])
    };
  }

  function extractXmlIpe(line) {
    const patterns = [
      ['s1', /ImagePositionErrorS1\s*=\s*['"]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i],
      ['bumpExit', /ImagePositionErrorBumpExit\s*=\s*['"]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i],
      ['xfer2', /ImagePositionError2ndXFer\s*=\s*['"]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i],
      ['bumpNip', /ImagePositionErrorBumpNip\s*=\s*['"]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i],
      ['trayPassThru', /ImagePositionErrorTray(?:3|2|1|4|5)PassThru\s*=\s*['"]\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i]
    ];
    for (const [stage, re] of patterns) {
      const m = String(line).match(re);
      if (m) {
        const value = Number(m[1]);
        return { stage, ipeMm: value, status: classifyIpe(value), pageIdHex: parsePageId(line) };
      }
    }
    return null;
  }

  function extractPpcmd(line) {
    const m = String(line).match(
      /PPCMD\s+OpCode:\s*(OC_OPCODE_[A-Z0-9_]+)\s*=\s*(0x[0-9a-f]+)\s+Control:\s*(0x[0-9a-f]+)\s+Address:\s*(0x[0-9a-f]+)\s+Data:\s*(.*)$/i
    );
    if (!m) return null;
    return {
      opcodeName: m[1],
      opcode: normalizeHex(m[2]),
      control: normalizeHex(m[3]),
      address: normalizeHex(m[4]),
      dataWords: m[5].trim().split(/\s+/).filter(Boolean),
      raw: String(line).trim()
    };
  }

  function extractSlpq(line) {
    const m = String(line).match(
      /PPort\s+SLPQ\s*:\s*sub=(0x[0-9a-f]+)\s+pgid=(0x[0-9a-f]+)\s+offset=(0x[0-9a-f]+)\s+accum=(0x[0-9a-f]+)\s+fin=(0x[0-9a-f]+)\s+hp=(0x[0-9a-f]+)\s+sp=(0x[0-9a-f]+)/i
    );
    if (!m) return null;
    return {
      sub: normalizeHex(m[1]),
      pgid: normalizeHex(m[2]),
      offset: normalizeHex(m[3]),
      accum: normalizeHex(m[4]),
      fin: normalizeHex(m[5]),
      hp: normalizeHex(m[6]),
      sp: normalizeHex(m[7])
    };
  }

  function extractQdmg(line) {
    const p = extractPpcmd(line);
    if (!p || !/OC_OPCODE_QDMG/i.test(p.opcodeName)) return null;
    return {
      control: p.control,
      address: p.address,
      dataWords: p.dataWords
    };
  }

  function extractStaging(line) {
    const m = String(line).match(/Page\\s+ID\s+(0x[0-9a-f]+)\s+staging zone changed to\s+([A-Z0-9_]+)/i);
    if (!m) return null;
    return { pageIdHex: normalizeHex(m[1]), zone: m[2] };
  }

  function extractPrinterEntry(line) {
    const pageIdHex = parsePageId(line);
    if (!pageIdHex) return null;
    if (/PS_LE_W_F_OPTION_PAGE_AT_PRINTER_ENTRY|OPTION_PICK_PAGE|Opt\s+Pick\s+Page/i.test(line)) {
      const explicit = line.match(/PickCommandTimeStamp\s*=\s*['"]\s*([0-9.]+)/i);
      return {
        pageIdHex,
        time: explicit ? Number(explicit[1]) : parseEngineTime(line),
        source: /PS_LE_W_F_OPTION_PAGE_AT_PRINTER_ENTRY/i.test(line)
          ? 'PS_LE_W_F_OPTION_PAGE_AT_PRINTER_ENTRY'
          : /Opt\s+Pick\s+Page/i.test(line)
            ? 'Opt Pick Page'
            : 'OPTION_PICK_PAGE'
      };
    }
    return null;
  }

  function extractPick(line) {
    const structured = String(line).match(/PickCommandTimeStamp\s*=\s*['"]\s*([0-9.]+)/i);
    const attempts = String(line).match(/PickAttempts\s*=\s*['"]\s*(\d+)/i);
    if (structured) return { timestamp: Number(structured[1]), pickAttempts: attempts ? Number(attempts[1]) : null, pageIdHex: parsePageId(line), source: 'PAPER_PATH.PickCommandTimeStamp' };
    const opt = String(line).match(/Opt\s+Pick\s+Page\s+(0x[0-9a-f]+)/i);
    if (opt) return { timestamp: null, pickAttempts: null, pageIdHex: normalizeHex(opt[1]), source: 'Opt Pick Page' };
    const cmd = /OPTION_PICK_PAGE/i.test(line);
    if (cmd) return { timestamp: null, pickAttempts: null, pageIdHex: parsePageId(line), source: 'optDriverRequest: OPTION_PICK_PAGE' };
    return null;
  }

  function extractPgSupState(line) {
    const m = String(line).match(/PgSup\\s+Page\s+(0x[0-9a-f]+).*?LE State\s+([A-Z0-9_]+)\s*->\s*([A-Z0-9_]+)/i);
    if (!m) return null;
    return {
      pageIdHex: normalizeHex(m[1]),
      from: m[2],
      to: m[3]
    };
  }

  function extractFinishState(line) {
    const m = String(line).match(/Opt\s+Page\s+(0x[0-9a-f]+)\s+Finishing\s+SubmitMan\s+State:\s*([A-Z0-9_]+)/i);
    if (!m) return null;
    return { pageIdHex: normalizeHex(m[1]), state: m[2] };
  }

  function extractGap(line) {
    const m = String(line).match(/GAP\s+PageID:(0x[0-9a-f]+).*?\bGap:\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))/i);
    if (m) return { pageIdHex: normalizeHex(m[1]), gapMm: Number(m[2]), source: 'GAP PageID' };
    const req = String(line).match(/EP:\s*Gap request \(mm\).*?required_gap\s*=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)).*?EngInputGap\s*=\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+)).*?PageID\s*=\s*(0x[0-9a-f]+)/i);
    if (req) return {
      pageIdHex: normalizeHex(req[3]),
      requestedGapMm: Number(req[1]),
      engInputGapMm: Number(req[2]),
      source: 'EP: Gap request (mm)'
    };
    return null;
  }

  function extractHealth(line) {
    const s = String(line);
    if (/HealthCheckData\(\)/i.test(s)) return { severity: /\*WARNING\*/i.test(s) ? 'WARN' : 'INFO', raw: s.trim() };
    if (/PAPER_JAM_OCCURRED|PaperJam|Jam Rule|jam/i.test(s) && /PAPER_JAM_OCCURRED_NFY|PaperJamOccurred|PAPER_JAM|PaperJam/i.test(s)) {
      return { severity: 'ERROR', raw: s.trim() };
    }
    if (/WARN\b|ERROR\b|FAILED|failed|TIMED_OUT|TIMEOUT/i.test(s)) {
      return { severity: /\bERROR\b|failed|TIMED_OUT|TIMEOUT/i.test(s) ? 'ERROR' : 'WARN', raw: s.trim() };
    }
    return null;
  }

  function makeEvent(type, line, lineNumber, extra) {
    const engineTime = parseEngineTime(line);
    return {
      id: `${lineNumber}:${engineTime ?? 'na'}:${type}`,
      type,
      lineNumber,
      sourceLine: lineNumber,
      engineTime,
      realTime: parseRealTime(line),
      raw: String(line).replace(/\r$/, ''),
      pageIdHex: extra?.pageIdHex || null,
      pageIdDec: extra?.pageIdHex ? hexToDec(extra.pageIdHex) : null,
      printerSideCount: extractPrinterSideCount(line),
      pass: extractPass(line),
      ...extra
    };
  }

  class Correlator {
    constructor(options = {}) {
      this.filterText = DEFAULT_FILTER;
      this.maxPages = options.maxPages || 2000;
      this.maxEvents = options.maxEvents || 12000;
      this.pages = new Map();
      this.events = [];
      this.orphans = [];
      this.recentContexts = [];
      this.recentPageHints = [];
      this.pending = [];
      this.lastLineNumber = 0;
      this.lastEngineTime = null;
      this.stats = { lines: 0, matched: 0, parsed: 0, pages: 0 };
      this.tryCompileFilter();
    }

    tryCompileFilter() {
      let source = this.filterText;
      if (source.startsWith('(?i)')) source = source.slice(4);
      try {
        this.filter = new RegExp(source, 'i');
        this.filterError = null;
      } catch (err) {
        this.filter = /$a/;
        this.filterError = err.message;
      }
    }

    reset() {
      this.pages.clear(); this.events = []; this.orphans = [];
      this.recentContexts = []; this.recentPageHints = []; this.pending = [];
      this.lastLineNumber = 0; this.lastEngineTime = null;
      this.stats = { lines: 0, matched: 0, parsed: 0, pages: 0 };
    }

    shouldFilter(line) {
      // The operator-defined extraction regex is intentionally static.
      // Dedicated extractors still admit the minimum authoritative context
      // required to correlate a page lifecycle without changing the filter.
      return this.filter.test(line) ||
        /PickCommandTimeStamp|PAPER_PATH|HealthCheckData|PaperJam|PAPER_JAM_OCCURRED|Finishing SubmitMan State|PS_LE_W_F_OPTION_PAGE_AT_PRINTER_ENTRY|OPTION_PICK_PAGE|Image-Position Error at|Page\s+ID\s+0x/i.test(line);
    }

    rememberContext(pageIdHex, time, type, raw) {
      if (!pageIdHex) return;
      this.recentContexts.push({ pageIdHex, time, type, raw });
      const cutoff = time != null ? time - 2.5 : null;
      if (cutoff != null) this.recentContexts = this.recentContexts.filter(c => c.time == null || c.time >= cutoff);
      if (this.recentContexts.length > 300) this.recentContexts.splice(0, this.recentContexts.length - 300);
    }

    nearestContext(time, predicate = () => true, window = 0.8) {
      const candidates = this.recentContexts.filter(c => c.time != null && time != null && predicate(c));
      let best = null, bd = Infinity;
      for (const c of candidates) {
        const d = Math.abs(c.time - time);
        if (d <= window && d < bd) { best = c; bd = d; }
      }
      return best;
    }

    addPending(event, kind, timestamp) {
      this.pending.push({ event, kind, timestamp: timestamp ?? event.engineTime ?? null });
      if (this.pending.length > 500) this.pending.splice(0, this.pending.length - 500);
    }

    reconcilePending(pageIdHex, time) {
      if (!pageIdHex || time == null || !this.pending.length) return;
      const remaining = [];
      for (const item of this.pending) {
        const t = item.timestamp;
        const close = t != null && Math.abs(t - time) <= 0.9;
        if (!close) {
          if (t != null && Math.abs(time - t) > 1.5) this.orphans.push(item.event);
          else remaining.push(item);
          continue;
        }
        const e = item.event;
        e.pageIdHex = pageIdHex;
        e.pageIdDec = hexToDec(pageIdHex);
        e.correlation = 'deferred-nearby-page-context';
        const page = this.attachEventToPage(pageIdHex, e, item.kind === 'pageStage' ? e.stage : null);
        if (item.kind === 'pick') {
          const ts = e.timestamp ?? t;
          page.pick.push({
            timestamp: ts,
            pickAttempts: e.pickAttempts,
            sourceLine: e.sourceLine,
            raw: e.raw,
            source: e.source
          });
          if (ts != null) {
            page.start = page.start == null ? ts : Math.min(page.start, ts);
            const entryEvent = makeEvent('pageStage', e.raw, e.sourceLine, {
              pageIdHex, stage: 'printerEntry', stageLabel: 'Printer Entry',
              ipeMm: null, status: 'EVENT', entrySource: e.source,
              engineTime: ts, timestamp: ts
            });
            entryEvent.id = `${e.sourceLine}:${ts}:printerEntry`;
            this.events.push(entryEvent);
            this.stats.parsed += 1;
            this.attachEventToPage(pageIdHex, entryEvent, 'printerEntry');
          }
        }
      }
      this.pending = remaining;
    }

    getPage(pageIdHex) {
      const id = normalizeHex(pageIdHex);
      if (!this.pages.has(id)) {
        this.pages.set(id, {
          pageIdHex: id,
          pageIdDec: hexToDec(id),
          pass: null,
          printerSideCount: null,
          start: null,
          end: null,
          status: 'OPEN',
          stages: Object.fromEntries(STAGES.map(s => [s.key, null])),
          slpq: [],
          qdmg: [],
          staging: [],
          pick: [],
          gap: [],
          finishStates: [],
          events: [],
          lastSeen: null
        });
      }
      return this.pages.get(id);
    }

    attachEventToPage(pageIdHex, event, stageKey = null) {
      if (!pageIdHex) {
        this.orphans.push(event);
        return null;
      }
      const page = this.getPage(pageIdHex);
      page.events.push(event.id);
      page.lastSeen = event.engineTime;
      if (event.pass != null) page.pass = event.pass;
      if (event.printerSideCount != null && page.printerSideCount == null) page.printerSideCount = event.printerSideCount;
      if (stageKey) {
        const current = page.stages[stageKey];
        const shouldReplace = !current || (event.engineTime != null && current.time != null && event.engineTime >= current.time);
        if (shouldReplace) {
          page.stages[stageKey] = {
            time: event.engineTime,
            ipeMm: event.ipeMm ?? null,
            status: event.status || (event.ipeMm != null ? classifyIpe(event.ipeMm) : 'EVENT'),
            sourceLine: event.sourceLine,
            raw: event.raw,
            stageLabel: event.stageLabel || stageLabel(stageKey)
          };
        }
        if (page.stages[stageKey]?.time != null) {
          page.end = page.end == null ? page.stages[stageKey].time : Math.max(page.end, page.stages[stageKey].time);
        }
      } else if (event.engineTime != null) {
        page.end = page.end == null ? event.engineTime : Math.max(page.end, event.engineTime);
      }
      if (page.start == null && event.engineTime != null && ['pick','printerEntry','trayPassThru'].includes(event.type)) page.start = event.engineTime;
      page.status = page.end != null && page.start != null ? 'COMPLETE' : 'OPEN / PARTIAL';
      return page;
    }

    addLine(line, lineNumber) {
      this.lastLineNumber = lineNumber;
      this.stats.lines += 1;
      const raw = String(line).replace(/\r$/, '');
      if (!raw.trim()) return [];
      if (!this.shouldFilter(raw)) return [];

      this.stats.matched += 1;
      const time = parseEngineTime(raw);
      if (time != null) this.lastEngineTime = time;
      const pageHint = parsePageId(raw);
      if (pageHint) {
        this.rememberContext(pageHint, time, 'pageHint', raw);
        this.recentPageHints.push({ pageIdHex: pageHint, time });
        if (this.recentPageHints.length > 100) this.recentPageHints.shift();
        this.reconcilePending(pageHint, time);
      }

      const embeddedPickTs = raw.match(/PickCommandTimeStamp\s*=\s*['"]\s*([0-9.]+)/i);
      const correlationTime = time ?? (embeddedPickTs ? Number(embeddedPickTs[1]) : null);

      const out = [];

      const stageData = extractStageIpe(raw);
      if (stageData) {
        const e = makeEvent('pageStage', raw, lineNumber, stageData);
        out.push(e);
        this.attachEventToPage(stageData.pageIdHex, e, stageData.stage);
      }

      const xmlIpe = extractXmlIpe(raw);
      if (xmlIpe) {
        let pageId = xmlIpe.pageIdHex;
        if (!pageId) {
          const ctx = this.nearestContext(time, c => c.type === 'pageHint', 0.15);
          pageId = ctx?.pageIdHex || null;
        }
        const e = makeEvent('pageStage', raw, lineNumber, { ...xmlIpe, pageIdHex: pageId, correlation: pageId ? 'explicit-or-nearby-page-context' : 'PENDING_PAGE_CONTEXT' });
        out.push(e);
        if (pageId) this.attachEventToPage(pageId, e, xmlIpe.stage);
        else this.addPending(e, 'pageStage', time);
      }

      const staging = extractStaging(raw);
      if (staging) {
        const e = makeEvent('staging', raw, lineNumber, staging);
        out.push(e);
        this.attachEventToPage(staging.pageIdHex, e);
        const p = this.getPage(staging.pageIdHex);
        p.staging.push({ time, zone: staging.zone, sourceLine: lineNumber, raw });
        this.rememberContext(staging.pageIdHex, time, 'staging', raw);
      }

      const slpq = extractSlpq(raw);
      if (slpq) {
        const pageId = slpq.pgid;
        const e = makeEvent('slpq', raw, lineNumber, { pageIdHex: pageId, ...slpq, rawPpcmdData: null });
        out.push(e);
        this.attachEventToPage(pageId, e);
        this.getPage(pageId).slpq.push({ timestamp: time, ...slpq, sourceLine: lineNumber, raw });
        this.rememberContext(pageId, time, 'slpq', raw);
      }

      const ppcmd = extractPpcmd(raw);
      if (ppcmd) {
        if (/OC_OPCODE_SLPQ/i.test(ppcmd.opcodeName)) {
          const pageId = pageHint;
          const e = makeEvent('ppcmd', raw, lineNumber, { ...ppcmd, pageIdHex: pageId, protocolMarker: 'OC_OPCODE_SLPQ=0x97' });
          out.push(e);
          if (pageId) {
            this.attachEventToPage(pageId, e);
            const rec = this.getPage(pageId).slpq;
            for (let i = rec.length - 1; i >= 0; i--) {
              if (rec[i].timestamp == null || time == null || Math.abs(rec[i].timestamp - time) < 0.2) {
                rec[i].rawPpcmdData = ppcmd.dataWords;
                rec[i].control = ppcmd.control;
                rec[i].address = ppcmd.address;
                break;
              }
            }
          }
        } else if (/OC_OPCODE_QDMG/i.test(ppcmd.opcodeName)) {
          let pageId = pageHint;
          if (!pageId) {
            const ctx = this.nearestContext(time, c => ['slpq','finish'].includes(c.type), 0.8);
            pageId = ctx?.pageIdHex || null;
          }
          const e = makeEvent('qdmg', raw, lineNumber, { ...ppcmd, pageIdHex: pageId, qdmgRole: ppcmd.control === '0x02' ? 'REQUEST' : ppcmd.control === '0x03' ? 'RESPONSE' : 'UNKNOWN' });
          out.push(e);
          if (pageId) {
            this.attachEventToPage(pageId, e);
            this.getPage(pageId).qdmg.push({
              timestamp: time,
              pageIdHex: pageId,
              control: ppcmd.control,
              address: ppcmd.address,
              dataWords: ppcmd.dataWords,
              role: e.qdmgRole,
              sourceLine: lineNumber,
              raw
            });
          } else this.orphans.push(e);
        }
      }

      const finish = extractFinishState(raw);
      if (finish) {
        const e = makeEvent('finishState', raw, lineNumber, finish);
        out.push(e);
        this.attachEventToPage(finish.pageIdHex, e);
        this.rememberContext(finish.pageIdHex, time, 'finish', raw);
        this.getPage(finish.pageIdHex).finishStates.push({ time, state: finish.state, sourceLine: lineNumber, raw });
      }

      const pick = extractPick(raw);
      if (pick) {
        let pageId = pick.pageIdHex;
        const pickTime = pick.timestamp ?? correlationTime;
        if (!pageId) {
          // A structured PickPage timestamp often precedes the next PgSup page
          // marker. Prefer a FUTURE page hint over the older page so a pick
          // cannot be silently attached to the previous lifecycle.
          const future = this.recentPageHints
            .filter(h => h.pageIdHex && h.time != null && pickTime != null && h.time >= pickTime && h.time - pickTime <= 1.5)
            .sort((a,b) => a.time - b.time)[0];
          const prior = this.nearestContext(pickTime, c => c.type === 'pageHint', 0.08);
          pageId = future?.pageIdHex || prior?.pageIdHex || null;
        }
        const e = makeEvent('pick', raw, lineNumber, { ...pick, pageIdHex: pageId, timestamp: pickTime, engineTime: time ?? pickTime, correlation: pageId ? 'explicit-or-future-page-context' : 'PENDING_PAGE_CONTEXT' });
        out.push(e);
        if (pageId) {
          const page = this.attachEventToPage(pageId, e);
          page.pick.push({ timestamp: e.timestamp ?? time, pickAttempts: pick.pickAttempts, sourceLine: lineNumber, raw, source: pick.source });
          const ts = e.timestamp ?? time;
          if (ts != null) page.start = page.start == null ? ts : Math.min(page.start, ts);
          // Printer Entry is an event, not an invented IPE measurement.
          if (ts != null) {
            const entryEvent = makeEvent('pageStage', raw, lineNumber, {
              pageIdHex: pageId, stage: 'printerEntry', stageLabel: 'Printer Entry',
              ipeMm: null, status: 'EVENT', entrySource: pick.source,
              engineTime: ts, timestamp: ts
            });
            out.push(entryEvent);
            this.attachEventToPage(pageId, entryEvent, 'printerEntry');
          }
          page.status = page.end != null ? 'COMPLETE' : 'OPEN / PARTIAL';
        } else this.addPending(e, 'pick', pickTime);
      }

      const gap = extractGap(raw);
      if (gap) {
        const e = makeEvent('gap', raw, lineNumber, gap);
        out.push(e);
        this.attachEventToPage(gap.pageIdHex, e);
        this.getPage(gap.pageIdHex).gap.push({ ...gap, timestamp: time, sourceLine: lineNumber, raw });
      }

      const pg = extractPgSupState(raw);
      if (pg) {
        const e = makeEvent('pgsup', raw, lineNumber, pg);
        out.push(e);
        this.attachEventToPage(pg.pageIdHex, e);
        this.rememberContext(pg.pageIdHex, time, 'pgsup', raw);
      }

      const health = extractHealth(raw);
      if (health) {
        const e = makeEvent('health', raw, lineNumber, health);
        out.push(e);
      }

      // Any explicit page marker gets a lightweight page context, even when
      // the line itself has no structured signal.
      if (pageHint && out.length === 0) {
        const e = makeEvent('pageContext', raw, lineNumber, { pageIdHex: pageHint });
        out.push(e);
        this.attachEventToPage(pageHint, e);
      }

      for (const e of out) {
        this.events.push(e);
        this.stats.parsed += 1;
      }

      if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);

      // Bound pages while keeping the most recently observed ones.
      if (this.pages.size > this.maxPages) {
        const entries = Array.from(this.pages.values()).sort((a,b) => (a.lastSeen ?? -Infinity) - (b.lastSeen ?? -Infinity));
        while (this.pages.size > this.maxPages) this.pages.delete(entries.shift().pageIdHex);
      }
      this.stats.pages = this.pages.size;

      return out;
    }

    finalize() {
      for (const item of this.pending) this.orphans.push(item.event);
      this.pending = [];
      for (const p of this.pages.values()) {
        // Page end precedence: 2ndXfer, then final stage, then latest event.
        const stageTimes = STAGES.map(s => p.stages[s.key]?.time).filter(v => v != null);
        const xfer2 = p.stages.xfer2?.time;
        if (xfer2 != null) p.end = xfer2;
        else if (stageTimes.length) p.end = Math.max(...stageTimes);
        else if (p.lastSeen != null) p.end = p.lastSeen;
        p.status = p.start != null && p.end != null ? 'COMPLETE' : 'OPEN / PARTIAL';
      }
      return this.snapshot();
    }

    snapshot() {
      const pages = Array.from(this.pages.values()).map(p => {
        const stageTimes = STAGES.map(s => p.stages[s.key]?.time).filter(v => v != null);
        const xfer2 = p.stages.xfer2?.time;
        const doneStates = (p.finishStates || []).filter(x => /FSM_DONE|PAGE.*DONE|COMPLETE/i.test(x.state || ''));
        const finishDone = doneStates.length ? Math.max(...doneStates.map(x => x.time).filter(v => v != null)) : null;
        const canonicalEnd = xfer2 != null ? xfer2 : finishDone != null ? finishDone : stageTimes.length ? Math.max(...stageTimes) : p.lastSeen;
        const canonicalStatus = p.start != null && canonicalEnd != null ? 'COMPLETE' : 'OPEN / PARTIAL';
        return { ...p, end: canonicalEnd ?? null, status: canonicalStatus };
      }).sort((a,b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
      const health = this.events.filter(e => e.type === 'health').slice(-60).reverse();
      return {
        filter: this.filterText,
        filterError: this.filterError,
        stats: { ...this.stats },
        pages,
        events: this.events.slice(-200),
        orphans: this.orphans.slice(-100),
        health,
        stageDefinitions: STAGES
      };
    }
  }

  function parseText(text, options = {}) {
    const parser = new Correlator(options);
    const chunk = String(text || '');
    const lines = chunk.split(/\n/);
    for (let i = 0; i < lines.length; i++) parser.addLine(lines[i], i + 1);
    return parser.finalize();
  }

  return {
    DEFAULT_FILTER,
    STAGES,
    classifyIpe,
    normalizeHex,
    parseEngineTime,
    parseText,
    Correlator
  };
});
