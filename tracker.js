import express from "express";
import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";

/*
 * Robux Transfer Limit tracker.
 *
 * Roblox does not expose an account's Robux Transfer tier or remaining quota through
 * Open Cloud, so nothing here is Roblox-confirmed. Limits come from the tier configured
 * per sending account, and usage is summed from the transfers recorded in our own file.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_24H_MS = DAY_MS;
const WINDOW_30D_MS = 30 * DAY_MS;

export const TIER_PRESETS = {
  standard: { daily: 500, monthly: 1000 },
  higher: { daily: 5000, monthly: 10000 }
};
const TIERS = ["auto", "standard", "higher", "custom"];
const STATUSES = ["completed", "pending", "failed", "cancelled"];
// Only successful sends count toward the rolling windows.
const COUNTED_STATUS = "completed";

const MAX_AMOUNT = 1_000_000;
const MAX_LIMIT = 10_000_000;
const MAX_TEXT = 500;
const FUTURE_SKEW_MS = 5 * 60_000;

const ROBLOX_REPORTED_LIMIT = {
  available: false,
  reason: "Roblox does not expose the account's Robux Transfer quota through the supported Open Cloud API."
};

const AUTH_FAIL_WINDOW_MS = 15 * 60_000;
const AUTH_FAIL_MAX = 10;
const TRACKER_RATE_WINDOW_MS = 60_000;
const TRACKER_RATE_MAX = 120;

/* ----------------------------------------------------------------- store */

function emptyData() {
  return { senders: [], transfers: [], settings: {} };
}

function createStore(file) {
  let data = null;
  let chain = Promise.resolve();

  async function persist() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }

  async function load() {
    if (data) return data;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      data = {
        senders: Array.isArray(parsed?.senders) ? parsed.senders : [],
        transfers: Array.isArray(parsed?.transfers) ? parsed.transfers : [],
        settings: parsed?.settings && typeof parsed.settings === "object" ? parsed.settings : {}
      };
    } catch (error) {
      // Never overwrite a file we failed to parse; only create it when it is missing.
      if (error?.code !== "ENOENT") throw error;
      data = emptyData();
      await persist();
    }
    return data;
  }

  // Writes run one at a time. Callers validate before mutating, so a thrown error leaves data intact.
  function update(fn) {
    const run = chain.then(async () => {
      const d = await load();
      const result = await fn(d);
      await persist();
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  return { read: load, update };
}

/* ---------------------------------------------------------------- errors */

class TrackerError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
    this.public = true;
  }
}

/* ------------------------------------------------------------ validation */

function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s.length > max) throw new TrackerError(`${field} must be ${max} characters or fewer.`);
  return s || null;
}

function requiredText(value, field, max = 60) {
  const s = optionalText(value, field, max);
  if (!s) throw new TrackerError(`${field} is required.`);
  return s;
}

function wholeNumber(value, field, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TrackerError(`${field} must be a whole number between 1 and ${max.toLocaleString("en-US")}.`);
  }
  return n;
}

function oneOf(value, allowed, field) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!allowed.includes(s)) throw new TrackerError(`${field} must be one of: ${allowed.join(", ")}.`);
  return s;
}

function optionalDiscordId(value) {
  const s = optionalText(value, "Discord ID", 40);
  if (s && !/^\d{15,22}$/.test(s)) throw new TrackerError("Discord ID must be a numeric Discord user ID.");
  return s;
}

function sentAtFrom(value) {
  if (value === undefined || value === null || value === "") return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new TrackerError("Date/time is not valid.");
  if (d.getTime() > Date.now() + FUTURE_SKEW_MS) throw new TrackerError("Date/time cannot be in the future.");
  return d;
}

/* -------------------------------------------------------------- limits */

function configuredLimits(sender, settings) {
  if (sender.tier === "custom") {
    return { tier: "custom", daily: sender.dailyLimit, monthly: sender.monthlyLimit, assumedFromAuto: false };
  }
  if (sender.tier === "standard" || sender.tier === "higher") {
    return { tier: sender.tier, ...TIER_PRESETS[sender.tier], assumedFromAuto: false };
  }
  // AUTO: Roblox does not report the tier, so fall back to the configured default.
  const fallback = settings.autoFallbackTier === "higher" ? "higher" : "standard";
  return { tier: fallback, ...TIER_PRESETS[fallback], assumedFromAuto: true };
}

function timeMs(transfer) {
  return new Date(transfer.sentAt).getTime();
}

