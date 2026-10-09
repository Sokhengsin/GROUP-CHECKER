import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const STANDARD_DAYS = positiveNumber(process.env.STANDARD_PAYOUT_WAIT_DAYS, 14);
const VERIFIED_DAYS = positiveNumber(process.env.VERIFIED_GROUP_PAYOUT_WAIT_DAYS, 3);

const ROBLOX_TIMEOUT_MS = 8000;
const USER_CACHE_MS = 5 * 60_000;
const GROUP_CACHE_MS = 5 * 60_000;
const MEMBERSHIP_CACHE_MS = 30_000;
const OPEN_CLOUD_CACHE_MS = 60_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

const DISCLAIMER =
  "This checker only verifies membership information and estimates the configured " +
  "membership-age requirement when Roblox provides a trustworthy join timestamp. " +
  "Roblox may apply additional payout restrictions.";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Railway (and most PaaS hosts) sit behind a single reverse proxy.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------------------------------------- errors */

class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.public = true;
  }
}

/* ----------------------------------------------------------------- cache */

const cache = new Map();
const CACHE_MAX_ENTRIES = 5000;

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return undefined;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return undefined;
  }
  return item.value;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest entry (Map keeps insertion order).
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

/* ------------------------------------------------------------ rate limit */

const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  let entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
    hits.set(ip, entry);
  }
  entry.count += 1;

  res.setHeader("RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - entry.count)));

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((entry.reset - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({
      ok: false,
      error: `Too many checks. Please wait ${retryAfter} seconds and try again.`
    });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (now > entry.reset) hits.delete(ip);
  for (const [key, item] of cache) if (now > item.expires) cache.delete(key);
}, 60_000).unref();

/* --------------------------------------------------------------- parsing */

function cleanUsername(value) {
  const s = String(value ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,20}$/.test(s)) {
    throw new PublicError("Enter a valid Roblox username (3–20 letters, numbers or underscores).");
  }
  return s;
}

const ALLOWED_HOSTS = new Set(["roblox.com", "www.roblox.com"]);

function parseCommunityLink(value) {
  let raw = String(value ?? "").trim();
  const invalid = new PublicError(
    "Enter a valid Roblox community link, e.g. https://www.roblox.com/communities/12345678/name"
  );

  if (!raw || raw.length > 300) throw invalid;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid;
  if (url.username || url.password || url.port) throw invalid;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new PublicError("Only links from roblox.com or www.roblox.com are accepted.");
  }

  const match = url.pathname.match(/^\/(?:communities|groups)\/(\d{1,15})(?:\/|$)/i);
  if (!match) throw invalid;

  const id = match[1].replace(/^0+/, "");
  if (!id) throw invalid;
  return id;
}

/* ---------------------------------------------------------- roblox calls */

