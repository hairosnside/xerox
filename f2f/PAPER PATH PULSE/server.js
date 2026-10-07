/*
 * Paper Path Pulse — local ntcli bridge
 *
 * Runs:
 *   ssh root@10.194.48.221 \
 *   'ntcli get Settings; echo ---; ntcli get Status; echo ---; ntcli get Supplies; echo ---; ntcli get Destination'
 *
 * Also provides:
 *   GET /api/ping
 *   GET /api/ntcli
 *
 * Start:
 *   node server.js
 *
 * Dashboard:
 *   http://localhost:8787/
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);

const DEFAULT_PRINTER_IP =
  process.env.PRINTER_IP || '10.194.48.221';

const SSH_USER =
  process.env.SSH_USER || 'root';

const DASHBOARD_FILE =
  path.join(__dirname, 'index2_ntcli.html');

const NTCLI_COMMAND =
  'ntcli get Settings; echo ---; ntcli get Status; echo ---; ntcli get Supplies; echo ---; ntcli get Destination';


/* =========================================================
   HTTP JSON RESPONSE
   ========================================================= */

function json(res, status, body) {
  const payload = JSON.stringify(body);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(payload);
}


/* =========================================================
   PRINTER IP VALIDATION
   ========================================================= */

function isPrivateIPv4(ip) {
  const m =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);

  if (!m) return false;

  const p = m.slice(1).map(Number);

  if (p.some(n => n < 0 || n > 255)) {
    return false;
  }

  return (
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168)
  );
}


function getIp(req, url) {
  const ip =
    (url.searchParams.get('ip') || DEFAULT_PRINTER_IP).trim();

  if (!isPrivateIPv4(ip)) {
    throw new Error(
      'Printer IP must be a valid private IPv4 address'
    );
  }

  return ip;
}


/* =========================================================
   NTCLI JSON PARSER
   ========================================================= */

function extractJsonObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');

  if (first < 0 || last <= first) {
    throw new Error(
      'No JSON object found in ntcli output'
    );
  }

  let s = text.slice(first, last + 1);

  /*
   * ntcli can contain values such as:
   * <hex:....>
   *
   * Those are not required by the dashboard.
   */

  s = s.replace(/<hex:[^>]*>/g, 'null');

  /*
   * ntcli output may contain trailing commas.
   */

  s = s.replace(/,\s*([}\]])/g, '$1');

  /*
   * Tolerate other non-standard placeholders.
   */

  s = s.replace(/<[^>]*>/g, 'null');

  return JSON.parse(s);
}


function parseNtcliOutput(stdout) {
  const parts =
    stdout.split(/\r?\n\s*---\s*\r?\n/);

  if (parts.length < 4) {
    throw new Error(
      'Unexpected ntcli output: expected 4 sections'
    );
  }

  const sections = [];

  for (let i = 0; i < 4; i++) {
    sections.push(
      extractJsonObject(parts[i])
    );
  }

  return {
    settings: sections[0],
    status: sections[1],
    supplies: sections[2],
    destination: sections[3]
  };
}


/* =========================================================
   SUPPLY COMPACTION
   ========================================================= */

function compactSupply(name, value) {
  const s = value || {};

  return {
    name,

    state:
      s.Status?.state ?? null,

    percentRemaining:
      s.Status?.percentRemaining ?? null,

    code:
      s.Status?.code ?? null,

    partNumber:
      s.Attributes?.partNumber ?? null,

    serialNumber:
      s.Attributes?.serialNumber ?? null,

    pagesRemaining:
      s.Dynamic?.pagesRemaining ?? null,

    daysRemaining:
      s.Dynamic?.daysRemaining ?? null,

    sideCount:
      s.Dynamic?.sideCount ?? null
  };
}


/* =========================================================
   DESTINATION COMPACTION
   ========================================================= */