/** Rolling window: everything sent in (now - windowMs, now]. No midnight or month resets. */
export function windowUsage(transfers, now, windowMs, limit) {
  const start = now - windowMs;
  const inWindow = transfers
    .filter((t) => t.status === COUNTED_STATUS)
    .map((t) => ({ amount: t.amount, at: timeMs(t) }))
    .filter((t) => t.at > start && t.at <= now)
    .sort((a, b) => a.at - b.at);

  const used = inWindow.reduce((sum, t) => sum + t.amount, 0);

  // Sends with the same timestamp leave the window together.
  let nextRelease = null;
  if (inWindow.length) {
    const firstAt = inWindow[0].at;
    const amount = inWindow.filter((t) => t.at === firstAt).reduce((sum, t) => sum + t.amount, 0);
    nextRelease = { amount, at: new Date(firstAt + windowMs).toISOString() };
  }

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    overBy: Math.max(0, used - limit),
    transfers: inWindow.length,
    nextRelease,
    fullyClearAt: inWindow.length ? new Date(inWindow[inWindow.length - 1].at + windowMs).toISOString() : null
  };
}

function senderSummary(sender, transfers, settings, now) {
  const limits = configuredLimits(sender, settings);
  const own = transfers.filter((t) => t.sender?.userId === sender.userId);
  return {
    ...publicSender(sender, settings),
    source: "configured",
    robloxConfirmed: false,
    last24h: windowUsage(own, now, WINDOW_24H_MS, limits.daily),
    last30d: windowUsage(own, now, WINDOW_30D_MS, limits.monthly)
  };
}

function publicSender(sender, settings) {
  const limits = configuredLimits(sender, settings);
  return {
    ...sender,
    effectiveTier: limits.tier,
    assumedFromAuto: limits.assumedFromAuto,
    dailyLimit: limits.daily,
    monthlyLimit: limits.monthly
  };
}

/* -------------------------------------------------------------- roblox */

