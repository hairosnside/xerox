/* =========================================================
LOG STREAMING & REGEX PARSER (1-Second Polling)
========================================================= */
let fileState = { path: '', size: 0 };
let logStore = { 
  imageErrors: [], // { time, sensor, value, type }
  slpq: [], 
  qdmg: [],
  healthchecks: []
};

function parseLogLines(lines) {
  const regexImg = /ImagePositionError:\s*(Passtrhu|Printer Entry|S1 Sensor|Bump Nip|Bump Exit|2ndXfer)\s+(-?\d+)/gi;
  const regexSlpq = /SLPQ:\s*(.*)/gi;
  const regexQdmg = /QDMG:\s*(.*)/gi;
  const regexHealth = /HealthCheck:\s*(.*)/gi;

  lines.forEach(line => {
    let match;
    while ((match = regexImg.exec(line)) !== null) {
      logStore.imageErrors.push({
        time: new Date().toISOString(),
        sensor: match[1],
        value: parseInt(match[2]),
        type: parseInt(match[2]) < 0 ? 'Early' : 'Late'
      });
    }
    while ((match = regexSlpq.exec(line)) !== null) {
      logStore.slpq.push({ time: new Date().toISOString(), raw: match[1] });
      if (logStore.slpq.length > 50) logStore.slpq.shift(); // Keep last 50
    }
    while ((match = regexQdmg.exec(line)) !== null) {
      logStore.qdmg.push({ time: new Date().toISOString(), raw: match[1] });
      if (logStore.qdmg.length > 20) logStore.qdmg.shift();
    }
    while ((match = regexHealth.exec(line)) !== null) {
      logStore.healthchecks.push({ time: new Date().toISOString(), raw: match[1] });
      if (logStore.healthchecks.length > 20) logStore.healthchecks.shift();
    }
  });
}

// Inside your http.createServer router:
if (req.method === 'GET' && requestUrl.pathname === '/api/logs') {
  const requestedPath = requestUrl.searchParams.get('path') || '/var/log/paperpath.log';
  
  if (requestedPath !== fileState.path) {
    fileState = { path: requestedPath, size: 0 };
    logStore = { imageErrors: [], slpq: [], qdmg: [], healthchecks: [] };
  }

  try {
    const stats = fs.statSync(fileState.path);
    if (stats.size > fileState.size) {
      const fd = fs.openSync(fileState.path, 'r');
      const bufferSize = stats.size - fileState.size;
      const buffer = Buffer.alloc(bufferSize);
      fs.readSync(fd, buffer, 0, bufferSize, fileState.size);
      fs.closeSync(fd);
      fileState.size = stats.size;
      
      const newLines = buffer.toString('utf8').split('\n').filter(l => l.trim() !== '');
      parseLogLines(newLines);
    }
    
    // Limit imageErrors array to prevent memory leak (keep last 100 points)
    if (logStore.imageErrors.length > 100) {
      logStore.imageErrors = logStore.imageErrors.slice(-100);
    }

    sendJson(res, 200, { ok: true, path: fileState.path, data: logStore });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: 'Failed to read log file', details: error.message });
  }
  return;
}