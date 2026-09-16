import express from "express";
import path from "path";
import crypto from "crypto";
import fs from "fs/promises";
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
const VIN = process.env.TESLA_VIN;

const APP_URL = (
  process.env.APP_URL ||
  "https://tesla-pax-control-production.up.railway.app"
).replace(/\/+$/, "");

const REDIRECT_URI = `${APP_URL}/auth/callback`;

const TESLA_AUTH_URL =
  "https://auth.tesla.com/oauth2/v3/authorize";

const TESLA_TOKEN_URL =
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

const TESLA_AUDIENCE =
  "https://fleet-api.prd.na.vn.cloud.tesla.com";

const TOKEN_FILE =
  process.env.TESLA_TOKEN_FILE ||
  "/data/tesla-oauth.json";

const MIN_TEMP_F = 65;
const MAX_TEMP_F = 72;

const oauthStates = new Map();

/*
 * -------------------------------------------------------
 * TOKEN STORAGE
 * -------------------------------------------------------
 */

async function saveTokens(tokens) {
  const record = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: Number(tokens.expires_in || 0),
    obtained_at: Date.now()
  };

  await fs.mkdir(path.dirname(TOKEN_FILE), {
    recursive: true
  });

  const temporaryFile = `${TOKEN_FILE}.tmp`;

  await fs.writeFile(
    temporaryFile,
    JSON.stringify(record),
    { mode: 0o600 }
  );

  await fs.rename(
    temporaryFile,
    TOKEN_FILE
  );
}

async function loadTokens() {
  try {
    const raw =
      await fs.readFile(TOKEN_FILE, "utf8");

    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function tokenNeedsRefresh(tokens) {
  if (!tokens?.access_token) {
    return true;
  }

  const expiresAt =
    tokens.obtained_at +
    (tokens.expires_in * 1000);

  // Refresh if less than 60 seconds remain.
  return Date.now() >= expiresAt - 60000;
}

async function refreshTeslaTokens(tokens) {
  if (!tokens?.refresh_token) {
    throw new Error(
      "Tesla authorization is required."
    );
  }

  const response = await fetch(
    TESLA_TOKEN_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refresh_token
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
      data?.error ||
      "Tesla token refresh failed."
    );
  }

  if (!data.refresh_token) {
    throw new Error(
      "Tesla did not return a replacement refresh token."
    );
  }

  /*
   * Tesla refresh tokens rotate.
   * Save the replacement BEFORE returning it.
   */
  await saveTokens(data);

  return data;
}

async function getTeslaAccessToken() {
  let tokens = await loadTokens();

  if (!tokens) {
    throw new Error(
      "Tesla account has not been authorized on this server."
    );
  }

  if (tokenNeedsRefresh(tokens)) {
    tokens =
      await refreshTeslaTokens(tokens);
  }

  return tokens.access_token;
}

/*
 * -------------------------------------------------------
 * TESLA PUBLIC KEY
 * -------------------------------------------------------
 */

app.get(
  "/.well-known/appspecific/com.tesla.3p.public-key.pem",
  (_req, res) => {
    res.sendFile(
      "com.tesla.3p.public-key.pem",
      {
        root:
          "public/.well-known/appspecific"
      }
    );
  }
);

/*
 * -------------------------------------------------------
 * OAUTH LOGIN
 * -------------------------------------------------------
 */

app.get("/auth/login", (_req, res) => {
  if (!CLIENT_ID) {
    return res.status(503).send(
      "TESLA_CLIENT_ID is not configured."
    );
  }

  const state =
    crypto.randomBytes(32).toString("hex");

  oauthStates.set(
    state,
    Date.now() + 10 * 60 * 1000
  );

  const params =
    new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
  scope:
  "openid offline_access vehicle_cmds vehicle_device_data",
      state,
      locale: "en-US",
      prompt: "login",
prompt_missing_scopes: "true",
require_requested_scopes: "true"
    });

  res.redirect(
    `${TESLA_AUTH_URL}?${params.toString()}`
  );
});

/*
 * -------------------------------------------------------
 * OAUTH CALLBACK
 * -------------------------------------------------------
 */

