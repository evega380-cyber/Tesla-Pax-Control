import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import https from "https";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/*
 * -------------------------------------------------------
 * CONFIGURATION
 * -------------------------------------------------------
 */

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.TESLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TESLA_CLIENT_SECRET;
const VIN = process.env.TESLA_VIN;

const SPOTIFY_CLIENT_ID =
  process.env.SPOTIFY_CLIENT_ID;

const SPOTIFY_CLIENT_SECRET =
  process.env.SPOTIFY_CLIENT_SECRET;

const APP_URL = (
  process.env.APP_URL ||
  "https://tesla-pax-control-production.up.railway.app"
).replace(/\/+$/, "");

const REDIRECT_URI =
  `${APP_URL}/auth/callback`;

const SPOTIFY_REDIRECT_URI =
  `${APP_URL}/spotify/callback`;

const TESLA_AUTH_URL =
  "https://auth.tesla.com/oauth2/v3/authorize";

const TESLA_TOKEN_URL =
  "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token";

const TESLA_AUDIENCE =
  "https://fleet-api.prd.na.vn.cloud.tesla.com";

const SPOTIFY_AUTH_URL =
  "https://accounts.spotify.com/authorize";

const SPOTIFY_TOKEN_URL =
  "https://accounts.spotify.com/api/token";

const SPOTIFY_API_URL =
  "https://api.spotify.com/v1";

const TOKEN_FILE =
  process.env.TESLA_TOKEN_FILE ||
  "/data/tesla-oauth.json";

const SPOTIFY_TOKEN_FILE =
  process.env.SPOTIFY_TOKEN_FILE ||
  "/data/spotify-oauth.json";

const TESLA_PROXY_URL =
  "https://localhost:4443";

const TESLA_PROXY_CERT =
  "/data/tesla-proxy/tls-cert.pem";

const MIN_TEMP_F = 65;
const MAX_TEMP_F = 72;

/*
 * -------------------------------------------------------
 * EXPRESS SETUP
 * -------------------------------------------------------
 */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
 * -------------------------------------------------------
 * COOKIE HELPER
 * -------------------------------------------------------
 */

function parseCookies(req) {
  const cookieHeader =
    req.headers.cookie || "";

  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const name =
      part.slice(0, separator).trim();

    const value =
      part.slice(separator + 1).trim();

    try {
      cookies[name] =
        decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

/*
 * -------------------------------------------------------
 * PASSENGER AUTHORIZATION
 * -------------------------------------------------------
 */

app.get(
  "/passenger/setup",
  (req, res) => {
    const token = req.query.token;

    if (
      !process.env.PASSENGER_TOKEN ||
      token !== process.env.PASSENGER_TOKEN
    ) {
      return res
        .status(401)
        .send(
          "Invalid passenger authorization."
        );
    }

    res.cookie(
      "pax_passenger",
      process.env.PASSENGER_TOKEN,
      {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge:
          1000 *
          60 *
          60 *
          24 *
          365
      }
    );

    return res.redirect("/");
  }
);

function requirePassenger(
  req,
  res,
  next
) {
  const cookies =
    parseCookies(req);

  if (
    !process.env.PASSENGER_TOKEN ||
    cookies.pax_passenger !==
      process.env.PASSENGER_TOKEN
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Passenger authorization required."
      });
  }

  next();
}
/*
 * -------------------------------------------------------
 * DRIVER + CURRENT RIDE
 * -------------------------------------------------------
 */

const DRIVER_PIN =
  process.env.DRIVER_PIN;

/*
 * Store the current ride on Railway's
 * persistent /data volume.
 *
 * This allows the driver phone and
 * passenger iPad to always read the
 * same ride state, even if the Node
 * process restarts.
 */

const RIDE_FILE =
  process.env.RIDE_FILE ||
  "/data/pax-current-ride.json";


/*
 * -------------------------------------------------------
 * EMPTY RIDE
 * -------------------------------------------------------
 */

function emptyRide() {
  return {
    active: false,
    passengerName: "",
    rideId: null,
    startedAt: null
  };
}


/*
 * -------------------------------------------------------
 * LOAD CURRENT RIDE
 * -------------------------------------------------------
 */

function loadCurrentRide() {
  try {
    if (!fs.existsSync(RIDE_FILE)) {
      return emptyRide();
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          RIDE_FILE,
          "utf8"
        )
      );

    return {
      active:
        Boolean(data?.active),

      passengerName:
        data?.active
          ? String(
              data?.passengerName || ""
            )
          : "",

      rideId:
        data?.active
          ? String(
              data?.rideId || ""
            ) || null
          : null,

      startedAt:
        data?.active
          ? data?.startedAt || null
          : null
    };

  } catch (error) {
    console.error(
      "Unable to load current ride:",
      error.message
    );

    return emptyRide();
  }
}