async function robloxFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(ROBLOX_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const err = new Error(timedOut ? `Timeout calling ${url}` : `Network error calling ${url}`);
    err.status = 504;
    throw err;
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

function upstreamError(what, status) {
  if (status === 429) {
    return new PublicError("Roblox is rate limiting requests right now. Please try again shortly.", 503);
  }
  const err = new Error(`${what} failed with HTTP ${status}`);
  err.status = 502;
  return err;
}

async function resolveUsername(username) {
  const key = `user:${username.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) {
    if (cached === null) throw new PublicError("Roblox user not found.", 422);
    return cached;
  }

  const res = await robloxFetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
  });
  if (!res.ok || !res.body) throw upstreamError("Username lookup", res.status);

  const user = res.body?.data?.[0];
  if (!user?.id) {
    cacheSet(key, null, 60_000);
    throw new PublicError("Roblox user not found.", 422);
  }

  const result = {
    id: String(user.id),
    name: String(user.name ?? username),
    displayName: user.displayName ? String(user.displayName) : null
  };
  cacheSet(key, result, USER_CACHE_MS);
  return result;
}

async function getCommunity(groupId) {
  const key = `group:${groupId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) {
    if (cached === null) throw new PublicError("Roblox community not found.", 422);
    return cached;
  }

  const res = await robloxFetch(`https://groups.roblox.com/v1/groups/${groupId}`);
  if (res.status === 400 || res.status === 404) {
    cacheSet(key, null, 60_000);
    throw new PublicError("Roblox community not found.", 422);
  }
  if (!res.ok || !res.body) throw upstreamError("Community lookup", res.status);

  const g = res.body;
  const result = {
    id: String(g.id ?? groupId),
    name: String(g.name ?? `Community ${groupId}`),
    verified: typeof g.hasVerifiedBadge === "boolean" ? g.hasVerifiedBadge : null,
    memberCount: Number.isFinite(g.memberCount) ? g.memberCount : null
  };
  cacheSet(key, result, GROUP_CACHE_MS);
  return result;
}

async function getUserMemberships(userId) {
  const key = `memberships:${userId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const res = await robloxFetch(`https://groups.roblox.com/v2/users/${userId}/groups/roles`);
  if (!res.ok || !Array.isArray(res.body?.data)) throw upstreamError("Membership lookup", res.status);

  const result = res.body.data
    .filter((entry) => entry?.group?.id != null)
    .map((entry) => ({
      groupId: String(entry.group.id),
      groupName: entry.group.name ?? null,
      verified: typeof entry.group.hasVerifiedBadge === "boolean" ? entry.group.hasVerifiedBadge : null,
      roleName: entry.role?.name ?? null,
      rank: Number.isFinite(entry.role?.rank) ? entry.role.rank : null
    }));
  cacheSet(key, result, MEMBERSHIP_CACHE_MS);
  return result;
}

/**
 * Optional: ask Roblox Open Cloud for the membership createTime.
 * Only works when ROBLOX_API_KEY is set AND the key has access to this group.
 * Any failure returns null so the basic membership result is used instead.
 */
async function getOpenCloudJoinTime(groupId, userId) {
  const apiKey = process.env.ROBLOX_API_KEY?.trim();
  if (!apiKey) return null;

  const key = `oc:${groupId}:${userId}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  let joinedAt = null;
  try {
    const filter = encodeURIComponent(`user == 'users/${userId}'`);
    const res = await robloxFetch(
      `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships?maxPageSize=10&filter=${filter}`,
      { headers: { "x-api-key": apiKey } }
    );
    if (res.ok) {
      const membership = (res.body?.groupMemberships ?? []).find(
        (m) => m?.user === `users/${userId}`
      );
      const date = membership?.createTime ? new Date(membership.createTime) : null;
      if (date && !Number.isNaN(date.getTime()) && date.getTime() <= Date.now()) {
        joinedAt = date;
      }
    }
  } catch {
    joinedAt = null;
  }

  cacheSet(key, joinedAt, OPEN_CLOUD_CACHE_MS);
  return joinedAt;
}

/* ---------------------------------------------------------------- routes */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "henggoliver-community-checker", time: new Date().toISOString() });
});

app.post("/api/check", rateLimit, async (req, res) => {
  try {
    const username = cleanUsername(req.body?.username);
    const groupId = parseCommunityLink(req.body?.communityLink);

    const [user, community] = await Promise.all([resolveUsername(username), getCommunity(groupId)]);
    const memberships = await getUserMemberships(user.id);
    const membership = memberships.find((m) => m.groupId === groupId) ?? null;

    const verified = community.verified ?? membership?.verified ?? null;
    const communityOut = { id: groupId, name: community.name, verified };

    if (!membership) {
      return res.json({
        ok: true,
        member: false,
        user,
        community: communityOut,
        message: "This account is not currently a member of this community.",
        disclaimer: DISCLAIMER
      });
    }

    const memberOut = { role: membership.roleName, rank: membership.rank };
    const joinedAt = await getOpenCloudJoinTime(groupId, user.id);

    if (!joinedAt) {
      return res.json({
        ok: true,
        member: true,
        user,
        community: communityOut,
        membership: { ...memberOut, joinTimeAvailable: false },
        message:
          "Member confirmed. Exact join date is unavailable, so membership-age eligibility cannot currently be calculated.",
        disclaimer: DISCLAIMER
      });
    }

    const now = Date.now();
    const waitDays = verified ? VERIFIED_DAYS : STANDARD_DAYS;
    const eligibleAt = new Date(joinedAt.getTime() + waitDays * DAY_MS);
    const remainingMs = Math.max(0, eligibleAt.getTime() - now);
    const remainingHoursTotal = Math.ceil(remainingMs / 3_600_000);
    const requirementMet = remainingMs === 0;

    res.json({
      ok: true,
      member: true,
      user,
      community: communityOut,
      membership: {
        ...memberOut,
        joinTimeAvailable: true,
        joinedAt: joinedAt.toISOString(),
        waitDays,
        waitPeriodType: verified ? "verified" : "standard",
        eligibleAt: eligibleAt.toISOString(),
        remaining: {
          days: Math.floor(remainingHoursTotal / 24),
          hours: remainingHoursTotal % 24,
          totalHours: remainingHoursTotal
        },
        requirementMet
      },
      message: requirementMet ? "Membership Requirement Met" : "Not Eligible Yet",
      disclaimer: DISCLAIMER
    });
  } catch (error) {
    if (error?.public) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error("Community check error:", error?.message || error);
    res.status(error?.status >= 500 ? error.status : 502).json({
      ok: false,
      error: "Checker service is unavailable. Please try again."
    });
  }
});

// Any other /api route returns JSON, never the HTML 404 page.
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "Not found." });
});

// JSON errors for malformed bodies and anything unexpected (never HTML or stack traces).
app.use((err, req, res, _next) => {
  const isBodyError = err?.type === "entity.parse.failed" || err?.type === "entity.too.large";
  if (!isBodyError) console.error("Unhandled error:", err?.message || err);
  if (res.headersSent) return;
  const status = isBodyError ? 400 : 500;
  if (req.path.startsWith("/api")) {
    return res.status(status).json({
      ok: false,
      error: isBodyError ? "Invalid request." : "Checker service is unavailable. Please try again."
    });
  }
  res.status(status).type("text/plain").send(isBodyError ? "Bad request" : "Server error");
});

app.listen(PORT, () => {
  console.log(`HENGGOLIVER community checker running on port ${PORT}`);
  console.log(
    process.env.ROBLOX_API_KEY?.trim()
      ? "Optional Open Cloud join-date lookup: enabled"
      : "Optional Open Cloud join-date lookup: disabled (basic membership checks only)"
  );
});