async function fetchHeadshots(userIds) {
  const ids = [...new Set(userIds.map(String))].filter((id) => /^\d+$/.test(id));
  const result = new Map();
  if (!ids.length) return result;
  try {
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(",")}&size=150x150&format=Png&isCircular=false`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return result;
    const body = await res.json();
    for (const item of body?.data ?? []) {
      if (item?.state !== "Completed" || typeof item.imageUrl !== "string") continue;
      try {
        // Only keep images served from Roblox's CDN.
        const url = new URL(item.imageUrl);
        if (url.protocol === "https:" && url.hostname.endsWith(".rbxcdn.com")) {
          result.set(String(item.targetId), url.toString());
        }
      } catch {
        /* ignore malformed URLs */
      }
    }
  } catch {
    /* avatars are optional */
  }
  return result;
}

/* ---------------------------------------------------------------- auth */

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function createAdminAuth() {
  const failures = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of failures) if (now > entry.reset) failures.delete(ip);
  }, 60_000).unref();

  return function requireAdmin(req, res, next) {
    const configured = process.env.ADMIN_TOKEN?.trim();
    if (!configured) {
      return res.status(503).json({ ok: false, error: "Tracker is disabled: ADMIN_TOKEN is not configured on the server." });
    }

    const ip = req.ip || "unknown";
    const now = Date.now();
    const entry = failures.get(ip);
    if (entry && now <= entry.reset && entry.count >= AUTH_FAIL_MAX) {
      res.setHeader("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ ok: false, error: "Too many failed admin attempts. Try again later." });
    }

    const header = String(req.get("authorization") || "");
    const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (supplied && crypto.timingSafeEqual(hashToken(supplied), hashToken(configured))) {
      failures.delete(ip);
      return next();
    }

    const fresh = !entry || now > entry.reset ? { count: 0, reset: now + AUTH_FAIL_WINDOW_MS } : entry;
    fresh.count += 1;
    failures.set(ip, fresh);
    res.status(401).json({ ok: false, error: "Admin token is missing or incorrect." });
  };
}

function createTrackerRateLimit() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (now > entry.reset) hits.delete(ip);
  }, 60_000).unref();

  return function trackerRateLimit(req, res, next) {
    const ip = req.ip || "unknown";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now > entry.reset) {
      entry = { count: 0, reset: now + TRACKER_RATE_WINDOW_MS };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > TRACKER_RATE_MAX) {
      return res.status(429).json({ ok: false, error: "Too many requests. Please slow down." });
    }
    next();
  };
}

/* -------------------------------------------------------------- router */

/**
 * @param {object} deps
 * @param {(username: string) => Promise<{id: string, name: string, displayName: string|null}>} deps.resolveUsername
 * @param {(value: unknown) => string} deps.cleanUsername
 * @param {string} deps.dataFile
 */
export function createTrackerRouter({ resolveUsername, cleanUsername, dataFile }) {
  const store = createStore(dataFile);
  const router = express.Router();

  router.use(createTrackerRateLimit());
  // Every tracker route needs the admin token: history holds order IDs, Discord IDs and staff notes.
  router.use(createAdminAuth());

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  async function lookupRobloxUser(value, field) {
    let username;
    try {
      username = cleanUsername(value);
    } catch {
      throw new TrackerError(`${field}: enter a valid Roblox username.`);
    }
    try {
      return await resolveUsername(username);
    } catch (error) {
      if (error?.public) throw new TrackerError(`${field}: ${error.message}`, error.status === 422 ? 422 : 503);
      throw new TrackerError(`${field}: could not reach Roblox to look up this user. Try again.`, 503);
    }
  }

  /* ----- Roblox reported limit (always unavailable; never faked) */

  router.get("/roblox-limit", (_req, res) => {
    res.json({ ok: true, ...ROBLOX_REPORTED_LIMIT });
  });

  /* ----- summary */

  router.get(
    "/summary",
    wrap(async (_req, res) => {
      const data = await store.read();
      const now = Date.now();
      res.json({
        ok: true,
        now: new Date(now).toISOString(),
        robloxReportedLimit: ROBLOX_REPORTED_LIMIT,
        settings: { autoFallbackTier: data.settings.autoFallbackTier === "higher" ? "higher" : "standard" },
        tierPresets: TIER_PRESETS,
        senders: data.senders.map((s) => senderSummary(s, data.transfers, data.settings, now))
      });
    })
  );

  /* ----- settings */

  router.put(
    "/settings",
    wrap(async (req, res) => {
      const autoFallbackTier = oneOf(req.body?.autoFallbackTier, ["standard", "higher"], "Auto fallback tier");
      const settings = await store.update((d) => {
        d.settings.autoFallbackTier = autoFallbackTier;
        return { ...d.settings };
      });
      res.json({ ok: true, settings });
    })
  );

  /* ----- senders */

  function senderFields(body, existing) {
    const tier = body.tier !== undefined ? oneOf(body.tier, TIERS, "Tier") : existing?.tier ?? "auto";
    const out = { tier };
    if (body.label !== undefined || !existing) out.label = requiredText(body.label, "Label", 40);
    if (body.active !== undefined) out.active = Boolean(body.active);
    if (tier === "custom") {
      out.dailyLimit = wholeNumber(body.dailyLimit ?? existing?.dailyLimit, "Daily limit", MAX_LIMIT);
      out.monthlyLimit = wholeNumber(body.monthlyLimit ?? existing?.monthlyLimit, "30-day limit", MAX_LIMIT);
    } else {
      out.dailyLimit = null;
      out.monthlyLimit = null;
    }
    return out;
  }

  router.get(
    "/senders",
    wrap(async (_req, res) => {
      const data = await store.read();
      res.json({ ok: true, senders: data.senders.map((s) => publicSender(s, data.settings)) });
    })
  );

  router.post(
    "/senders",
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const fields = senderFields(body, null);
      const user = await lookupRobloxUser(body.username, "Sender");
      const avatars = await fetchHeadshots([user.id]);

      const sender = await store.update((d) => {
        if (d.senders.some((s) => s.userId === user.id)) {
          throw new TrackerError(`${user.name} is already a sending account.`, 409);
        }
        const nowIso = new Date().toISOString();
        const created = {
          userId: user.id,
          username: user.name,
          displayName: user.displayName,
          avatarUrl: avatars.get(user.id) ?? null,
          active: body.active === undefined ? true : Boolean(body.active),
          ...fields,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        d.senders.push(created);
        return publicSender(created, d.settings);
      });
      res.status(201).json({ ok: true, sender });
    })
  );

  router.patch(
    "/senders/:userId",
    wrap(async (req, res) => {
      const userId = String(req.params.userId);
      const sender = await store.update((d) => {
        const existing = d.senders.find((s) => s.userId === userId);
        if (!existing) throw new TrackerError("Sending account not found.", 404);
        const fields = senderFields(req.body ?? {}, existing);
        Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
        return publicSender(existing, d.settings);
      });
      res.json({ ok: true, sender });
    })
  );

  router.delete(
    "/senders/:userId",
    wrap(async (req, res) => {
      const userId = String(req.params.userId);
      await store.update((d) => {
        const index = d.senders.findIndex((s) => s.userId === userId);
        if (index === -1) throw new TrackerError("Sending account not found.", 404);
        if (d.transfers.some((t) => t.sender?.userId === userId)) {
          throw new TrackerError("This account has recorded sends. Disable it instead of deleting it.", 409);
        }
        d.senders.splice(index, 1);
      });
      res.json({ ok: true });
    })
  );

  /* ----- transfers */

  router.get(
    "/transfers",
    wrap(async (req, res) => {
      const data = await store.read();
      const senderId = req.query.sender ? String(req.query.sender) : null;
      const status = req.query.status ? String(req.query.status) : null;
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const transfers = data.transfers
        .filter((t) => (!senderId || t.sender?.userId === senderId) && (!status || t.status === status))
        .sort((a, b) => timeMs(b) - timeMs(a))
        .slice(0, limit);
      res.json({ ok: true, total: data.transfers.length, transfers });
    })
  );

  router.post(
    "/transfers",
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const amount = wholeNumber(body.amount, "Robux amount", MAX_AMOUNT);
      const orderId = requiredText(body.orderId, "Order ID", 80);
      const status = body.status === undefined ? COUNTED_STATUS : oneOf(body.status, STATUSES, "Status");
      const sentAt = sentAtFrom(body.sentAt);
      const discordId = optionalDiscordId(body.discordId);
      const staff = optionalText(body.staff, "Staff", 60);
      const notes = optionalText(body.notes, "Notes");
      const senderId = String(body.senderUserId ?? "");
      const allowOverLimit = body.allowOverLimit === true;

      const preCheck = await store.read();
      if (!preCheck.senders.some((s) => s.userId === senderId)) {
        throw new TrackerError("Choose a sending account.");
      }

      const receiver = await lookupRobloxUser(body.receiverUsername, "Receiver");
      const avatars = await fetchHeadshots([receiver.id]);

      const transfer = await store.update((d) => {
        const sender = d.senders.find((s) => s.userId === senderId);
        if (!sender) throw new TrackerError("Choose a sending account.");
        if (!sender.active) throw new TrackerError(`${sender.label} is disabled.`, 409);
        if (sender.userId === receiver.id) throw new TrackerError("Receiver cannot be the sending account.");

        const duplicate = d.transfers.find(
          (t) => t.orderId.toLowerCase() === orderId.toLowerCase() && !["failed", "cancelled"].includes(t.status)
        );
        if (duplicate) {
          throw new TrackerError(`Order ID ${orderId} is already recorded (${duplicate.status}).`, 409);
        }

        if (status === COUNTED_STATUS && !allowOverLimit) {
          // Check the windows ending at the send's own time, so backdated sends are judged fairly.
          const summary = senderSummary(sender, d.transfers, d.settings, sentAt.getTime());
          const problems = [];
          if (amount > summary.last24h.remaining) problems.push(`24-hour remaining is ${summary.last24h.remaining.toLocaleString("en-US")} R$`);
          if (amount > summary.last30d.remaining) problems.push(`30-day remaining is ${summary.last30d.remaining.toLocaleString("en-US")} R$`);
          if (problems.length) {
            throw new TrackerError(
              `This send exceeds ${sender.label}'s configured limit (${problems.join("; ")}). Tick "allow over configured limit" to record it anyway.`,
              409,
              { overLimit: true }
            );
          }
        }

        const nowIso = new Date().toISOString();
        const created = {
          id: crypto.randomUUID(),
          orderId,
          amount,
          status,
          sentAt: sentAt.toISOString(),
          receiver: {
            userId: receiver.id,
            username: receiver.name,
            displayName: receiver.displayName,
            avatarUrl: avatars.get(receiver.id) ?? null
          },
          sender: { userId: sender.userId, username: sender.username, label: sender.label },
          discordId,
          staff,
          notes,
          createdAt: nowIso,
          updatedAt: nowIso
        };
        d.transfers.push(created);
        return created;
      });
      res.status(201).json({ ok: true, transfer });
    })
  );

  router.patch(
    "/transfers/:id",
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const updates = {};
      if (body.status !== undefined) updates.status = oneOf(body.status, STATUSES, "Status");
      if (body.notes !== undefined) updates.notes = optionalText(body.notes, "Notes");
      if (body.staff !== undefined) updates.staff = optionalText(body.staff, "Staff", 60);
      if (body.discordId !== undefined) updates.discordId = optionalDiscordId(body.discordId);

      const transfer = await store.update((d) => {
        const existing = d.transfers.find((t) => t.id === String(req.params.id));
        if (!existing) throw new TrackerError("Transfer not found.", 404);
        Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
        return existing;
      });
      res.json({ ok: true, transfer });
    })
  );

  router.delete(
    "/transfers/:id",
    wrap(async (req, res) => {
      await store.update((d) => {
        const index = d.transfers.findIndex((t) => t.id === String(req.params.id));
        if (index === -1) throw new TrackerError("Transfer not found.", 404);
        d.transfers.splice(index, 1);
      });
      res.json({ ok: true });
    })
  );

  router.use((_req, res) => res.status(404).json({ ok: false, error: "Not found." }));

  // eslint-disable-next-line no-unused-vars
  router.use((error, _req, res, _next) => {
    if (error?.public) {
      return res.status(error.status || 400).json({ ok: false, error: error.message, ...(error.extra || {}) });
    }
    if (error?.type === "entity.parse.failed" || error?.type === "entity.too.large") {
      return res.status(400).json({ ok: false, error: "Invalid request." });
    }
    console.error("Tracker error:", error?.message || error);
    res.status(500).json({ ok: false, error: "Tracker storage error. Please try again." });
  });

  return router;
}