app.get(
  "/auth/callback",
  async (req, res) => {
    try {
      const {
        code,
        state,
        error,
        error_description
      } = req.query;

      if (error) {
        return res.status(400).send(
          `Tesla authorization failed: ${
            String(
              error_description || error
            )
          }`
        );
      }

      const stateExpiration =
        oauthStates.get(state);

      if (
        !code ||
        !state ||
        !stateExpiration ||
        Date.now() > stateExpiration
      ) {
        oauthStates.delete(state);

        return res.status(400).send(
          "Invalid or expired authorization request."
        );
      }

      oauthStates.delete(state);

      if (!CLIENT_ID || !CLIENT_SECRET) {
        return res.status(503).send(
          "Tesla OAuth credentials are not configured."
        );
      }

      const tokenResponse =
        await fetch(
          TESLA_TOKEN_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            body: new URLSearchParams({
              grant_type:
                "authorization_code",

              client_id:
                CLIENT_ID,

              client_secret:
                CLIENT_SECRET,

              code:
                String(code),

              audience:
                TESLA_AUDIENCE,

              redirect_uri:
                REDIRECT_URI
            })
          }
        );

      const data =
        await tokenResponse.json();

      if (!tokenResponse.ok) {
        console.error(
          "Tesla OAuth exchange failed:",
          data?.error ||
          tokenResponse.status
        );

        return res.status(500).send(
          "Tesla authorization could not be completed."
        );
      }

      if (
        !data.access_token ||
        !data.refresh_token
      ) {
        return res.status(500).send(
          "Tesla did not return the required authorization credentials."
        );
      }

      await saveTokens(data);

      console.log(
        "Tesla authorization saved successfully."
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

            <title>
              Pax Control Authorized
            </title>

            <style>
              body {
                background: #111318;
                color: white;
                font-family:
                  system-ui,
                  -apple-system,
                  sans-serif;

                max-width: 650px;
                margin: 80px auto;
                padding: 30px;
                text-align: center;
              }

              h1 {
                font-size: 34px;
              }

              p {
                color: #c7cbd3;
                font-size: 18px;
                line-height: 1.6;
              }
            </style>
          </head>

          <body>
            <h1>✓ Tesla Authorized</h1>

            <p>
              Pax Control securely saved
              your Tesla authorization.
            </p>

            <p>
              You may close this page.
            </p>
          </body>
        </html>
      `);

    } catch (error) {
      console.error(
        "OAuth callback error:",
        error.message
      );

      res.status(500).send(
        "Tesla authorization encountered an error."
      );
    }
  }
);

/*
 * -------------------------------------------------------
 * STATUS
 * -------------------------------------------------------
 */

app.get(
  "/api/status",
  async (_req, res) => {
    let authorizationStored = false;

    try {
      authorizationStored =
        Boolean(await loadTokens());
    } catch {
      authorizationStored = false;
    }

    res.json({
      app:
        "Tesla Passenger Control",

      oauthConfigured:
        Boolean(
          CLIENT_ID &&
          CLIENT_SECRET
        ),

      vehicleConfigured:
        Boolean(VIN),

      authorizationStored,

      commandProxyConfigured:
        true,

      limits: {
        minTempF: MIN_TEMP_F,
        maxTempF: MAX_TEMP_F
      }
    });
  }
);

/*
 * -------------------------------------------------------
 * TESLA SIGNED COMMAND PROXY
 * -------------------------------------------------------
 */

const TESLA_PROXY_URL = "https://localhost:4443";
const TESLA_PROXY_CERT = "/data/tesla-proxy/tls-cert.pem";

async function sendTeslaCommand(command, body = {}) {
  if (!VIN) {
    throw new Error("TESLA_VIN is not configured.");
  }

  const accessToken = await getTeslaAccessToken();

  /*
   * Trust ONLY our locally generated Tesla proxy certificate.
   * We do not disable TLS verification globally.
   */
  const https = await import("https");
  const fsSync = await import("fs");

  const ca = fsSync.readFileSync(TESLA_PROXY_CERT);

  const agent = new https.Agent({
    ca,
    rejectUnauthorized: true
  });

  const url =
    `${TESLA_PROXY_URL}/api/1/vehicles/` +
    `${encodeURIComponent(VIN)}/command/` +
    `${command}`;

  /*
   * Node's built-in fetch does not accept https.Agent,
   * so use https.request for this localhost TLS connection.
   */
  return await new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const request = https.request(
      url,
      {
        method: "POST",
        agent,

        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Content-Length":
            Buffer.byteLength(payload)
        }
      },

      (response) => {
        let raw = "";

        response.on("data", (chunk) => {
          raw += chunk;
        });

        response.on("end", () => {
          let data = {};

          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = { raw };
            }
          }

          if (
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            return resolve(data);
          }

          const error = new Error(
            data?.error_description ||
            data?.error ||
            `Tesla command failed (${response.statusCode})`
          );

          error.statusCode = response.statusCode;
          error.teslaResponse = data;

          reject(error);
        });
      }
    );

    request.on("error", reject);

    request.write(payload);
    request.end();
  });
}

app.get("/api/test-vehicle", async (req, res) => {
  try {
    const accessToken = await getTeslaAccessToken();

    const response = await fetch(
      `${TESLA_AUDIENCE}/api/1/vehicles/${encodeURIComponent(VIN)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const text = await response.text();

    res.status(response.status).json({
      status: response.status,
      teslaResponse: text
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
app.get("/api/test-scopes", async (req, res) => {
  try {
    const accessToken = await getTeslaAccessToken();

    const payloadPart = accessToken.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    );

    res.json({
      scopes: payload.scp || []
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});
function requirePassenger(req, res, next) {
  const token = req.headers["x-passenger-token"];

  if (!process.env.PASSENGER_TOKEN || token !== process.env.PASSENGER_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Passenger authorization required."
    });
  }

  next();
}
/*
 * -------------------------------------------------------
 * PASSENGER COMMAND ENDPOINT
 * -------------------------------------------------------
 */
app.get("/passenger/setup", (req, res) => {
  const token = req.query.token;

  if (!process.env.PASSENGER_TOKEN || token !== process.env.PASSENGER_TOKEN) {
    return res.status(401).send("Invalid passenger authorization.");
  }

  res.cookie("pax_passenger", process.env.PASSENGER_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: 1000 * 60 * 60 * 24 * 365
  });

  res.redirect("/");
});
function requirePassenger(req, res, next) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map(cookie => {
        const index = cookie.indexOf("=");
        return [
          cookie.slice(0, index).trim(),
          decodeURIComponent(cookie.slice(index + 1))
        ];
      })
  );

  const token = cookies.pax_passenger;

  if (!process.env.PASSENGER_TOKEN || token !== process.env.PASSENGER_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Passenger authorization required."
    });
  }

  next();
}

      /*
       * MEDIA CONTROLS
       */
      if (commands[action]) {
        const result = await sendTeslaCommand(
          commands[action],
          {}
        );

        return res.json({
          ok: true,
          action,
          tesla: result
        });
      }

      /*
       * TEMPERATURE CONTROL
       */
      if (action === "temperature") {
        const tempF = Number(temperatureF);

        if (
          !Number.isFinite(tempF) ||
          tempF < MIN_TEMP_F ||
          tempF > MAX_TEMP_F
        ) {
          return res.status(400).json({
            ok: false,
            error:
              `Temperature must be between ` +
              `${MIN_TEMP_F}°F and ${MAX_TEMP_F}°F.`
          });
        }

        /*
         * Tesla's set_temps endpoint expects Celsius.
         */
        const tempC =
          Number(
            (((tempF - 32) * 5) / 9).toFixed(1)
          );

        const result = await sendTeslaCommand(
          "set_temps",
          {
            driver_temp: tempC,
            passenger_temp: tempC
          }
        );

        return res.json({
          ok: true,
          action: "temperature",
          temperatureF: tempF,
          temperatureC: tempC,
          tesla: result
        });
      }

      /*
       * Anything else is rejected.
       */
      return res.status(400).json({
        ok: false,
        error: "Unsupported passenger command."
      });

    } catch (error) {
      console.error(
        "Tesla command error:",
        error.message
      );

      return res
        .status(error.statusCode || 500)
        .json({
          ok: false,
          error:
            error.message ||
            "Tesla command failed."
        });
    }
  }
);
/*
 * -------------------------------------------------------
 * PASSENGER WEB APP
 * -------------------------------------------------------
 */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

app.get(
  "/{*splat}",
  (_req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Passenger Control running on port ${PORT}`
    );
  }
);
