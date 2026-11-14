// server.js — RideShare (ESM, "type": "module")

// -------------------- Imports & Setup --------------------
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import rateLimit from "express-rate-limit";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -------------------- Config --------------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-please-change";
const ACCESS_TOKEN_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || "15m";
const REFRESH_TOKEN_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || "30d";
const DEV_ALLOW_UNKNOWN_CITIES = process.env.DEV_ALLOW_UNKNOWN_CITIES === "true";

// -------------------- Database (TLS forced) --------------------
const pool = new Pool({
  // Always ensure sslmode=require on Render/managed PG
  connectionString: (process.env.DATABASE_URL || "").includes("sslmode=")
    ? process.env.DATABASE_URL
    : `${process.env.DATABASE_URL}?sslmode=require`,
  ssl: { require: true, rejectUnauthorized: false },
});

// Ensure refresh_tokens exists (idempotent)
async function ensureRefreshTable() {
  const q = `
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token TEXT PRIMARY KEY,
      uid INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ
    );
  `;
  await pool.query(q);
}
ensureRefreshTable().catch((e) =>
  console.warn("refresh_tokens ensure error:", e?.message)
);

// Connection requests: u1 = requester, u2 = recipient.
// status 'pending' until the recipient accepts; existing rows default to 'accepted'.
async function ensureConnectionStatus() {
  await pool.query(`
    ALTER TABLE connections
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'accepted';
  `);
}
ensureConnectionStatus().catch((e) =>
  console.warn("connections.status ensure error:", e?.message)
);

// Driver / car details for each ride (all optional)
async function ensureDriverColumns() {
  await pool.query(`
    ALTER TABLE groups
      ADD COLUMN IF NOT EXISTS driver_name  TEXT,
      ADD COLUMN IF NOT EXISTS driver_phone TEXT,
      ADD COLUMN IF NOT EXISTS car_model    TEXT,
      ADD COLUMN IF NOT EXISTS car_number   TEXT;
  `);
}
ensureDriverColumns().catch((e) =>
  console.warn("groups driver columns ensure error:", e?.message)
);
const cleanText = (v, max = 64) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

// -------------------- Utilities --------------------
function ok(res, data = {}) {
  return res.status(200).json({ ok: true, ...data });
}
function respondError(res, code = 500, message = "internal server error") {
  return res.status(code).json({ ok: false, error: message });
}
function safeInt(v, defVal = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defVal;
}
function validatePreference(pref) {
  const p = String(pref || "").toUpperCase();
  return ["ALL", "FEMALE_ONLY"].includes(p);
}
function normalizeCityName(s) {
  if (!s) return null;
  return String(s).replace(/[^a-zA-Z.\-\s]/g, "").replace(/\s+/g, " ").trim();
}
function createAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES });
}
// NEW: check if a city string is exactly "Patiala" (case-insensitive)
function isPatialaCity(s) {
  return typeof s === "string" && s.trim().toLowerCase() === "patiala";
}

// -------------------- Auth helpers --------------------
// Expect Authorization: Bearer <token> with payload { uid, ... }
function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const [, token] = h.split(" ");
    if (!token) return respondError(res, 401, "auth required");
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.uid) return respondError(res, 401, "invalid token");
    req.user = { uid: payload.uid };
    next();
  } catch {
    return respondError(res, 401, "unauthorized");
  }
}
// Optional helper (non-strict) to read uid if available
function readUser(req) {
  try {
    const h = req.headers.authorization || "";
    const [, token] = h.split(" ");
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload?.uid ? { uid: payload.uid } : null;
  } catch {
    return null;
  }
}

// Basic rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { ok: false, error: "Too many requests, please try again later." },
});

// -------------------- City CSV Loader --------------------
let CITY_SET = new Set();
(function loadCityList() {
  try {
    const csvPath = path.join(__dirname, "cities", "cities_only.csv");
    const raw = fs.readFileSync(csvPath, "utf-8");
    const lines = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines[0] && /city/i.test(lines[0])) lines.shift(); // drop header if present
    lines.forEach((c) => CITY_SET.add(c.toLowerCase()));
    console.log("✅ Loaded cities:", CITY_SET.size);
  } catch (e) {
    console.warn("⚠️ City CSV not found. City validation disabled.", e.message);
  }
})();
function isValidCity(c) {
  if (!c) return false;
  if (CITY_SET.size === 0) return true; // fallback if CSV missing
  return CITY_SET.has(c.toLowerCase()) || DEV_ALLOW_UNKNOWN_CITIES;
}