/*
 * -------------------------------------------------------
 * SAVE CURRENT RIDE
 * -------------------------------------------------------
 */

function saveCurrentRide(ride) {
  const directory =
    path.dirname(RIDE_FILE);

  fs.mkdirSync(
    directory,
    {
      recursive: true
    }
  );

  const temporaryFile =
    `${RIDE_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(
      ride,
      null,
      2
    ),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  fs.renameSync(
    temporaryFile,
    RIDE_FILE
  );
}


/*
 * Load any existing ride when
 * the server starts.
 */

let currentRide =
  loadCurrentRide();


/*
 * -------------------------------------------------------
 * DRIVER AUTHORIZATION
 * -------------------------------------------------------
 */

function requireDriver(
  req,
  res,
  next
) {
  const pin =
    String(
      req.headers["x-driver-pin"] || ""
    ).trim();

  if (
    !DRIVER_PIN ||
    pin !== DRIVER_PIN
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Driver authorization required."
      });
  }

  next();
}


/*
 * -------------------------------------------------------
 * PASSENGER CHECKS CURRENT RIDE
 * -------------------------------------------------------
 *
 * Reload the ride from the persistent
 * file every time the iPad checks.
 */

app.get(
  "/api/ride",
  requirePassenger,
  (req, res) => {

    currentRide =
      loadCurrentRide();

    return res.json({
      active:
        currentRide.active,

      passengerName:
        currentRide.active
          ? currentRide.passengerName
          : "",

      rideId:
        currentRide.active
          ? currentRide.rideId
          : null
    });
  }
);


/*
 * -------------------------------------------------------
 * DRIVER CHECKS CURRENT RIDE
 * -------------------------------------------------------
 */

app.get(
  "/api/driver/ride",
  requireDriver,
  (req, res) => {

    currentRide =
      loadCurrentRide();

    return res.json({
      active:
        currentRide.active,

      passengerName:
        currentRide.passengerName,

      rideId:
        currentRide.rideId,

      startedAt:
        currentRide.startedAt
    });
  }
);


/*
 * -------------------------------------------------------
 * START A RIDE
 * -------------------------------------------------------
 */

app.post(
  "/api/driver/start-ride",
  requireDriver,
  (req, res) => {

    let passengerName =
      String(
        req.body?.passengerName || ""
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 30);


    /*
     * Keep the welcome name simple.
     *
     * Letters, spaces, apostrophes
     * and hyphens are allowed.
     */

    passengerName =
      passengerName.replace(
        /[^\p{L}\p{M}' -]/gu,
        ""
      );


    if (!passengerName) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Enter the passenger's first name."
        });
    }


    /*
     * Create a brand-new ride.
     */

    currentRide = {
      active: true,

      passengerName,

      rideId:
        crypto
          .randomBytes(12)
          .toString("hex"),

      startedAt:
        new Date()
          .toISOString()
    };


    /*
     * Save it to Railway's
     * persistent volume.
     */

    saveCurrentRide(
      currentRide
    );


    console.log(
      "Passenger ride started."
    );


    return res.json({
      ok: true,

      ride: {
        active: true,

        passengerName,

        rideId:
          currentRide.rideId
      }
    });
  }
);


/*
 * -------------------------------------------------------
 * END CURRENT RIDE
 * -------------------------------------------------------
 *
 * Passenger information is immediately
 * removed when the driver ends the ride.
 */

app.post(
  "/api/driver/end-ride",
  requireDriver,
  (req, res) => {

    currentRide =
      emptyRide();


    /*
     * Save the cleared ride state
     * to Railway.
     */

    saveCurrentRide(
      currentRide
    );


    console.log(
      "Passenger ride ended."
    );


    return res.json({
      ok: true
    });
  }
);
/*
 * -------------------------------------------------------
 * TESLA OAUTH TOKEN STORAGE
 * -------------------------------------------------------
 */

function saveTokens(tokens) {
  const directory =
    path.dirname(TOKEN_FILE);

  fs.mkdirSync(directory, {
    recursive: true
  });

  const existing =
    loadTokens();

  const data = {
    access_token:
      tokens.access_token ||
      existing?.access_token,

    refresh_token:
      tokens.refresh_token ||
      existing?.refresh_token,

    expires_in:
      tokens.expires_in ||
      existing?.expires_in,

    obtained_at: Date.now()
  };

  const temporaryFile =
    `${TOKEN_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  fs.renameSync(
    temporaryFile,
    TOKEN_FILE
  );
}

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) {
      return null;
    }

    return JSON.parse(
      fs.readFileSync(
        TOKEN_FILE,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      "Unable to load Tesla OAuth tokens:",
      error.message
    );

    return null;
  }
}

