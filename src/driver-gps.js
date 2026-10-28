import crypto from "node:crypto";
import { Router } from "express";

/**
 * Driver GPS API. Not mounted in production until integration review.
 * Requires GPS_DRIVER_TOKEN distinct from DRIVER_PIN and PASSENGER_TOKEN.
 * Coordinates remain in memory; no location history is stored.
 */
export function createDriverGpsRouter({ driverToken = process.env.GPS_DRIVER_TOKEN } = {}) {
  const router = Router();
  let shift = null;
  let latest = null;
  let lastAccepted = 0;
  const MAX_AGE_MS = 45_000;

  function authorized(req) {
    if (!driverToken || driverToken.length < 32) return false;
    const bearer = String(req.headers.authorization || "");
    if (!bearer.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(bearer.slice(7));
    const expected = Buffer.from(driverToken);
    return supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected);
  }
  function requireDriver(req, res, next) {
    if (!authorized(req)) return res.status(401).json({ ok:false, error:"Driver authorization required" });
    next();
  }

  router.post("/shift/start", requireDriver, (req, res) => {
    shift = { id: crypto.randomUUID(), startedAt: Date.now() };
    latest = null;
    lastAccepted = 0;
    res.json({ ok:true, shiftId:shift.id });
  });

  router.post("/shift/stop", requireDriver, (req, res) => {
    shift = null;
    latest = null;
    lastAccepted = 0;
    res.json({ ok:true, active:false });
  });

  router.get("/shift/status", requireDriver, (req, res) => {
    res.json({ ok:true, active:!!shift, startedAt:shift?.startedAt ?? null,
      locationFresh:!!latest && Date.now()-latest.receivedAt < MAX_AGE_MS });
  });

  router.post("/location", requireDriver, (req, res) => {
    if (!shift) return res.status(409).json({ ok:false, error:"Shift not active" });
    const { latitude, longitude, accuracy, heading, timestamp, shiftId } = req.body || {};
    if (shiftId !== shift.id) return res.status(409).json({ ok:false, error:"Shift mismatch" });
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude)>90 ||
        typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude)>180 ||
        typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy<0 || accuracy>5000 ||
        typeof timestamp !== "number" || !Number.isFinite(timestamp) ||
        Math.abs(Date.now()-timestamp)>120_000) {
      return res.status(400).json({ ok:false, error:"Invalid location sample" });
    }
    if (Date.now()-lastAccepted < 2000) return res.status(429).json({ ok:false, error:"Update too frequent" });
    if (latest && timestamp <= latest.timestamp) return res.status(409).json({ ok:false, error:"Out-of-order location" });
    const validHeading = typeof heading === "number" && Number.isFinite(heading) && heading>=0 && heading<360 ? heading : null;
    latest = { latitude, longitude, accuracy, heading:validHeading, timestamp, receivedAt:Date.now() };
    lastAccepted = Date.now();
    res.json({ ok:true });
  });

  // Mount behind existing requirePassenger middleware, never as a public route.
  router.get("/passenger/location", (req, res) => {
    const fresh = !!shift && !!latest && Date.now()-latest.receivedAt < MAX_AGE_MS;
    res.set("Cache-Control","no-store");
    if (!fresh) return res.json({ available:false, source:"iphone" });
    res.json({ available:true, source:"iphone", vehicle:{
      latitude:latest.latitude, longitude:latest.longitude, heading:latest.heading
    }, accuracy:latest.accuracy, timestamp:latest.timestamp });
  });
  return router;
}