// -------------------- Group Formatting (ROUTE + YEAR + MUTUALS) --------------------
async function formatGroupByRow(row, viewer_uid = null) {
  const gid = row.gid;

  // include year for each member
  const m = await pool.query(
    `SELECT gm.uid, u.name, u.gender, u.year
     FROM group_members gm
     LEFT JOIN users u ON u.uid = gm.uid
     WHERE gm.gid = $1
     ORDER BY gm.uid`,
    [gid]
  );
  const members = m.rows || [];
  const cnt = members.length;
  const seats_left = Math.max(0, (row.capacity || 0) - cnt);

  // Build route array directly from DB row (stops = "A|B|C")
  const route = [row.start, ...(row.stops ? row.stops.split("|") : []), row.dest].filter(Boolean);

  // Compute mutuals (LinkedIn-style) = shortest degree (max 3) via BFS over accepted connections
  //   1st = your connection, 2nd = connection of a connection, 3rd = connection of a 2nd
  let mutual_friends = [];
  if (viewer_uid && members.length) {
    const targetUids = members
      .map(mm => Number(mm.uid))
      .filter(u => u !== Number(viewer_uid));

    if (targetUids.length) {
      const q = `
        WITH RECURSIVE bfs(uid, depth, path) AS (
          -- start from viewer
          SELECT $1::int AS uid, 0 AS depth, ARRAY[$1::int] AS path
          UNION ALL
          -- expand to neighbors (undirected)
          SELECT
            CASE WHEN c.u1 = b.uid THEN c.u2 ELSE c.u1 END AS uid,
            b.depth + 1,
            b.path || CASE WHEN c.u1 = b.uid THEN c.u2 ELSE c.u1 END
          FROM bfs b
          JOIN connections c
            ON (c.u1 = b.uid OR c.u2 = b.uid) AND c.status = 'accepted'
          WHERE b.depth < 3
            AND NOT (CASE WHEN c.u1 = b.uid THEN c.u2 ELSE c.u1 END = ANY(b.path))
        )
        SELECT u.uid, u.name, MIN(b.depth) AS degree
        FROM bfs b
        JOIN users u ON u.uid = b.uid
        WHERE b.depth > 0
          AND b.uid = ANY($2::int[])
        GROUP BY u.uid, u.name
        ORDER BY degree ASC, u.name ASC;
      `;
      const res = await pool.query(q, [viewer_uid, targetUids]);

      // add LinkedIn-style labels
      mutual_friends = (res.rows || []).map(r => ({
        uid: r.uid,
        name: r.name,
        degree: Number(r.degree),
        degree_label: ["", "1st", "2nd", "3rd"][Number(r.degree)] || "3rd",
        degree_desc:
          Number(r.degree) === 1 ? "your connection" :
          Number(r.degree) === 2 ? "connection of your connection" :
                                   "3rd-degree connection",
      }));
    }
  }

  const mutual_count = mutual_friends.length;

  return {
    gid: row.gid,
    start: row.start,
    dest: row.dest,
    stops: row.stops ? row.stops.split("|") : [],
    route,                        // ← array for UI
    departure_date: row.departure_date,
    capacity: row.capacity,
    preference: row.preference,
    created_by: row.created_by,
    driver: {
      name: row.driver_name || null,
      phone: row.driver_phone || null,
      car_model: row.car_model || null,
      car_number: row.car_number || null,
    },
    members,                      // includes year
    seats_left,
    mutual_friends,               // degrees for viewer→members (with labels)
    mutual_count,                 // for "X mutual connections" badge
    is_member:
      viewer_uid != null &&
      members.some((mm) => Number(mm.uid) === Number(viewer_uid)),
  };
}