function tokenNeedsRefresh(tokens) {
  if (!tokens?.access_token) {
    return true;
  }

  if (
    !tokens.expires_in ||
    !tokens.obtained_at
  ) {
    return false;
  }

  const expiration =
    tokens.obtained_at +
    tokens.expires_in * 1000;

  return (
    Date.now() >=
    expiration - 60000
  );
}

async function refreshTeslaTokens() {
  const existing =
    loadTokens();

  if (!existing?.refresh_token) {
    throw new Error(
      "Tesla authorization is missing. Please authorize Pax Control again."
    );
  }

  const response =
    await fetch(
      TESLA_TOKEN_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          new URLSearchParams({
            grant_type:
              "refresh_token",

            client_id:
              CLIENT_ID,

            refresh_token:
              existing.refresh_token
          })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "Tesla token refresh failed:",
      data
    );

    throw new Error(
      data?.error_description ||
      data?.error ||
      "Tesla token refresh failed."
    );
  }

  saveTokens(data);

  return data.access_token;
}

async function getTeslaAccessToken() {
  const tokens =
    loadTokens();

  if (!tokens) {
    throw new Error(
      "Tesla authorization has not been completed."
    );
  }

  if (tokenNeedsRefresh(tokens)) {
    return await refreshTeslaTokens();
  }

  return tokens.access_token;
}

/*
 * -------------------------------------------------------
 * SPOTIFY TOKEN STORAGE
 * -------------------------------------------------------
 */

function loadSpotifyTokens() {
  try {
    if (
      !fs.existsSync(
        SPOTIFY_TOKEN_FILE
      )
    ) {
      return null;
    }

    return JSON.parse(
      fs.readFileSync(
        SPOTIFY_TOKEN_FILE,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      "Unable to load Spotify tokens:",
      error.message
    );

    return null;
  }
}

function saveSpotifyTokens(tokens) {
  const directory =
    path.dirname(
      SPOTIFY_TOKEN_FILE
    );

  fs.mkdirSync(directory, {
    recursive: true
  });

  const existing =
    loadSpotifyTokens();

  const data = {
    access_token:
      tokens.access_token ||
      existing?.access_token,

    refresh_token:
      tokens.refresh_token ||
      existing?.refresh_token,

    token_type:
      tokens.token_type ||
      existing?.token_type ||
      "Bearer",

    scope:
      tokens.scope ||
      existing?.scope,

    expires_in:
      tokens.expires_in ||
      existing?.expires_in,

    obtained_at:
      Date.now()
  };

  const temporaryFile =
    `${SPOTIFY_TOKEN_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(data, null, 2),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  fs.renameSync(
    temporaryFile,
    SPOTIFY_TOKEN_FILE
  );
}

function spotifyTokenNeedsRefresh(
  tokens
) {
  if (!tokens?.access_token) {
    return true;
  }

  if (
    !tokens.expires_in ||
    !tokens.obtained_at
  ) {
    return false;
  }

  const expiration =
    tokens.obtained_at +
    tokens.expires_in * 1000;

  return (
    Date.now() >=
    expiration - 60000
  );
}

async function refreshSpotifyTokens() {
  const existing =
    loadSpotifyTokens();

  if (!existing?.refresh_token) {
    throw new Error(
      "Spotify authorization is missing."
    );
  }

  const basicAuth =
    Buffer.from(
      `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

  const response =
    await fetch(
      SPOTIFY_TOKEN_URL,
      {
        method: "POST",

        headers: {
          Authorization:
            `Basic ${basicAuth}`,

          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          new URLSearchParams({
            grant_type:
              "refresh_token",

            refresh_token:
              existing.refresh_token
          })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    console.error(
      "Spotify token refresh failed:",
      data
    );

    throw new Error(
      data?.error_description ||
      data?.error ||
      "Spotify token refresh failed."
    );
  }

  saveSpotifyTokens(data);

  return data.access_token;
}

async function getSpotifyAccessToken() {
  const tokens =
    loadSpotifyTokens();

  if (!tokens) {
    throw new Error(
      "Spotify has not been connected."
    );
  }

  if (
    spotifyTokenNeedsRefresh(tokens)
  ) {
    return await refreshSpotifyTokens();
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
  (req, res) => {
    const publicKeyPath =
      path.join(
        __dirname,
        "public",
        ".well-known",
        "appspecific",
        "com.tesla.3p.public-key.pem"
      );

    if (!fs.existsSync(publicKeyPath)) {
      return res
        .status(404)
        .send(
          "Tesla public key not found."
        );
    }

    res.type("text/plain");

    return res.sendFile(
      publicKeyPath
    );
  }
);

/*
 * -------------------------------------------------------
 * TESLA OAUTH
 * -------------------------------------------------------
 */

app.get(
  "/auth/login",
  (req, res) => {
    if (
      !CLIENT_ID ||
      !CLIENT_SECRET
    ) {
      return res
        .status(500)
        .send(
          "Tesla OAuth is not configured."
        );
    }

    const state =
      crypto
        .randomBytes(24)
        .toString("hex");

    res.cookie(
      "tesla_oauth_state",
      state,
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge:
          10 * 60 * 1000
      }
    );

    const params =
      new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri:
          REDIRECT_URI,

        scope:
  "openid offline_access vehicle_cmds vehicle_device_data vehicle_location",

        state,
        locale: "en-US",
        prompt: "login",
        prompt_missing_scopes:
          "true",
        require_requested_scopes:
          "true"
      });

    return res.redirect(
      `${TESLA_AUTH_URL}?${params.toString()}`
    );
  }
);

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
        return res
          .status(400)
          .send(
            `Tesla authorization failed: ${
              error_description ||
              error
            }`
          );
      }

      if (!code) {
        return res
          .status(400)
          .send(
            "Tesla authorization code is missing."
          );
      }

      const cookies =
        parseCookies(req);

      if (
        !state ||
        !cookies.tesla_oauth_state ||
        state !==
          cookies.tesla_oauth_state
      ) {
        return res
          .status(400)
          .send(
            "Invalid Tesla OAuth state."
          );
      }

      const response =
        await fetch(
          TESLA_TOKEN_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            body:
              new URLSearchParams({
                grant_type:
                  "authorization_code",

                client_id:
                  CLIENT_ID,

                client_secret:
                  CLIENT_SECRET,

                code,

                audience:
                  TESLA_AUDIENCE,

                redirect_uri:
                  REDIRECT_URI
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "Tesla OAuth callback failed:",
          data
        );

        return res
          .status(response.status)
          .json(data);
      }

      saveTokens(data);

      res.clearCookie(
        "tesla_oauth_state"
      );

      return res.redirect("/");
    } catch (error) {
      console.error(
        "Tesla OAuth callback error:",
        error
      );

      return res
        .status(500)
        .send(
          "Tesla authorization failed."
        );
    }
  }
);

