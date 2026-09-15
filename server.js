import express from "express";
import fs from "fs";
import https from "https";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const VIN = process.env.TESLA_VIN;
const PROXY_URL = process.env.TESLA_PROXY_URL || "https://127.0.0.1:4443";

function requireConfig() {
  const missing = [];
  for (const key of ["TESLA_VIN", "TESLA_ACCESS_TOKEN"]) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    const err = new Error(`Missing server configuration: ${missing.join(", ")}`);
    err.status = 503;
    throw err;
  }
}

async function proxyCommand(path, body = {}) {
  requireConfig();
  const url = `${PROXY_URL}/api/1/vehicles/${encodeURIComponent(VIN)}/command/${path}`;
  const headers = {
    "Authorization": `Bearer ${process.env.TESLA_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(data?.error_description || data?.error || `Tesla command failed (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

// Passenger-safe allowlist. No lock/unlock, charging, location, trunk, etc.
const allowed = {
  "play-pause": () => proxyCommand("media_toggle_playback"),
  "next": () => proxyCommand("media_next_track"),
  "previous": () => proxyCommand("media_prev_track"),
  "volume-up": () => proxyCommand("media_volume_up"),
  "volume-down": () => proxyCommand("media_volume_down"),
  "cooler": (temp) => proxyCommand("set_temps", { driver_temp: temp, passenger_temp: temp }),
  "warmer": (temp) => proxyCommand("set_temps", { driver_temp: temp, passenger_temp: temp }),
  "set-temp": (temp) => proxyCommand("set_temps", { driver_temp: temp, passenger_temp: temp })
};

function validTemp(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 68 && n <= 76;
}

app.post("/api/control", async (req, res) => {
  try {
    const action = req.body?.action;
    if (!allowed[action]) return res.status(400).json({ error: "Action not allowed" });

    let result;
    if (["cooler", "warmer", "set-temp"].includes(action)) {
      const temp = Number(req.body?.temperature);
      if (!validTemp(temp)) {
        return res.status(400).json({ error: "Temperature must be between 68°F and 76°F." });
      }
      result = await allowed[action](temp);
    } else {
      result = await allowed[action]();
    }

    res.json({ ok: true, result });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    app: "Tesla Passenger Control",
    configured: Boolean(process.env.TESLA_VIN && process.env.TESLA_ACCESS_TOKEN),
    limits: { minTempF: 68, maxTempF: 76 }
  });
});

app.get("*", (_req, res) => res.sendFile(new URL("./public/index.html", import.meta.url).pathname));

app.listen(PORT, () => {
  console.log(`Passenger Control running on http://localhost:${PORT}`);
});