// Helper SQL to compute positions of start/dest in route (for search ordering)
const posSql = `
SELECT 
  array_position( 
    ARRAY[lower(g.start)] 
    || (CASE WHEN g.stops IS NULL OR g.stops='' THEN ARRAY[]::text[] ELSE regexp_split_to_array(lower(g.stops), '\\|') END)
    || ARRAY[lower(g.dest)], lower($2)
  ) AS pos_start,
  array_position( 
    ARRAY[lower(g.start)] 
    || (CASE WHEN g.stops IS NULL OR g.stops='' THEN ARRAY[]::text[] ELSE regexp_split_to_array(lower(g.stops), '\\|') END)
    || ARRAY[lower(g.dest)], lower($3)
  ) AS pos_dest
FROM groups g
WHERE g.gid = $1
`;

// -------------------- Routes --------------------

// Health
app.get("/", (_req, res) => ok(res, { message: "RideShare backend OK" }));

// --------- Cities (optional public endpoints) ---------
app.get("/cities", (_req, res) => {
  const list = Array.from(CITY_SET)
    .sort()
    .map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase()));
  return ok(res, { cities: list });
});
app.get("/cities/search", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return ok(res, { results: [] });
  const results = Array.from(CITY_SET)
    .filter((c) => c.includes(q))
    .slice(0, 20)
    .map((c) => c.replace(/\b\w/g, (m) => m.toUpperCase()));
  return ok(res, { results });
});

// --------- AUTH ---------
app.post("/register", authLimiter, async (req, res) => {
  try {
    const raw = req.body || {};
    const name = String(raw.name || "").trim();
    const rollNo = String(raw.rollNo || "").trim();
    const email = String(raw.email || "").trim().toLowerCase();
    const password = String(raw.password || "");
    const gender = raw.gender ? String(raw.gender).toUpperCase() : null;
    const year = safeInt(raw.year, null);
    const contact_number = raw.contact_number
      ? String(raw.contact_number).trim()
      : null;

    if (!name || !rollNo || !email || !password)
      return respondError(res, 400, "name, rollNo, email and password required");
    if (!/@thapar\.edu$/i.test(email))
      return respondError(res, 400, "please use your thapar.edu email");
    if (gender && !["M", "F"].includes(gender))
      return respondError(res, 400, "gender must be 'M' or 'F'");
    if (year !== null && (year < 1 || year > 6))
      return respondError(res, 400, "year must be between 1 and 6");
    if (password.length < 8)
      return respondError(res, 400, "password must be at least 8 characters");

    const hashed = await bcrypt.hash(password, 10);
    const q = `
      INSERT INTO users (roll_no, name, email, password, gender, year, contact_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING uid, roll_no, name, email, gender, year, contact_number
    `;
    const vals = [rollNo, name, email, hashed, gender, year, contact_number];
    const r = await pool.query(q, vals);

    const user = r.rows[0];
    const accessToken = createAccessToken({
      uid: user.uid,
      roll_no: user.roll_no,
    });
    const refreshToken = jwt.sign({ uid: user.uid }, JWT_SECRET, {
      expiresIn: REFRESH_TOKEN_EXPIRES,
    });
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    await pool.query(
      `INSERT INTO refresh_tokens (token, uid, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [refreshToken, user.uid, expiresAt]
    );

    return ok(res, { user, accessToken, refreshToken });
  } catch (err) {
    if (err && err.code === "23505")
      return respondError(res, 400, "roll_no or email already exists");
    console.error("register error:", err);
    return respondError(res, 500, "server error");
  }
});

app.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return respondError(res, 400, "email and password required");

    const emailNorm = String(email).toLowerCase();
    const r = await pool.query(
      `SELECT uid, roll_no, name, email, password, gender, year, contact_number
       FROM users WHERE email = $1 LIMIT 1`,
      [emailNorm]
    );
    if (r.rowCount === 0) return respondError(res, 401, "invalid credentials");

    const row = r.rows[0];
    const match = await bcrypt.compare(String(password), row.password);
    if (!match) return respondError(res, 401, "invalid credentials");

    const accessToken = createAccessToken({
      uid: row.uid,
      roll_no: row.roll_no,
    });
    const refreshToken = jwt.sign({ uid: row.uid }, JWT_SECRET, {
      expiresIn: REFRESH_TOKEN_EXPIRES,
    });
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await pool.query(
      `INSERT INTO refresh_tokens (token, uid, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [refreshToken, row.uid, expiresAt]
    );

    return ok(res, {
      user: {
        uid: row.uid,
        roll_no: row.roll_no,
        name: row.name,
        email: row.email,
        gender: row.gender,
        year: row.year,
        contact_number: row.contact_number,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error("login error:", err);
    return respondError(res, 500, "internal server error");
  }
});

app.post("/token/refresh", authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return respondError(res, 400, "refreshToken required");

    let payload;
    try {
      payload = jwt.verify(refreshToken, JWT_SECRET);
    } catch {
      return respondError(res, 401, "invalid refresh token");
    }

    const r = await pool.query(
      `SELECT token, uid, expires_at FROM refresh_tokens WHERE token = $1 LIMIT 1`,
      [refreshToken]
    );
    if (r.rowCount === 0)
      return respondError(res, 401, "refresh token not found");
    if (r.rows[0].expires_at && new Date(r.rows[0].expires_at) < new Date())
      return respondError(res, 401, "refresh token expired");

    const accessToken = createAccessToken({ uid: r.rows[0].uid });
    return ok(res, { accessToken });
  } catch (err) {
    console.error("refresh token error:", err);
    return respondError(res, 500, "internal server error");
  }
});

app.post("/logout", requireAuth, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return respondError(res, 400, "refreshToken required");
    await pool.query(`DELETE FROM refresh_tokens WHERE token = $1`, [
      refreshToken,
    ]);
    return ok(res, { msg: "logged out" });
  } catch (err) {
    console.error("logout error:", err);
    return respondError(res, 500, "server error");
  }
});

