/*
 * Paper Path Pulse
 * Minimal NTCLI server
 *
 * Fetches:
 *   ntcli get Settings
 *   ntcli get Status
 *   ntcli get Supplies
 *   ntcli get Destination
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { URL } = require('url');

/* =========================================================
   SERVER CONFIGURATION
   ========================================================= */

const PORT = Number(process.env.PORT || 8787);

const DEFAULT_PRINTER_IP =
  process.env.PRINTER_IP || '10.194.23.205';

const SSH_USER =
  process.env.SSH_USER || 'root';

const SSH_PASSWORD =
  process.env.SSH_PASSWORD || 'il2w4lilky';

const DASHBOARD_FILE =
  path.join(__dirname, 'index.html');

/*
 * These commands execute on the remote printer.
 */
const NTCLI_COMMAND = [
  'echo "=== Settings ==="',
  'ntcli get Settings',
  'echo "=== Status ==="',
  'ntcli get Status',
  'echo "=== Supplies ==="',
  'ntcli get Supplies',
  'echo "=== Destination ==="',
  'ntcli get Destination'
].join('; ');

/* =========================================================
   HTTP RESPONSE HELPERS
   ========================================================= */

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(body);
}

function sendHtml(res, filePath) {
  const stream = fs.createReadStream(filePath);

  stream.on('error', error => {
    console.error('Unable to read index.html:');
    console.error(error.stack || error);

    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'Unable to read index.html'
      });
    } else {
      res.destroy(error);
    }
  });

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  stream.pipe(res);
}

/* =========================================================
   PRINTER IP VALIDATION
   ========================================================= */

function isValidPrivateIPv4(ip) {
  const match =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);

  if (!match) {
    return false;
  }

  const parts = match
    .slice(1)
    .map(Number);

  const hasInvalidPart =
    parts.some(part => part < 0 || part > 255);

  if (hasInvalidPart) {
    return false;
  }

  const isPrivate10 =
    parts[0] === 10;

  const isPrivate172 =
    parts[0] === 172 &&
    parts[1] >= 16 &&
    parts[1] <= 31;

  const isPrivate192 =
    parts[0] === 192 &&
    parts[1] === 168;

  return isPrivate10 || isPrivate172 || isPrivate192;
}

/* =========================================================
   PROCESS EXECUTION
   ========================================================= */

function runCommand(executable, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(
            stderr ||
            stdout ||
            error.message ||
            'Command failed'
          ).trim();

          const commandError = new Error(message);

          commandError.code = error.code;
          commandError.signal = error.signal;
          commandError.killed = error.killed;

          reject(commandError);
          return;
        }

        resolve(String(stdout || ''));
      }
    );
  });
}

/* =========================================================
   NTCLI OUTPUT PARSER
   ========================================================= */

function parseValue(text) {
  const trimmedText = String(text || '').trim();

  if (!trimmedText) {
    return null;
  }

  try {
    return JSON.parse(trimmedText);
  } catch (error) {
    return trimmedText;
  }
}

function parseSections(stdout) {
  const sectionNames = [
    'Settings',
    'Status',
    'Supplies',
    'Destination'
  ];

  const result = {};

  for (
    let index = 0;
    index < sectionNames.length;
    index += 1
  ) {
    const sectionName =
      sectionNames[index];

    const startMarker =
      `=== ${sectionName} ===`;

    const nextSectionName =
      sectionNames[index + 1];

    const endMarker =
      nextSectionName
        ? `=== ${nextSectionName} ===`
        : null;

    const markerStart =
      stdout.indexOf(startMarker);

    const propertyName =
      sectionName.toLowerCase();

    if (markerStart === -1) {
      result[propertyName] = null;
      continue;
    }

    const contentStart =
      markerStart + startMarker.length;

    const detectedEnd =
      endMarker
        ? stdout.indexOf(endMarker, contentStart)
        : stdout.length;

    /*
     * Use a separate constant instead of reassigning detectedEnd.
     * This avoids "Assignment to constant variable."
     */
    const contentEnd =
      detectedEnd === -1
        ? stdout.length
        : detectedEnd;

    const sectionText =
      stdout
        .slice(contentStart, contentEnd)
        .trim();

    result[propertyName] =
      parseValue(sectionText);
  }

  return result;
}

/* =========================================================
   FETCH NTCLI DATA
   ========================================================= */