/*
 * -------------------------------------------------------
 * SPOTIFY OAUTH
 * -------------------------------------------------------
 */

app.get(
  "/spotify/login",
  requirePassenger,
  (req, res) => {
    if (
      !SPOTIFY_CLIENT_ID ||
      !SPOTIFY_CLIENT_SECRET
    ) {
      return res
        .status(500)
        .send(
          "Spotify OAuth is not configured."
        );
    }

    const state =
      crypto
        .randomBytes(24)
        .toString("hex");

    res.cookie(
      "spotify_oauth_state",
      state,
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge:
          10 * 60 * 1000
      }
    );

    const params =
      new URLSearchParams({
        response_type: "code",

        client_id:
          SPOTIFY_CLIENT_ID,

        redirect_uri:
          SPOTIFY_REDIRECT_URI,

        state,

        scope:
          [
            "user-read-playback-state",
            "user-read-currently-playing",
            "user-modify-playback-state"
          ].join(" ")
      });

    return res.redirect(
      `${SPOTIFY_AUTH_URL}?${params.toString()}`
    );
  }
);

app.get(
  "/spotify/callback",
  async (req, res) => {
    try {
      const {
        code,
        state,
        error
      } = req.query;

      if (error) {
        return res
          .status(400)
          .send(
            `Spotify authorization failed: ${error}`
          );
      }

      const cookies =
        parseCookies(req);

      if (
        !code ||
        !state ||
        !cookies.spotify_oauth_state ||
        state !==
          cookies.spotify_oauth_state
      ) {
        return res
          .status(400)
          .send(
            "Invalid Spotify authorization response."
          );
      }

      const basicAuth =
        Buffer.from(
          `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
        ).toString("base64");

      const response =
        await fetch(
          SPOTIFY_TOKEN_URL,
          {
            method: "POST",

            headers: {
              Authorization:
                `Basic ${basicAuth}`,

              "Content-Type":
                "application/x-www-form-urlencoded"
            },

            body:
              new URLSearchParams({
                grant_type:
                  "authorization_code",

                code,

                redirect_uri:
                  SPOTIFY_REDIRECT_URI
              })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "Spotify OAuth callback failed:",
          data
        );

        return res
          .status(response.status)
          .send(
            "Spotify authorization failed."
          );
      }

      saveSpotifyTokens(data);

      res.clearCookie(
        "spotify_oauth_state"
      );

      return res.redirect(
        "/?spotify=connected"
      );
    } catch (error) {
      console.error(
        "Spotify OAuth callback error:",
        error.message
      );

      return res
        .status(500)
        .send(
          "Spotify authorization failed."
        );
    }
  }
);

/*
 * -------------------------------------------------------
 * SPOTIFY API HELPER
 * -------------------------------------------------------
 */

async function spotifyRequest(
  endpoint,
  options = {}
) {
  const accessToken =
    await getSpotifyAccessToken();

  const response =
    await fetch(
      `${SPOTIFY_API_URL}${endpoint}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          ...(options.headers || {})
        }
      }
    );

  /*
   * Spotify uses empty responses for
   * several playback commands.
   */
  if (
    response.status === 204 ||
    response.status === 205
  ) {
    return null;
  }

  /*
   * Read the response as text first.
   *
   * Some Spotify responses are not JSON.
   * Trying response.json() directly would
   * crash with "Unexpected token".
   */
  const raw =
    await response.text();

  let data = null;

  if (raw) {
    try {
      data =
        JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  /*
   * Successful response.
   */
  if (response.ok) {
    return data;
  }

  /*
   * Spotify returned an error.
   */
  let errorMessage =
    "Spotify request failed.";

  if (
    data?.error?.message
  ) {
    errorMessage =
      data.error.message;

  } else if (
    typeof data?.error ===
    "string"
  ) {
    errorMessage =
      data.error;

  } else if (raw) {

    /*
     * Don't dump Spotify's entire
     * response onto the passenger
     * screen. Keep the error clean.
     */
    errorMessage =
      `Spotify request failed (${response.status}).`;
  }

  const error =
    new Error(
      errorMessage
    );

  error.statusCode =
    response.status;

  throw error;
}
/*
 * -------------------------------------------------------
 * SPOTIFY STATUS
 * -------------------------------------------------------
 */

app.get(
  "/api/spotify/status",
  requirePassenger,
  (req, res) => {
    const tokens =
      loadSpotifyTokens();

    return res.json({
      configured:
        Boolean(
          SPOTIFY_CLIENT_ID &&
          SPOTIFY_CLIENT_SECRET
        ),

      connected:
        Boolean(
          tokens?.access_token
        )
    });
  }
);

/*
 * -------------------------------------------------------
 * SPOTIFY NOW PLAYING
 * -------------------------------------------------------
 */

app.get(
  "/api/spotify/now-playing",
  requirePassenger,
  async (req, res) => {
    try {
      const data =
        await spotifyRequest(
          "/me/player/currently-playing"
        );

      if (!data?.item) {
        return res.json({
          playing: false,
          item: null
        });
      }

      return res.json({
        playing:
          Boolean(
            data.is_playing
          ),

        progressMs:
          data.progress_ms || 0,

        item: {
          name:
            data.item.name,

          artist:
            data.item.artists
              ?.map(
                artist =>
                  artist.name
              )
              .join(", ") || "",

          album:
            data.item.album?.name ||
            "",

          artwork:
            data.item.album
              ?.images?.[0]?.url ||
            null,

          durationMs:
            data.item.duration_ms ||
            0,

          uri:
            data.item.uri
        }
      });
    } catch (error) {
      console.error(
        "Spotify now-playing error:",
        error.message
      );

      return res
        .status(
          error.statusCode ||
          500
        )
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/*
 * -------------------------------------------------------
 * SPOTIFY DEVICES
 * -------------------------------------------------------
 */

app.get(
  "/api/spotify/devices",
  requirePassenger,
  async (req, res) => {
    try {
      const data =
        await spotifyRequest(
          "/me/player/devices"
        );

      const devices =
        (data?.devices || [])
          .map(device => ({
            id: device.id,
            name: device.name,
            type: device.type,
            active:
              device.is_active,
            volume:
              device.volume_percent
          }));

      return res.json({
        devices
      });
    } catch (error) {
      console.error(
        "Spotify devices error:",
        error.message
      );

      return res
        .status(
          error.statusCode ||
          500
        )
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/*
 * -------------------------------------------------------
 * SPOTIFY SEARCH
 * -------------------------------------------------------
 */

app.get(
  "/api/spotify/search",
  requirePassenger,
  async (req, res) => {
    try {
      const query =
        String(req.query.q || "")
          .trim()
          .slice(0, 100);

      if (!query) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Enter something to search for."
          });
      }

      const data =
        await spotifyRequest(
          `/search?type=track&limit=10&q=${encodeURIComponent(query)}`
        );

      const tracks =
        (data?.tracks?.items || [])
          .map(track => ({
            name: track.name,

            artist:
              track.artists
                ?.map(
                  artist =>
                    artist.name
                )
                .join(", ") || "",

            album:
              track.album?.name || "",

            artwork:
              track.album
                ?.images?.[1]?.url ||
              track.album
                ?.images?.[0]?.url ||
              null,

            uri: track.uri,

            durationMs:
              track.duration_ms || 0
          }));

      return res.json({
        tracks
      });

    } catch (error) {
      console.error(
        "Spotify search error:",
        error.message
      );

      return res
        .status(
          error.statusCode || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Spotify search failed."
        });
    }
  }
);
/*
 * -------------------------------------------------------
 * PLAY SELECTED SPOTIFY TRACK IN TESLA
 * -------------------------------------------------------
 */

app.post(
  "/api/spotify/play",
  requirePassenger,
  async (req, res) => {
    try {
      const uri =
        String(
          req.body?.uri || ""
        ).trim();

      /*
       * Only allow Spotify track URIs.
       */
      if (
        !/^spotify:track:[A-Za-z0-9]+$/.test(uri)
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid Spotify track."
          });
      }

      /*
       * Find the Tesla Media Player.
       */
      const deviceData =
        await spotifyRequest(
          "/me/player/devices"
        );

      const tesla =
        (deviceData?.devices || [])
          .find(device =>
            device.type
              ?.toLowerCase() ===
              "automobile" ||
            device.name
              ?.toLowerCase()
              .includes("tesla")
          );

      if (!tesla?.id) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Tesla Media Player is not currently available."
          });
      }

      /*
       * Start the passenger's selected song.
       */
      await spotifyRequest(
        `/me/player/play?device_id=${encodeURIComponent(tesla.id)}`,
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              uris: [uri]
            })
        }
      );

      /*
       * Search Spotify using the selected
       * track's artist information so we
       * can place more music behind it.
       */

      const trackId =
        uri.split(":")[2];

      const selectedTrack =
        await spotifyRequest(
          `/tracks/${encodeURIComponent(trackId)}`
        );

      const artistName =
        selectedTrack
          ?.artists?.[0]?.name || "";

      /*
       * Find additional music from the
       * same artist. These tracks are
       * added to the Spotify queue and
       * will play after the requested song.
       */
      if (artistName) {
        const related =
          await spotifyRequest(
            `/search?type=track&limit=10&q=${encodeURIComponent(
              `artist:${artistName}`
            )}`
          );

        const additionalTracks =
          (related?.tracks?.items || [])
            .filter(
              track =>
                track?.uri &&
                track.uri !== uri
            )
            .slice(0, 5);

        for (
          const track
          of additionalTracks
        ) {
          try {
            await spotifyRequest(
              `/me/player/queue?uri=${encodeURIComponent(
                track.uri
              )}&device_id=${encodeURIComponent(
                tesla.id
              )}`,
              {
                method: "POST"
              }
            );
          } catch (queueError) {
            console.error(
              "Spotify queue item error:",
              queueError.message
            );
          }
        }
      }

      return res.json({
        ok: true
      });

    } catch (error) {
      console.error(
        "Spotify Tesla playback error:",
        error.message
      );

      return res
        .status(
          error.statusCode || 500
        )
        .json({
          ok: false,

          error:
            error.message ||
            "Unable to play this track."
        });
    }
  }
);
/*
 * -------------------------------------------------------
 * SPOTIFY VIBE PLAYBACK
 * -------------------------------------------------------
 */