// -------------------- CONNECTIONS (request → accept) --------------------
// Send a connection request. If the other user already sent me one, this accepts it.
app.post("/connections", requireAuth, async (req, res) => {
  try {
    const uid = Number(req.user.uid);
    const other = parseInt(req.body?.other_uid, 10);
    if (!other || other === uid) return respondError(res, 400, "invalid other_uid");

    const u = await pool.query(`SELECT 1 FROM users WHERE uid=$1`, [other]);
    if (!u.rowCount) return respondError(res, 404, "user not found");

    const existing = await pool.query(
      `SELECT id, u1, u2, status FROM connections
       WHERE LEAST(u1,u2)=LEAST($1::int,$2::int) AND GREATEST(u1,u2)=GREATEST($1::int,$2::int)`,
      [uid, other]
    );
    const row = existing.rows[0];

    if (row) {
      if (row.status === "accepted") {
        return ok(res, { status: "accepted", message: "already connected" });
      }
      if (Number(row.u1) === uid) {
        return ok(res, { status: "pending", message: "request already sent" });
      }
      // They had already requested me → accept it
      await pool.query(`UPDATE connections SET status='accepted' WHERE id=$1`, [row.id]);
      return ok(res, { status: "accepted", message: "connection request accepted" });
    }

    await pool.query(
      `INSERT INTO connections (u1, u2, status) VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING`,
      [uid, other]
    );
    return ok(res, { status: "pending", message: "connection request sent" });
  } catch (e) {
    console.error("POST /connections error:", e);
    return respondError(res, 500, "server error");
  }
});

// Accept or decline a request that another user sent me
app.post("/connections/respond", requireAuth, async (req, res) => {
  try {
    const uid = Number(req.user.uid);
    const from = parseInt(req.body?.from_uid, 10);
    const action = String(req.body?.action || "").toLowerCase();
    if (!from || !["accept", "decline"].includes(action)) {
      return respondError(res, 400, "from_uid and action (accept|decline) required");
    }
    const r =
      action === "accept"
        ? await pool.query(
            `UPDATE connections SET status='accepted'
             WHERE u1=$1 AND u2=$2 AND status='pending' RETURNING id`,
            [from, uid]
          )
        : await pool.query(
            `DELETE FROM connections
             WHERE u1=$1 AND u2=$2 AND status='pending' RETURNING id`,
            [from, uid]
          );
    if (!r.rowCount) return respondError(res, 404, "no pending request from this user");
    return ok(res, {
      status: action === "accept" ? "accepted" : "declined",
      message: action === "accept" ? "connection request accepted" : "connection request declined",
    });
  } catch (e) {
    console.error("POST /connections/respond error:", e);
    return respondError(res, 500, "server error");
  }
});

