# farm-game-server — مزرعة الحي cloud server (Hamada 11)

Live: https://farm-game-server-fmaf.onrender.com
Stack: Node + Express on Render free, Postgres on Neon free. Auto-deploys from `main`.

Auth: `Authorization: Bearer <device_token>` from `POST /players`. All JSON. CORS open.
Free tier sleeps after ~15 min idle; first request takes ~30-40s. Ping `GET /health` on launch with auto-retry.

## Contract v1 endpoints (Hamada 8)

| Endpoint | Notes |
|---|---|
| `POST /players` `{display_name?}` | → `{player_id, device_token, friend_code, display_name}`. Token shown once. |
| `GET /players/me` | profile + `coins` + `pending_rewards[]` |
| `PATCH /players/me` `{display_name?, avatar_id?, level?}` | |
| `PUT /save` `{save_blob, save_version, updated_at, level?}` | last-write-wins; stale `updated_at` → 409 with stored blob |
| `GET /save` | latest blob |
| `POST /friends/request` `{friend_code}` | auto-accepts if reverse request pending |
| `POST /friends/accept` `{player_id}` | |
| `GET /friends` | `{friends[], incoming_requests[]}` |
| `GET /friends/:id/farm` | read-only `farm_snapshot` (save_blob.farm or whole blob) |
| `GET /market/prices` | `{multipliers, event_market_multiplier, updated_at}` — multipliers include live event effects |
| `POST /market/sell` `{item_id, count}` | → `{coins_received, new_multiplier}`; sell pressure lowers global multiplier, recovers over ~6h |
| `GET /auctions/current` | `{auction_id, item, closes_at, top_bid, top_bidder_name, last_result}` |
| `POST /auctions/:id/bid` `{amount}` | funds validated; outbid players refunded instantly; bid in last 2 min extends close by 2 min |
| `POST /guilds` `{name}` | → `{guild_id, invite_code}`, creator is leader |
| `POST /guilds/join` `{invite_code}` | |
| `GET /guilds/me` | members + weekly shared-order progress |
| `POST /guilds/orders/contribute` `{items:[{item_id,count}]}` | rewards split by contribution share at week end |
| `GET /tournaments/current` | `{metric, window, your_rank, your_score, top[]}` |
| `POST /tournaments/score` `{delta}` | capped at 1000/min per player; → `{accepted_delta, your_score}` |

## Additive endpoints (engine may adopt when ready)

- `GET /world/today` (no auth): `{date, season, events[], decoration_theme, music_key, quest_ids, shop_items, event_market_multiplier}` — computed from `seasons_calendar.json` (Hamada 18's data file, committed here).
- `POST /rewards/claim` `{ids}` — claims auction wins / tournament prizes / guild rewards from `pending_rewards`.
- `GET /health` — `{ok, service, time}`.

## Economy config

`economy.json` holds item base prices, multiplier bands, market dynamics, tournament caps, auction and guild parameters. Current values are placeholders — Hamada 10 supplies the real `market.json` numbers; swapping them needs no code change.

## Windows

Auctions, tournaments and guild orders run in 7-day windows, auto-created when none is open and settled lazily at close (winner charged at bid time, losers refunded at outbid, rewards posted to `pending_rewards`).
