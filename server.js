import express from "express";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;

const REDIRECT_URI =
  "https://tesla-pax-control.onrender.com/auth/callback";

const TESLA_AUTH =
  "https://auth.tesla.com/oauth2/v3/authorize";

const TESLA_TOKEN =
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

const TESLA_AUDIENCE =
  "https://fleet-api.prd.na.vn.cloud.tesla.com";

const VIN = process.env.TESLA_VIN;

const PROXY_URL =
  process.env.TESLA_PROXY_URL || "https://127.0.0.1:4443";

/*
 * -------------------------------------------------------
 * TESLA PUBLIC VIRTUAL KEY
 * -------------------------------------------------------
 */

app.get(
  "/.well-known/appspecific/com.tesla.3p.public-key.pem",
  (_req, res) => {
    res.sendFile(
      "com.tesla.3p.public-key.pem",
      {
        root: "public/.well-known/appspecific"
      }
    );
  }
);

/*
 * -------------------------------------------------------
 * TESLA OAUTH LOGIN
 * -------------------------------------------------------
 */

const oauthStates = new Set();

app.get("/auth/login", (_req, res) => {
  if (!CLIENT_ID) {
    return res.status(503).send(
      "TESLA_CLIENT_ID is not configured in Render."
    );
  }

  const state = crypto.randomBytes(24).toString("hex");

  oauthStates.add(state);

  // Remove unused states after 10 minutes.
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    locale: "en-US",
    prompt: "login",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid offline_access vehicle_cmds",
    state
  });

  res.redirect(`${TESLA_AUTH}?${params.toString()}`);
});