// My accepted connections + pending requests (incoming / outgoing)
app.get("/connections/me", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const q = `
      SELECT u.uid, u.name, u.gender, u.year, c.status,
             CASE WHEN c.u1=$1 THEN 'outgoing' ELSE 'incoming' END AS direction
      FROM connections c
      JOIN users u ON u.uid = (CASE WHEN c.u1=$1 THEN c.u2 ELSE c.u1 END)
      WHERE c.u1=$1 OR c.u2=$1
      ORDER BY u.name ASC
    `;
    const rows = (await pool.query(q, [uid])).rows || [];
    const pick = ({ uid, name, gender, year }) => ({ uid, name, gender, year });
    return ok(res, {
      connections: rows.filter((r) => r.status === "accepted").map(pick),
      incoming: rows.filter((r) => r.status === "pending" && r.direction === "incoming").map(pick),
      outgoing: rows.filter((r) => r.status === "pending" && r.direction === "outgoing").map(pick),
    });
  } catch (e) {
    console.error("GET /connections/me error:", e);
    return respondError(res, 500, "server error");
  }
});

// NEW: very basic friends-of-friends suggestions
app.get("/connections/suggested", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const q = `
      WITH neighbors AS (
        SELECT CASE WHEN c.u1=$1 THEN c.u2 ELSE c.u1 END AS uid
        FROM connections c WHERE (c.u1=$1 OR c.u2=$1) AND c.status='accepted'
      ),
      fof AS (
        SELECT DISTINCT CASE WHEN c.u1=n.uid THEN c.u2 ELSE c.u1 END AS uid
        FROM connections c JOIN neighbors n ON (c.u1=n.uid OR c.u2=n.uid) AND c.status='accepted'
      )
      SELECT u.uid, u.name, u.year
      FROM fof JOIN users u ON u.uid=fof.uid
      WHERE u.uid<>$1
        AND u.uid NOT IN (SELECT uid FROM neighbors)
      LIMIT 20
    `;
    const r = await pool.query(q, [uid]);
    return ok(res, { suggested: r.rows || [] });
  } catch (e) {
    console.error("GET /connections/suggested error:", e);
    return respondError(res, 500, "server error");
  }
});

// --------- TRIPS / GROUPS ---------

