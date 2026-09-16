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
        "openid offline_access vehicle_cmds",
      state,
      locale: "en-US",
      prompt: "login"
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
        false,

      limits: {
        minTempF: MIN_TEMP_F,
        maxTempF: MAX_TEMP_F
      }
    });
  }
);

/*
 * -------------------------------------------------------
 * PASSENGER COMMAND ENDPOINT
 *
 * Deliberately disabled until Tesla's
 * signed Vehicle Command Proxy is installed.
 * -------------------------------------------------------
 */

app.post(
  "/api/control",
  (_req, res) => {
    res.status(503).json({
      ok: false,

      error:
        "Vehicle command signing is not configured yet."
    });
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