app.post(
  "/api/spotify/vibe",
  requirePassenger,
  async (req, res) => {
    try {
      const vibe =
        String(
          req.body?.vibe || ""
        )
          .trim()
          .toLowerCase();

      /*
       * Approved passenger playlists.
       */
      const vibes = {
        goodvibes:
          "spotify:playlist:37i9dQZF1EIdDn5P759aRj",

        chill:
          "spotify:playlist:37i9dQZF1EVHGWrwldPRtj",

        hits:
          "spotify:playlist:37i9dQZF1DX1gRalH1mWrP",

        rnb:
          "spotify:playlist:37i9dQZF1DX6VDO8a6cQME",

        throwbacks:
          "spotify:playlist:3QZf1TNPVe2J1Dp21UJCrW",

        party:
          "spotify:playlist:37i9dQZF1EIeYvPpy9CZHr",

        latino:
          "spotify:playlist:0q1di38xTtJS21GjOtaeNb",

        faith:
          "spotify:playlist:37i9dQZF1DWUileP28ODwg"
      };

      const playlistUri =
        vibes[vibe];

      if (!playlistUri) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid music vibe."
          });
      }

      /*
       * Find the Tesla Spotify player.
       */
      const deviceData =
        await spotifyRequest(
          "/me/player/devices"
        );

      const tesla =
        (deviceData?.devices || [])
          .find(device =>
            device.type
              ?.toLowerCase() ===
              "automobile" ||
            device.name
              ?.toLowerCase()
              .includes("tesla")
          );

      if (!tesla?.id) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Tesla Media Player is not currently available."
          });
      }

      const deviceId =
        encodeURIComponent(
          tesla.id
        );

      /*
       * Turn Spotify shuffle ON
       * for the Tesla player.
       */
      await spotifyRequest(
        `/me/player/shuffle?state=true&device_id=${deviceId}`,
        {
          method: "PUT"
        }
      );

      /*
       * Start the actual Spotify
       * playlist context.
       *
       * Spotify now controls the
       * continuing playlist instead
       * of Pax Control manually
       * queueing search results.
       */
      await spotifyRequest(
        `/me/player/play?device_id=${deviceId}`,
        {
          method: "PUT",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              context_uri:
                playlistUri
            })
        }
      );

      /*
       * Give Spotify a moment to
       * switch playback contexts.
       */
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            600
          )
      );

      /*
       * Read the track Spotify
       * actually started so the
       * passenger screen can update
       * immediately.
       */
      let track = null;

      try {
        const current =
          await spotifyRequest(
            "/me/player/currently-playing"
          );

        if (current?.item) {
          track = {
            name:
              current.item.name ||
              "Unknown Track",

            artist:
              current.item.artists
                ?.map(
                  artist =>
                    artist.name
                )
                .join(", ") || "",

            album:
              current.item.album
                ?.name || "",

            artwork:
              current.item.album
                ?.images?.[0]?.url ||
              null,

            durationMs:
              current.item
                .duration_ms || 0,

            progressMs:
              current.progress_ms || 0,

            playing:
              Boolean(
                current.is_playing
              ),

            uri:
              current.item.uri
          };
        }
      } catch (nowPlayingError) {
        /*
         * Playback already succeeded,
         * so don't fail the Vibe just
         * because Now Playing took
         * longer to refresh.
         */
        console.log(
          "Spotify vibe now-playing delay:",
          nowPlayingError.message
        );
      }

      return res.json({
        ok: true,
        vibe,
        playlistUri,
        shuffle: true,
        track
      });

    } catch (error) {
      console.error(
        "Spotify vibe error:",
        error.message
      );

      return res
        .status(
          error.statusCode || 500
        )
        .json({
          ok: false,
          error:
            error.message ||
            "Unable to start this vibe."
        });
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
  (req, res) => {
    const tokens =
      loadTokens();

    const spotifyTokens =
      loadSpotifyTokens();

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

      authorizationStored:
        Boolean(
          tokens?.access_token
        ),

      commandProxyConfigured:
        true,

      passengerProtectionConfigured:
        Boolean(
          process.env.PASSENGER_TOKEN
        ),

      spotifyConfigured:
        Boolean(
          SPOTIFY_CLIENT_ID &&
          SPOTIFY_CLIENT_SECRET
        ),

      spotifyConnected:
        Boolean(
          spotifyTokens?.access_token
        ),

      limits: {
        minTempF:
          MIN_TEMP_F,

        maxTempF:
          MAX_TEMP_F
      }
    });
  }
);