// Create Trip (start OR destination must be "Patiala")
app.post("/create-trip", requireAuth, async (req, res) => {
  const creator_uid = req.user && req.user.uid;
  try {
    const raw = req.body || {};

    const startNorm = normalizeCityName(raw.start);
    const destNorm  = normalizeCityName(raw.dest);
    if (!creator_uid || !startNorm || !destNorm)
      return respondError(res, 400, "authenticated user, start and dest required");
    if (!isValidCity(startNorm))
      return respondError(res, 400, "Invalid start city");
    if (!isValidCity(destNorm))
      return respondError(res, 400, "Invalid destination city");

    // stops sanitize + validate + de-dup + exclude start/dest
    let stopsStr = null;
    const sLower = startNorm.toLowerCase(), dLower = destNorm.toLowerCase();
    const seen = new Set();
    const rawStops = Array.isArray(raw.stops)
      ? raw.stops
      : typeof raw.stops === "string"
      ? raw.stops.split(",")
      : [];
    const cleanedStops = rawStops
      .map(normalizeCityName)
      .filter((x) => x && isValidCity(x))
      .filter((x) => {
        const v = x.toLowerCase();
        if (v === sLower || v === dLower) return false;
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });
    if (cleanedStops.length) stopsStr = cleanedStops.join("|");

    // 🔴 RULE: start OR destination must be Patiala (stops don't count)
    const startIsPatiala = isPatialaCity(startNorm);
    const destIsPatiala  = isPatialaCity(destNorm);
    if (!(startIsPatiala || destIsPatiala)) {
      return respondError(res, 400, "either start or destination must be Patiala");
    }

    const capacity   = safeInt(raw.capacity, 4);
    const preference = raw.preference ? String(raw.preference).toUpperCase() : "ALL";
    const departure  = raw.departure || null;
    const auto_join_creator = raw.auto_join_creator === false ? false : true;
    const driver_name  = cleanText(raw.driver_name);
    const driver_phone = cleanText(raw.driver_phone, 20);
    const car_model    = cleanText(raw.car_model);
    const car_number   = cleanText(raw.car_number, 20)?.toUpperCase() || null;
    if (driver_phone && !/^\+?[0-9 \-]{7,20}$/.test(driver_phone))
      return respondError(res, 400, "invalid driver phone number");

    if (!validatePreference(preference))
      return respondError(res, 400, "invalid preference");

    // FEMALE_ONLY guard: only female users may create such groups
    if (preference === "FEMALE_ONLY") {
      const ug = await pool.query(`SELECT gender FROM users WHERE uid=$1`, [creator_uid]);
      const g  = (ug.rows?.[0]?.gender || "").toUpperCase();
      if (g !== "F") {
        return respondError(res, 403, "only female users can create FEMALE_ONLY groups");
      }
    }

    if (capacity <= 0 || capacity > 200)
      return respondError(res, 400, "capacity must be between 1 and 200");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const insertQ = `
        INSERT INTO groups (start, dest, stops, departure_date, capacity, preference, created_by,
                            driver_name, driver_phone, car_model, car_number)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`;
      const r = await client.query(insertQ, [
        startNorm, destNorm, stopsStr, departure, capacity, preference, creator_uid,
        driver_name, driver_phone, car_model, car_number,
      ]);
      const g = r.rows[0];

      if (auto_join_creator) {
        await client.query(
          `INSERT INTO group_members (gid, uid) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [g.gid, creator_uid]
        );
      }
      await client.query("COMMIT");

      const formatted = await formatGroupByRow(g, creator_uid);
      return ok(res, { gid: g.gid, group: formatted });
    } catch (tErr) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("create-trip tx error:", tErr);
      return respondError(res, 500, "could not create group");
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("create-trip outer error:", err);
    return respondError(res, 500, "internal server error");
  }
});

// Group Details (with LinkedIn-style mutuals)
app.get("/groups/:gid", requireAuth, async (req, res) => {
  try {
    const gid = safeInt(req.params.gid, null);
    if (!gid) return respondError(res, 400, "invalid gid");

    const r = await pool.query(`SELECT * FROM groups WHERE gid = $1 LIMIT 1`, [gid]);
    if (r.rowCount === 0) return respondError(res, 404, "group not found");

    const group = await formatGroupByRow(r.rows[0], req.user.uid);
    return ok(res, { group });
  } catch (e) {
    console.error("/groups/:gid error:", e);
    return respondError(res, 500, "internal server error");
  }
});

// Search Groups (FemaleOnly privacy + day / ±window)
app.post("/search-groups", async (req, res) => {
  try {
    const viewer = readUser(req);
    const viewer_uid = viewer?.uid || null;

    const {
      start: startTermRaw,
      dest: destTermRaw,
      preference,
      max_size,
      departure, // ISO string
      scope: scopeRaw, // "day" | ""
      time_window_mins,
    } = req.body || {};

    const startTerm = startTermRaw ? normalizeCityName(startTermRaw) : null;
    const destTerm = destTermRaw ? normalizeCityName(destTermRaw) : null;

    let desiredDeparture = null;
    if (departure) {
      const d = new Date(departure);
      if (!isNaN(d.getTime())) desiredDeparture = d;
    }

    const scope = String(scopeRaw || "").toLowerCase(); // "day" | ""
    const clientWin = parseInt(time_window_mins, 10);
    const WINDOW_MINS =
      Number.isFinite(clientWin) && clientWin > 0 ? clientWin : 60;

    // pull broad candidates first
    const pref = preference ? String(preference).toUpperCase() : null;
    let baseSql = `SELECT * FROM groups`;
    const where = [];
    const params = [];

    if (pref && validatePreference(pref)) {
      where.push(`preference = $${params.length + 1}`);
      params.push(pref);
    }
    if (safeInt(max_size, null)) {
      where.push(`capacity >= $${params.length + 1}`);
      params.push(safeInt(max_size, 1));
    }
    if (where.length) baseSql += ` WHERE ` + where.join(" AND ");
    baseSql += ` ORDER BY departure_date NULLS LAST, gid DESC LIMIT 500`;

    const gRes = await pool.query(baseSql, params);
    let candidates = gRes.rows || [];

    // FemaleOnly: hide for male viewers
    let viewerGender = null;
    if (viewer_uid) {
      const ug = await pool.query(`SELECT gender FROM users WHERE uid=$1`, [
        viewer_uid,
      ]);
      viewerGender = (ug.rows[0]?.gender || "").toUpperCase();
    }
    if (viewerGender === "M") {
      candidates = candidates.filter(
        (g) => String(g.preference).toUpperCase() !== "FEMALE_ONLY"
      );
    }

    // route/time filter
    const filtered = [];
    const windowMs = WINDOW_MINS * 60 * 1000;

    for (const g of candidates) {
      // route order: ensure start before dest when both provided
      if (startTerm || destTerm) {
        const pos = await pool.query(posSql, [
          g.gid,
          startTerm || "",
          destTerm || "",
        ]);
        const r = pos.rows?.[0] || {};
        const posStart = r.pos_start;
        const posDest = r.pos_dest;

        let okMatch = false;
        if (startTerm && destTerm)
          okMatch = posStart !== null && posDest !== null && posStart < posDest;
        else if (startTerm) okMatch = posStart !== null;
        else if (destTerm) okMatch = posDest !== null;
        if (!okMatch) continue;
      }

      // time logic
      if (desiredDeparture) {
        if (!g.departure_date) continue;
        const depMs = new Date(g.departure_date).getTime();

        if (scope === "day") {
          const d0 = new Date(desiredDeparture);
          const dayStart = new Date(
            d0.getFullYear(),
            d0.getMonth(),
            d0.getDate()
          ).getTime();
          const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;
          if (depMs < dayStart || depMs > dayEnd) continue;
        } else {
          const want = desiredDeparture.getTime();
          if (depMs < want - windowMs || depMs > want + windowMs) continue;
        }
      }

      filtered.push(g);
    }

    const formatted = await Promise.all(
      filtered.map((g) => formatGroupByRow(g, viewer_uid))
    );
    return ok(res, { groups: formatted });
  } catch (e) {
    console.error("/search-groups error:", e);
    return respondError(res, 500, "internal server error");
  }
});

// Join Group (block creator; FemaleOnly blocks M; capacity check)
app.post("/join-group", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const gidInt = safeInt(req.body?.gid, null);
  if (!gidInt) return respondError(res, 400, "invalid gid");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const gq = await client.query(
      `SELECT gid, capacity, preference, created_by 
       FROM groups 
       WHERE gid = $1 FOR UPDATE`,
      [gidInt]
    );
    if (gq.rowCount === 0) {
      await client.query("ROLLBACK");
      return respondError(res, 404, "group not found");
    }

    // creator cannot join own group
    if (Number(gq.rows[0].created_by) === Number(uid)) {
      await client.query("ROLLBACK");
      return respondError(res, 400, "creator cannot join own group");
    }

    // FemaleOnly: block Male from joining
    const pref = String(gq.rows[0].preference || "ALL").toUpperCase();
    if (pref === "FEMALE_ONLY") {
      const ug = await client.query(`SELECT gender FROM users WHERE uid=$1`, [
        uid,
      ]);
      if ((ug.rows[0]?.gender || "").toUpperCase() === "M") {
        await client.query("ROLLBACK");
        return respondError(res, 403, "female-only group");
      }
    }

    // capacity check
    const membersRes = await client.query(
      `SELECT COUNT(*)::int AS cnt FROM group_members WHERE gid = $1`,
      [gidInt]
    );
    const cnt = membersRes.rows[0]?.cnt || 0;
    if (cnt >= gq.rows[0].capacity) {
      await client.query("ROLLBACK");
      return respondError(res, 400, "group full");
    }

    // already a member?
    const already = await client.query(
      `SELECT 1 FROM group_members WHERE gid=$1 AND uid=$2 LIMIT 1`,
      [gidInt, uid]
    );
    if (already.rowCount > 0) {
      await client.query("ROLLBACK");
      return respondError(res, 400, "already a member");
    }

    await client.query(
      `INSERT INTO group_members (gid, uid) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [gidInt, uid]
    );

    await client.query("COMMIT");

    const g2 = await pool.query(`SELECT * FROM groups WHERE gid=$1`, [gidInt]);
    const formatted = await formatGroupByRow(g2.rows[0], uid);
    return ok(res, { group: formatted });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("join-group error:", err);
    return respondError(res, 500, "server error");
  } finally {
    client.release();
  }
});

// NEW: Leave Group (member can leave; creator cannot)
app.post("/leave-group", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const gid = safeInt(req.body?.gid, null);
  if (!gid) return respondError(res, 400, "invalid gid");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // verify group + creator
    const gq = await client.query(
      `SELECT gid, created_by FROM groups WHERE gid=$1 FOR UPDATE`,
      [gid]
    );
    if (gq.rowCount === 0) {
      await client.query("ROLLBACK");
      return respondError(res, 404, "group not found");
    }
    if (Number(gq.rows[0].created_by) === Number(uid)) {
      await client.query("ROLLBACK");
      return respondError(res, 400, "creator must delete group");
    }

    // if not a member, idempotent success
    const isMem = await client.query(
      `SELECT 1 FROM group_members WHERE gid=$1 AND uid=$2 LIMIT 1`,
      [gid, uid]
    );
    if (isMem.rowCount === 0) {
      await client.query("ROLLBACK");
      return ok(res, { left: true });
    }

    await client.query(`DELETE FROM group_members WHERE gid=$1 AND uid=$2`, [
      gid,
      uid,
    ]);

    await client.query("COMMIT");

    // latest formatted group (optional for UI)
    const g2 = await pool.query(`SELECT * FROM groups WHERE gid=$1`, [gid]);
    if (g2.rowCount) {
      const formatted = await formatGroupByRow(g2.rows[0], uid);
      return ok(res, { left: true, group: formatted });
    }
    return ok(res, { left: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("leave-group error:", e);
    return respondError(res, 500, "server error");
  } finally {
    client.release();
  }
});

// DELETE GROUP (creator-only)
app.delete("/groups/:gid", requireAuth, async (req, res) => {
  const uid = req.user.uid;
  const gid = safeInt(req.params.gid, null);
  if (!gid) return respondError(res, 400, "invalid gid");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const gq = await client.query(
      `SELECT gid, created_by FROM groups WHERE gid=$1 FOR UPDATE`,
      [gid]
    );
    if (gq.rowCount === 0) {
      await client.query("ROLLBACK");
      return respondError(res, 404, "group not found");
    }
    if (Number(gq.rows[0].created_by) !== Number(uid)) {
      await client.query("ROLLBACK");
      return respondError(res, 403, "only creator can delete");
    }

    await client.query(`DELETE FROM group_members WHERE gid=$1`, [gid]);
    await client.query(`DELETE FROM groups WHERE gid=$1`, [gid]);

    await client.query("COMMIT");
    return ok(res, { deleted: true });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    console.error("DELETE /groups/:gid error:", e);
    return respondError(res, 500, "server error");
  } finally {
    client.release();
  }
});