async function fetchNtcli(printerIp) {
  const sshOptions = [
    '-o',
    'StrictHostKeyChecking=no',

    '-o',
    'UserKnownHostsFile=/dev/null',

    '-o',
    'ConnectTimeout=7',

    '-o',
    'ServerAliveInterval=5',

    '-o',
    'ServerAliveCountMax=2'
  ];

  const sshDestination =
    `${SSH_USER}@${printerIp}`;

  let stdout;

  if (SSH_PASSWORD) {
    /*
     * Password authentication using sshpass.
     */
    const sshpassArgs = [
      '-p',
      SSH_PASSWORD,
      'ssh',
      ...sshOptions,
      sshDestination,
      NTCLI_COMMAND
    ];

    stdout = await runCommand(
      'sshpass',
      sshpassArgs
    );
  } else {
    /*
     * SSH key authentication.
     */
    const sshArgs = [
      '-o',
      'BatchMode=yes',
      ...sshOptions,
      sshDestination,
      NTCLI_COMMAND
    ];

    stdout = await runCommand(
      'ssh',
      sshArgs
    );
  }

  const parsedData =
    parseSections(stdout);

  return {
    ok: true,
    ip: printerIp,
    fetchedAt: new Date().toISOString(),
    settings: parsedData.settings,
    status: parsedData.status,
    supplies: parsedData.supplies,
    destination: parsedData.destination
  };
}

/* =========================================================
   HTTP SERVER
   ========================================================= */

const server = http.createServer(
  async (req, res) => {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    /*
     * CORS preflight request.
     */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
          'GET, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type'
      });

      res.end();
      return;
    }

    /*
     * Health-check endpoint.
     */
    if (
      req.method === 'GET' &&
      requestUrl.pathname === '/api/health'
    ) {
      sendJson(res, 200, {
        ok: true,
        service: 'Paper Path Pulse',
        printerIp: DEFAULT_PRINTER_IP,
        sshUser: SSH_USER,
        authentication:
          SSH_PASSWORD
            ? 'sshpass password'
            : 'SSH key',
        timestamp: new Date().toISOString()
      });

      return;
    }

    /*
     * NTCLI endpoint.
     *
     * Default:
     *   /api/ntcli
     *
     * Custom private IP:
     *   /api/ntcli?ip=10.194.23.205
     */
    if (
      req.method === 'GET' &&
      requestUrl.pathname === '/api/ntcli'
    ) {
      const requestedIp =
        requestUrl.searchParams.get('ip');

      const printerIp =
        String(
          requestedIp || DEFAULT_PRINTER_IP
        ).trim();

      if (!isValidPrivateIPv4(printerIp)) {
        sendJson(res, 400, {
          ok: false,
          error:
            'Printer IP must be a valid private IPv4 address'
        });

        return;
      }

      console.log(
        `[${new Date().toISOString()}] ` +
        `Fetching NTCLI data from ${printerIp}`
      );

      try {
        const data =
          await fetchNtcli(printerIp);

        console.log(
          `[${new Date().toISOString()}] ` +
          `NTCLI fetch completed for ${printerIp}`
        );

        sendJson(res, 200, data);
      } catch (error) {
        console.error(
          `[${new Date().toISOString()}] ` +
          `NTCLI fetch failed for ${printerIp}`
        );

        console.error(
          error.stack || error
        );

        sendJson(res, 502, {
          ok: false,
          ip: printerIp,
          fetchedAt: new Date().toISOString(),
          error:
            error.message ||
            'Failed to fetch printer data'
        });
      }

      return;
    }

    /*
     * Serve the dashboard.
     */
    if (
      req.method === 'GET' &&
      (
        requestUrl.pathname === '/' ||
        requestUrl.pathname === '/index.html'
      )
    ) {
      if (!fs.existsSync(DASHBOARD_FILE)) {
        sendJson(res, 500, {
          ok: false,
          error:
            'index.html was not found beside server.js'
        });

        return;
      }

      sendHtml(res, DASHBOARD_FILE);
      return;
    }

    /*
     * Unknown endpoint.
     */
    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      availableEndpoints: [
        '/',
        '/api/health',
        '/api/ntcli'
      ]
    });
  }
);

/* =========================================================
   SERVER ERROR HANDLING
   ========================================================= */

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already being used.`
    );

    console.error(
      `Stop the existing server or use another port:`
    );

    console.error(
      `PORT=8788 /snap/bin/node server.js`
    );
  } else {
    console.error('Server error:');
    console.error(error.stack || error);
  }

  process.exit(1);
});

/* =========================================================
   START SERVER
   ========================================================= */

server.listen(
  PORT,
  '127.0.0.1',
  () => {
    console.log(
      `Paper Path Pulse listening on ` +
      `http://localhost:${PORT}/`
    );

    console.log(
      `NTCLI endpoint: ` +
      `http://localhost:${PORT}/api/ntcli`
    );

    console.log(
      `Health endpoint: ` +
      `http://localhost:${PORT}/api/health`
    );

    console.log(
      `Printer: ${DEFAULT_PRINTER_IP}`
    );

    console.log(
      `SSH user: ${SSH_USER}`
    );

    console.log(
      `Authentication: ${
        SSH_PASSWORD
          ? 'sshpass password'
          : 'SSH key'
      }`
    );
  }
);