function compactDestination(name, value) {
  const d = value || {};

  const components = {};

  for (const key of [
    'StapleCartridge',
    'StapleCartridge_2',
    'PunchBox',
    'Accumulator'
  ]) {
    if (d[key]) {
      components[key] = {
        status:
          d[key].status ?? null,

        capacity:
          d[key].capacity ?? null
      };
    }
  }

  return {
    name,

    capacity:
      d.capacity ?? null,

    level:
      d.level ?? null,

    levelsReported:
      d.levelsReported ?? null,

    deviceType:
      d.deviceType ?? null,

    fullSensing:
      d.fullSensing ?? null,

    emptySensing:
      d.emptySensing ?? null,

    components
  };
}


/* =========================================================
   CREATE DASHBOARD-FRIENDLY NTCLI DATA
   ========================================================= */

function compactNtcli(parsed) {
  const s =
    parsed.settings || {};

  const status =
    parsed.status || {};

  const supplies =
    parsed.supplies || {};

  const destination =
    parsed.destination || {};

  return {

    /* ---------------------------------------------
       SETTINGS
       --------------------------------------------- */

    settings: {
      modelType:
        s.modelType ?? null,

      operatingMode:
        s.operatingMode ?? null,

      fuserMode:
        s.fuserMode ?? null,

      safeMode:
        s.safeMode ?? null,

      optionalDevicesState:
        s.optionalDevicesState ?? null,

      sfp:
        s.sfp ?? null,

      hardwareConfig: {
        powerSupply:
          s.HardwareConfig?.powerSupply ?? null,

        mpFeederCapacity:
          s.HardwareConfig?.mpFeederCapacity ?? null,

        duplexCapability:
          s.HardwareConfig?.duplexCapability ?? null,

        tray1Capacity:
          s.HardwareConfig?.tray1Capacity ?? null,

        stdBinCapacity:
          s.HardwareConfig?.stdBinCapacity ?? null
      },

      customFeatures: {
        maxOptionalTrays:
          s.CustomFeatures?.maxOptionalTrays ?? null,

        finisherConfiguration:
          s.CustomFeatures?.finisherConfiguration ?? null
      }
    },


    /* ---------------------------------------------
       STATUS
       --------------------------------------------- */

    status: {

      errors:
        status.Errors || {},

      powerState:
        status.PowerState || {},

      printing:
        status.Printing || {},

      version:
        status.Version || {},

      environment:
        status.Environment || {},

      calibration:
        status.Calibration || {},

      currentMode:
        status.currentMode ?? null,

      persistentBootMode:
        status.persistentBootMode ?? null,

      printReady:
        status.printReady ?? null,

      sideCount:
        status.sideCount ?? null,

      sideCountPermanent:
        status.sideCountPermanent ?? null,

      technologyIsColor:
        status.technologyIsColor ?? null,

      colorPrintingEnabled:
        status.colorPrintingEnabled ?? null,

      currentTime:
        status.currentTime ?? null,

      maxSpeed:
        status.maxSpeed ?? null,

      safeMode:
        status.safeMode ?? null
    },


    /* ---------------------------------------------
       SUPPLIES
       --------------------------------------------- */

    supplies:
      Object.entries(supplies)
        .map(([name, value]) =>
          compactSupply(name, value)
        ),


    /* ---------------------------------------------
       DESTINATION
       --------------------------------------------- */

    destination:
      Object.entries(destination)
        .map(([name, value]) =>
          compactDestination(name, value)
        )
  };
}


/* =========================================================
   COMMAND EXECUTION
   ========================================================= */

function runCommand(
  file,
  args,
  timeoutMs = 20000
) {
  return new Promise(
    (resolve, reject) => {

      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,

          maxBuffer:
            4 * 1024 * 1024
        },

        (error, stdout, stderr) => {

          if (error) {

            const detail =
              (
                stderr ||
                stdout ||
                error.message ||
                ''
              ).trim();

            reject(
              new Error(
                detail || 'Command failed'
              )
            );

            return;
          }

          resolve(
            (stdout || '').toString()
          );
        }
      );
    }
  );
}


