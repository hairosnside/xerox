
self.importScripts('parser.js');

self.onmessage = async (event) => {
  const { type, file, filter } = event.data || {};
  if (type !== 'analyze' || !file) return;
  try {
    const parser = new self.PaperPathPulseParser.Correlator({
      filterText: filter,
      maxPages: 5000,
      maxEvents: 50000
    });
    const chunkSize = 1024 * 1024;
    let carry = '';
    let lineNumber = 0;
    let offset = 0;
    const total = file.size || 0;

    while (offset < total) {
      const end = Math.min(total, offset + chunkSize);
      const text = await file.slice(offset, end).text();
      offset = end;
      const merged = carry + text;
      const parts = merged.split(/\n/);
      carry = parts.pop() || '';
      for (const line of parts) {
        lineNumber++;
        parser.addLine(line, lineNumber);
      }
      self.postMessage({ type: 'progress', readBytes: offset, totalBytes: total, lines: lineNumber });
    }
    if (carry) {
      lineNumber++;
      parser.addLine(carry, lineNumber);
    }
    const result = parser.finalize();
    result.filename = file.name;
    result.sizeBytes = file.size;
    result.totalLines = lineNumber;
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message || String(error) });
  }
};
