#!/usr/bin/env node
/**
 * Lightweight zero-dependency server with automatic background data refresh.
 *
 * Serves:
 *   GET  /                 -> public/index.html
 *   GET  /api/data         -> public/data/combined.json (with server refresh metadata)
 *   POST /api/refresh      -> triggers live upstream refresh (debounced, 1 concurrent run)
 *
 * Environment variables:
 *   PORT                   -> HTTP port (default: 3456)
 *   REFRESH_INTERVAL_HOURS -> Auto-refresh cadence in hours (default: 6)
 *   AA_API_KEY             -> Optional Artificial Analysis API v2 key for expanded model list
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshData } from "./scripts/refresh-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_PATH = path.join(PUBLIC_DIR, "data", "combined.json");

const PORT = Number(process.env.PORT || 3456);
const REFRESH_INTERVAL_HOURS = Number(process.env.REFRESH_INTERVAL_HOURS || 6);
const REFRESH_INTERVAL_MS = Math.max(0.25, REFRESH_INTERVAL_HOURS) * 60 * 60 * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let refreshInFlight = null;
let lastRefreshError = null;
let nextScheduledRefreshAt = null;

async function triggerRefresh(reason = "manual") {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      console.log(`[server] Starting ${reason} refresh...`);
      const data = await refreshData();
      lastRefreshError = null;
      return data;
    } catch (err) {
      lastRefreshError = err.message;
      console.error(`[server] ${reason} refresh failed:`, err.message);
      throw err;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function readCachedData() {
  if (!fs.existsSync(DATA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {
    return null;
  }
}

function scheduleAutoRefresh() {
  const existing = readCachedData();
  const ageMs = existing?.generatedAt
    ? Date.now() - Date.parse(existing.generatedAt)
    : Infinity;

  if (!existing || ageMs > REFRESH_INTERVAL_MS) {
    triggerRefresh("startup-stale").catch(() => {});
  }

  nextScheduledRefreshAt = new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString();
  setInterval(() => {
    nextScheduledRefreshAt = new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString();
    triggerRefresh("scheduled").catch(() => {});
  }, REFRESH_INTERVAL_MS).unref();
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/data" && req.method === "GET") {
    const data = readCachedData();
    if (!data) {
      return sendJson(res, 503, { error: "Dataset not built yet. Run POST /api/refresh." });
    }
    return sendJson(res, 200, {
      ...data,
      server: {
        liveRefreshSupported: true,
        refreshInFlight: Boolean(refreshInFlight),
        refreshIntervalHours: REFRESH_INTERVAL_HOURS,
        nextScheduledRefreshAt,
        lastRefreshError,
      },
    });
  }

  if (url.pathname === "/api/refresh" && req.method === "POST") {
    try {
      const data = await triggerRefresh("manual");
      return sendJson(res, 200, {
        ok: true,
        ...data,
        server: {
          liveRefreshSupported: true,
          refreshInFlight: false,
          refreshIntervalHours: REFRESH_INTERVAL_HOURS,
          nextScheduledRefreshAt,
          lastRefreshError: null,
        },
      });
    } catch (err) {
      return sendJson(res, 502, {
        ok: false,
        error: err.message,
      });
    }
  }

  // Static files under public/
  let relPath = decodeURIComponent(url.pathname);
  if (relPath === "/") relPath = "/index.html";
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }

  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME_TYPES[ext] || "application/octet-stream",
    "cache-control": ext === ".json" ? "no-cache" : "public, max-age=60",
  });
  fs.createReadStream(fullPath).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] True AI Plan Value running at http://127.0.0.1:${PORT}`);
  console.log(`[server] Auto-refresh cadence: every ${REFRESH_INTERVAL_HOURS} hours`);
  scheduleAutoRefresh();
});