/* =========================================================
   QUERY PRINTER
   ========================================================= */

async function queryNtcli(ip) {

  const stdout =
    await runCommand(
      'ssh',
      [
        '-o',
        'BatchMode=yes',

        '-o',
        'ConnectTimeout=7',

        `${SSH_USER}@${ip}`,

        NTCLI_COMMAND
      ]
    );

  return {
    ok: true,

    ip,

    fetchedAt:
      new Date().toISOString(),

    ...compactNtcli(
      parseNtcliOutput(stdout)
    )
  };
}


/* =========================================================
   PING PRINTER
   ========================================================= */

async function pingPrinter(ip) {

  const isWin =
    os.platform() === 'win32';

  const args = isWin

    ? [
        '-n',
        '1',

        '-w',
        '1500',

        ip
      ]

    : [
        '-c',
        '1',

        '-W',
        '2',

        ip
      ];

  try {

    const stdout =
      await runCommand(
        'ping',
        args,
        5000
      );

    return {

      ok: true,

      reachable: true,

      ip,

      checkedAt:
        new Date().toISOString(),

      output:
        stdout.trim().slice(0, 800)
    };

  } catch (error) {

    return {

      ok: true,

      reachable: false,

      ip,

      checkedAt:
        new Date().toISOString(),

      error:
        error.message
    };
  }
}


/* =========================================================
   HTTP SERVER
   ========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${req.headers.host || 'localhost'}`
        );


      /* ---------------------------------------------
         CORS PREFLIGHT
         --------------------------------------------- */

      if (req.method === 'OPTIONS') {

        res.writeHead(
          204,
          {
            'Access-Control-Allow-Origin': '*',

            'Access-Control-Allow-Methods':
              'GET, OPTIONS',

            'Access-Control-Allow-Headers':
              'Content-Type'
          }
        );

        return res.end();
      }


      try {

        /* -------------------------------------------
           NTCLI ENDPOINT
           ------------------------------------------- */

        if (url.pathname === '/api/ntcli') {

          const ip =
            getIp(req, url);

          try {

            const result =
              await queryNtcli(ip);

            return json(
              res,
              200,
              result
            );

          } catch (error) {

            return json(
              res,
              502,
              {
                ok: false,

                ip,

                fetchedAt:
                  new Date().toISOString(),

                error:
                  error.message
              }
            );
          }
        }


        /* -------------------------------------------
           PING ENDPOINT
           ------------------------------------------- */

        if (url.pathname === '/api/ping') {

          const ip =
            getIp(req, url);

          return json(
            res,
            200,
            await pingPrinter(ip)
          );
        }


        /* -------------------------------------------
           DASHBOARD
           ------------------------------------------- */

        if (
          url.pathname === '/' ||
          url.pathname === '/index2.html'
        ) {

          if (
            !fs.existsSync(
              DASHBOARD_FILE
            )
          ) {

            return json(
              res,
              500,
              {
                ok: false,

                error:
                  'index2_ntcli.html not found beside server.js'
              }
            );
          }

          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8',

              'Cache-Control':
                'no-store'
            }
          );

          return fs
            .createReadStream(
              DASHBOARD_FILE
            )
            .pipe(res);
        }


        /* -------------------------------------------
           404
           ------------------------------------------- */

        res.writeHead(
          404,
          {
            'Content-Type':
              'text/plain; charset=utf-8'
          }
        );

        res.end('Not found');

      } catch (error) {

        return json(
          res,
          400,
          {
            ok: false,

            error:
              error.message ||
              'Bad request'
          }
        );
      }
    }
  );


/* =========================================================
   START SERVER
   ========================================================= */

server.listen(
  PORT,

  () => {

    console.log(
      `Paper Path Pulse listening on http://localhost:${PORT}/`
    );

    console.log(
      `Printer: ${DEFAULT_PRINTER_IP}`
    );

    console.log(
      `SSH user: ${SSH_USER}`
    );
  }
);