// My rides (created/joined; upcoming/past)
app.get("/my-rides", requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // created groups
    const createdRes = await pool.query(
      `SELECT * FROM groups WHERE created_by=$1 ORDER BY departure_date NULLS LAST, gid DESC`,
      [uid]
    );
    const created = await Promise.all(
      createdRes.rows.map((g) => formatGroupByRow(g, uid))
    );

    // joined groups
    const joinedGidsRes = await pool.query(
      `SELECT gid FROM group_members WHERE uid=$1 ORDER BY gid DESC`,
      [uid]
    );
    const joinedGids = joinedGidsRes.rows.map((r) => r.gid);
    let joined = [];
    if (joinedGids.length) {
      const jRes = await pool.query(
        `SELECT * FROM groups WHERE gid = ANY($1::int[]) ORDER BY departure_date NULLS LAST, gid DESC`,
        [joinedGids]
      );
      joined = await Promise.all(jRes.rows.map((g) => formatGroupByRow(g, uid)));
    }

    const now = Date.now();
    function split(arr) {
      const out = { upcoming: [], past: [] };
      for (const g of arr) {
        const t = g.departure_date ? new Date(g.departure_date).getTime() : null;
        if (t && t >= now) out.upcoming.push(g);
        else out.past.push(g);
      }
      return out;
    }

    return ok(res, {
      created: split(created),
      joined: split(joined),
    });
  } catch (e) {
    console.error("/my-rides error:", e);
    return respondError(res, 500, "internal server error");
  }
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`✅ RideShare backend listening on http://localhost:${PORT}`);
});