/*
 * -------------------------------------------------------
 * TESLA OAUTH CALLBACK
 * -------------------------------------------------------
 */

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`
        <h1>Tesla authorization failed</h1>
        <p>${String(error_description || error)}</p>
      `);
    }

    if (!code || !state || !oauthStates.has(state)) {
      return res.status(400).send(
        "Invalid or expired Tesla authorization request."
      );
    }

    oauthStates.delete(state);

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(503).send(
        "Tesla Client ID or Client Secret is missing from Render."
      );
    }

    const tokenResponse = await fetch(TESLA_TOKEN, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: String(code),
        audience: TESLA_AUDIENCE,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error(
        "Tesla OAuth token exchange failed:",
        data
      );

      return res.status(500).send(`
        <h1>Tesla authorization error</h1>
        <p>The authorization code could not be exchanged.</p>
      `);
    }

    /*
     * IMPORTANT:
     * We intentionally DO NOT print access_token or
     * refresh_token to Render logs or send them to the
     * browser.
     *
     * Persistent token storage will be added next.
     */

    console.log(
      "Tesla account authorization succeeded."
    );

    res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta
            name="viewport"
            content="width=device-width,initial-scale=1"
          >
          <title>Tesla Authorized</title>

          <style>
            body {
              font-family: system-ui, sans-serif;
              max-width: 650px;
              margin: 70px auto;
              padding: 20px;
              text-align: center;
            }

            h1 {
              font-size: 32px;
            }

            p {
              font-size: 18px;
              line-height: 1.5;
            }
          </style>
        </head>

        <body>
          <h1>✓ Tesla Authorized</h1>

          <p>
            Your Tesla account successfully authorized
            Pax control.
          </p>

          <p>
            You can close this page and continue with
            virtual-key pairing.
          </p>
        </body>
      </html>
    `);

  } catch (e) {
    console.error(
      "OAuth callback error:",
      e.message
    );

    res.status(500).send(
      "Tesla authorization encountered an error."
    );
  }
});

/*
 * -------------------------------------------------------
 * PASSENGER CONTROLS
 *
 * Vehicle Command Proxy isn't enabled yet.
 * We'll configure signed commands after OAuth/key pairing.
 * -------------------------------------------------------
 */

function requireCommandConfig() {
  const missing = [];

  if (!VIN) {
    missing.push("TESLA_VIN");
  }

  if (!process.env.TESLA_ACCESS_TOKEN) {
    missing.push("TESLA_ACCESS_TOKEN");
  }

  if (missing.length) {
    const err = new Error(
      `Missing server configuration: ${missing.join(", ")}`
    );

    err.status = 503;

    throw err;
  }
}

async function proxyCommand(command, body = {}) {
  requireCommandConfig();

  const url =
    `${PROXY_URL}/api/1/vehicles/` +
    `${encodeURIComponent(VIN)}/command/${command}`;

  const response = await fetch(url, {
    method: "POST",

    headers: {
      Authorization:
        `Bearer ${process.env.TESLA_ACCESS_TOKEN}`,

      "Content-Type": "application/json"
    },

    body: JSON.stringify(body)
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(
      data?.error_description ||
      data?.error ||
      `Tesla command failed (${response.status})`
    );

    err.status = response.status;

    throw err;
  }

  return data;
}

/*
 * Passenger UI remains Fahrenheit.
 * Tesla receives Celsius.
 */

function fahrenheitToCelsius(f) {
  return Number(
    (((Number(f) - 32) * 5) / 9).toFixed(1)
  );
}

function validTempF(value) {
  const n = Number(value);

  return (
    Number.isFinite(n) &&
    n >= 68 &&
    n <= 76
  );
}

const allowed = {
  "play-pause": () =>
    proxyCommand("media_toggle_playback"),

  "next": () =>
    proxyCommand("media_next_track"),

  "previous": () =>
    proxyCommand("media_prev_track"),

  "volume-up": () =>
    proxyCommand("media_volume_up"),

  "volume-down": () =>
    proxyCommand("media_volume_down"),

  "set-temp": tempF => {
    const tempC =
      fahrenheitToCelsius(tempF);

    return proxyCommand(
      "set_temps",
      {
        driver_temp: tempC,
        passenger_temp: tempC
      }
    );
  },

  "cooler": tempF => {
    const tempC =
      fahrenheitToCelsius(tempF);

    return proxyCommand(
      "set_temps",
      {
        driver_temp: tempC,
        passenger_temp: tempC
      }
    );
  },

  "warmer": tempF => {
    const tempC =
      fahrenheitToCelsius(tempF);

    return proxyCommand(
      "set_temps",
      {
        driver_temp: tempC,
        passenger_temp: tempC
      }
    );
  }
};

app.post("/api/control", async (req, res) => {
  try {
    const action = req.body?.action;

    if (!allowed[action]) {
      return res.status(400).json({
        error: "Action not allowed"
      });
    }

    let result;

    if (
      ["cooler", "warmer", "set-temp"]
        .includes(action)
    ) {
      const temp =
        Number(req.body?.temperature);

      if (!validTempF(temp)) {
        return res.status(400).json({
          error:
            "Temperature must be between 68°F and 76°F."
        });
      }

      result =
        await allowed[action](temp);

    } else {
      result =
        await allowed[action]();
    }

    res.json({
      ok: true,
      result
    });

  } catch (e) {
    console.error(
      "Passenger command error:",
      e.message
    );

    res.status(e.status || 500).json({
      ok: false,
      error: e.message
    });
  }
});

/*
 * -------------------------------------------------------
 * STATUS
 * -------------------------------------------------------
 */

app.get("/api/status", (_req, res) => {
  res.json({
    app: "Tesla Passenger Control",

    oauthConfigured:
      Boolean(CLIENT_ID && CLIENT_SECRET),

    vehicleConfigured:
      Boolean(VIN),

    limits: {
      minTempF: 68,
      maxTempF: 76
    }
  });
});

/*
 * -------------------------------------------------------
 * PASSENGER WEB APP FALLBACK
 * -------------------------------------------------------
 */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

app.get("/{*splat}", (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

app.listen(PORT, () => {
  console.log(
    `Passenger Control running on port ${PORT}`
  );
});