/*
 * -------------------------------------------------------
 * TESLA SIGNED COMMAND PROXY
 * -------------------------------------------------------
 */

async function sendTeslaCommand(
  command,
  body = {}
) {
  if (!VIN) {
    throw new Error(
      "TESLA_VIN is not configured."
    );
  }

  const accessToken =
    await getTeslaAccessToken();

  if (
    !fs.existsSync(
      TESLA_PROXY_CERT
    )
  ) {
    throw new Error(
      "Tesla command proxy certificate is missing."
    );
  }

  const ca =
    fs.readFileSync(
      TESLA_PROXY_CERT
    );

  const agent =
    new https.Agent({
      ca,
      rejectUnauthorized: true
    });

  const url =
    `${TESLA_PROXY_URL}` +
    `/api/1/vehicles/` +
    `${encodeURIComponent(VIN)}` +
    `/command/${command}`;

  return await new Promise(
    (resolve, reject) => {
      const payload =
        JSON.stringify(body);

      const request =
        https.request(
          url,
          {
            method: "POST",
            agent,

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",

              "Content-Length":
                Buffer.byteLength(
                  payload
                )
            }
          },

          response => {
            let raw = "";

            response.on(
              "data",
              chunk => {
                raw += chunk;
              }
            );

            response.on(
              "end",
              () => {
                let data = {};

                if (raw) {
                  try {
                    data =
                      JSON.parse(raw);
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

                const error =
                  new Error(
                    data
                      ?.error_description ||
                    data?.error ||
                    `Tesla command failed (${response.statusCode})`
                  );

                error.statusCode =
                  response.statusCode;

                error.teslaResponse =
                  data;

                return reject(error);
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.write(payload);
      request.end();
    }
  );
}

/*
 * -------------------------------------------------------
 * PASSENGER TRIP / NAVIGATION
 * -------------------------------------------------------
 */

app.get(
  "/api/trip",
  requirePassenger,
  async (req, res) => {
    try {
      /*
       * Only expose live trip information
       * while a passenger ride is active.
       */
      if (!currentRide.active) {
        return res.json({
          active: false,
          navigationActive: false
        });
      }

      const accessToken =
        await getTeslaAccessToken();

      const response =
        await fetch(
          `${TESLA_AUDIENCE}/api/1/vehicles/${encodeURIComponent(VIN)}/vehicle_data?endpoints=location_data`,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`
            }
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        return res
          .status(response.status)
          .json({
            ok: false,
            error:
              data?.error ||
              "Unable to retrieve trip information."
          });
      }

      const drive =
        data?.response?.drive_state ||
        data?.response?.location_data ||
        {};

      const destination =
        String(
          drive.active_route_destination ||
          ""
        ).trim();

      /*
       * No active Tesla navigation route.
       */
      if (!destination) {
        return res.json({
          active: true,
          navigationActive: false
        });
      }

      /*
       * Return only the information needed
       * by the passenger Trip screen.
       *
       * Battery information and other raw
       * vehicle/location fields are intentionally
       * excluded.
       */
      return res.json({
        active: true,
        navigationActive: true,

        destination,

        minutesRemaining:
          Number.isFinite(
            Number(
              drive.active_route_minutes_to_arrival
            )
          )
            ? Number(
                drive.active_route_minutes_to_arrival
              )
            : null,

        milesRemaining:
          Number.isFinite(
            Number(
              drive.active_route_miles_to_arrival
            )
          )
            ? Number(
                drive.active_route_miles_to_arrival
              )
            : null,

        trafficDelayMinutes:
          Number.isFinite(
            Number(
              drive.active_route_traffic_minutes_delay
            )
          )
            ? Number(
                drive.active_route_traffic_minutes_delay
              )
            : null,

        vehicle: {
          latitude:
            Number.isFinite(
              Number(drive.latitude)
            )
              ? Number(drive.latitude)
              : null,

          longitude:
            Number.isFinite(
              Number(drive.longitude)
            )
              ? Number(drive.longitude)
              : null,

          heading:
            Number.isFinite(
              Number(drive.heading)
            )
              ? Number(drive.heading)
              : null
        },

        destinationLocation: {
          latitude:
            Number.isFinite(
              Number(
                drive.active_route_latitude
              )
            )
              ? Number(
                  drive.active_route_latitude
                )
              : null,

          longitude:
            Number.isFinite(
              Number(
                drive.active_route_longitude
              )
            )
              ? Number(
                  drive.active_route_longitude
                )
              : null
        }
      });

    } catch (error) {
      console.error(
        "Passenger trip error:",
        error.message
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            "Unable to retrieve trip information."
        });
    }
  }
);
/*
 * -------------------------------------------------------
 * PASSENGER TESLA COMMANDS
 * -------------------------------------------------------
 */

app.post(
  "/api/control",
  requirePassenger,
  async (req, res) => {
    try {
      const {
        action,
        temperatureF
      } = req.body || {};

      const commands = {
        previous:
          "media_prev_track",

        playPause:
          "media_toggle_playback",

        next:
          "media_next_track",

        volumeDown:
          "media_volume_down",

        volumeUp:
          "media_volume_up"
      };

      if (commands[action]) {
        const result =
          await sendTeslaCommand(
            commands[action],
            {}
          );

        return res.json({
          ok: true,
          action,
          tesla: result
        });
      }

      if (
        action ===
        "temperature"
      ) {
        const tempF =
          Number(temperatureF);

        if (
          !Number.isFinite(tempF) ||
          tempF < MIN_TEMP_F ||
          tempF > MAX_TEMP_F
        ) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                `Temperature must be between ${MIN_TEMP_F}°F and ${MAX_TEMP_F}°F.`
            });
        }

        const tempC =
          Number(
            (
              ((tempF - 32) * 5) /
              9
            ).toFixed(1)
          );

        const result =
          await sendTeslaCommand(
            "set_temps",
            {
              driver_temp:
                tempC,

              passenger_temp:
                tempC
            }
          );

        return res.json({
          ok: true,
          action:
            "temperature",
          temperatureF:
            tempF,
          temperatureC:
            tempC,
          tesla:
            result
        });
      }

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Unsupported passenger command."
        });
    } catch (error) {
      console.error(
        "Tesla command error:",
        error.message
      );

      return res
        .status(
          error.statusCode ||
          500
        )
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
 * STATIC PASSENGER INTERFACE
 * -------------------------------------------------------
 */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/*
 * -------------------------------------------------------
 * FALLBACK
 * -------------------------------------------------------
 */

app.get(
  "/{*splat}",
  (req, res) => {
    return res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );
  }
);

/*
 * -------------------------------------------------------
 * START SERVER
 * -------------------------------------------------------
 */

app.listen(
  PORT,
  () => {
    console.log(
      `Passenger Control running on port ${PORT}`
    );
  }
);
