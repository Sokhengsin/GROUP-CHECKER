# HENGGOLIVER Roblox Community Checker

A small Node.js web app designed for Railway. It checks whether a Roblox account is currently a
member of any public Roblox community, and optionally estimates a membership-age requirement.

## What it checks

Inputs: a **Roblox username** and a **community link**, for example
`https://www.roblox.com/communities/179222023/Hyper-` or `https://www.roblox.com/groups/179222023/Hyper-`.

The server:
1. Parses the link (only `roblox.com` / `www.roblox.com`) and extracts the numeric community ID.
2. Resolves the username to a user ID (`users.roblox.com/v1/usernames/users`).
3. Reads the community's name and verified badge (`groups.roblox.com/v1/groups/{id}`).
4. Reads the user's current memberships (`groups.roblox.com/v2/users/{userId}/groups/roles`)
   and reports member yes/no, current role and rank.
5. **Optional:** if `ROBLOX_API_KEY` is set and the key can read that community through Open Cloud,
   it fetches the membership `createTime` and calculates the membership-age requirement
   (`VERIFIED_GROUP_PAYOUT_WAIT_DAYS` for verified communities, `STANDARD_PAYOUT_WAIT_DAYS` otherwise).
   If access is denied or no timestamp is returned, it silently falls back to the basic result.

Public Roblox endpoints do not expose join dates, so without a working Open Cloud key the app shows
"Member confirmed. Exact join date is unavailable…". It never guesses a join date.

No API key and no `.ROBLOSECURITY` cookie is needed for the basic membership check.

## Setup

```bash
npm install
```

Create `.env` (copy `.env.example`):

```env
PORT=3000
ROBLOX_API_KEY=
STANDARD_PAYOUT_WAIT_DAYS=14
VERIFIED_GROUP_PAYOUT_WAIT_DAYS=3
```

Never commit `.env`.

```bash
npm start
```

Open http://localhost:3000

## API

- `GET /api/health` returns `{ "ok": true, ... }`
- `POST /api/check` with body `{ "username": "...", "communityLink": "https://www.roblox.com/communities/..." }`

All `/api` responses are JSON, including errors and unknown routes.

## Protections

- Rate limit: 15 checks per minute per IP on `/api/check` (in memory).
- 8-second timeout on every Roblox request.
- Short in-memory caches: usernames and communities 5 min, memberships 30 s, Open Cloud results 60 s.
- Secrets stay server-side. The browser only talks to `/api/check`.

## Railway

1. Push this folder to GitHub (or use `railway up`).
2. Railway runs `npm install` and `npm start` automatically and sets `PORT` itself.
3. Optionally add `ROBLOX_API_KEY`, `STANDARD_PAYOUT_WAIT_DAYS`, `VERIFIED_GROUP_PAYOUT_WAIT_DAYS` under Variables.
4. Generate a public domain in Railway settings.

## Disclaimer

This checker only verifies membership information and estimates the configured membership-age
requirement when Roblox provides a trustworthy join timestamp. Roblox may apply additional payout restrictions.
