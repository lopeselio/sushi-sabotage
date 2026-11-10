# Sushi Sabotage — Design

A fast sushi-kitchen game for one to four chefs. Every chef runs their own counter on a night-market floor, racing the same stream of orders. You can sabotage a rival's dish while they're still making it. Nobody sees who did it until the shift ends, and the chain proves who did what.

Built for NEAR HACKATHON (1–14 Nov 2026). Tracks: **Games With Real Economies** (`games`), **Privacy & Private AI** (`privacy`), **Agent Economy** (`agents`), **NFTs That Do Something** (`nfts`).

This document is the source of truth. It comes before the code.

## Lineage (disclosed)

- **Recipes, ingredient chains and the chef/session/leaderboard contract idea** come from our own earlier game, Sushi Bonks (Unity, Monad testnet, https://github.com/IntoTheVerse/sushi-nads). On NEAR, everything is rebuilt from scratch: the browser game in three.js, the authoritative server, the Rust contract and the Blender assets. No Unity or Solidity code is reused. Only the NEAR build made in the hackathon window is submitted (Q-002).
- **The counter rules** (cut, cook, burn, plate, deliver) belong to the genre: a kitchen game with stations. We learned the netcode shape from a Unity Netcode course project and don't ship any of its code or assets. That project trusted the client for every interaction. Ours is fully server-authoritative.

## The pitch in one breath

Twenty sushi recipes, four chefs, three minutes. Cook rice, slice fish, sear lobster, simmer wasabi and roll it before the order goes cold. When a rival's pan is nearly done, drop a wasabi bomb in it. They'll know someone did it, but not who. At the end of the shift everyone accuses someone. The sealed sabotage log opens onchain, and liars pay.

## Why this fits the four tracks

| Track | What judges look for | What Sushi Sabotage does |
|---|---|---|
| Games With Real Economies | NPCs with wallets, economies that move without a dev patch, a good loop, chain invisible | Rival chefs are AI agents with their own NEAR accounts and chef NFTs. They pay entry fees, win pots and buy sabotage from the Fixer. Card prices follow demand. Guests play with no wallet. Signed-in players never sign a gameplay transaction or see gas. |
| Privacy & Private AI | Private inference, hidden information that's real, verifiable | Every sabotage is sealed onchain as `sha256(match|caster|target|card|tick|salt)` when it's cast. The victim sees the effect, not the culprit. Seals open at shift end and the contract checks them. The AI chefs' trash talk and Fixer haggling run on NEAR AI Cloud inside a TEE, and every reply is signed. |
| Agent Economy | Agents that earn, spend, negotiate, hire, pay for data within a budget | AI chefs hold wallets with contract-enforced spending caps. They pay entry fees, haggle with the **Fixer** (an agent that sells sabotage cards), buy **scouting reports** (paying for data), and earn prize money. Every spend is a receipt event. Function-call keys only, no full-access keys. |
| NFTs That Do Something | NFTs as accounts that own money, earn royalties, carry inventory and credentials | A **Chef NFT** (NEP-171) is the account: the ryo balance, card inventory, stats and rank live on the token, not the wallet. Sell the chef and its purse and record go with it. Each of the 20 **Recipe Scrolls** (NEP-171) earns a royalty from the match pot every time anyone delivers that recipe in a ranked match. Metadata is dynamic: level, signature dish and title change as the chef plays. |

## The game loop

**Every few seconds:** grab an ingredient, chop it, cook it, plate it and deliver it. Watch your stoves and the order rail.

**Every shift (3 minutes):**
1. **Market.** Before the shift, buy sabotage cards from the Fixer with ryo (or haggle in plain words). AI chefs shop too.
2. **Shift.** Orders arrive on a shared seeded rail, so every chef gets the same orders in the same order. Deliveries build your Mischief meter, and full charges let you play sabotage cards at rivals.
3. **Whodunit.** For each sabotage that hit you, accuse a rival (or pass). Then the seals open.
4. **Settle.** Scores, accusation bonuses, pot payouts and recipe royalties are paid. One transaction per match, signed by the referee.

**Every session:** climb the season leaderboard. Level your chef. Collect scrolls.

## Kitchen rules (packages/rules, deterministic)

Fixed tick of 20 Hz. All timers are integer ticks. All randomness comes from a seeded PRNG. The same input log always produces the same state hash.

**Ingredients and chains**
| Raw (container) | Station | Product |
|---|---|---|
| Rice | Rice cooker 3 s (burns 5 s later) → Cutting board 3 chops | Sushi rice |
| Nori sheet | Cutting board 3 chops | Nori roll (maki base) |
| Nori cone | none | Cone (temaki base) |
| Fish | Board 3 chops → Pan 3 s (burns 5 s later) | Seared fish |
| Lobster | Board 3 chops → Pan 3 s (burns 5 s later) | Seared lobster |
| Tomato | Board 3 chops → Pan 3 s | Blistered tomato |
| Avocado | Board 5 chops | Avocado |
| Wasabi | Board 3 chops | Wasabi slices (also an ingredient) → Pot 10 s, never burns → Wasabi chutney |

**Recipes (20).** Every dish is sushi rice plus a base (nori roll for maki, cone for temaki) plus a protein (fish or lobster) and a prefix of [tomato, avocado, wasabi slices, chutney]. That gives 2 bases × 2 proteins × 5 depths = 20. Names come from Sushi Bonks: Azure Fin, Sun-Fin, Coral Drift, Wasabi Wave, Aurora Mist (fish maki), Crimson Claw … Inferno Claw (lobster maki), Blue Current … Celestial Mist (fish temaki), Ruby Current … Solar Flare (lobster temaki).

**Stations (per chef pod):** 8 containers, 2 cutting boards on the centre island, rice cooker, 2 pans, wasabi pot, plate rack (a plate every 4 s, max 4), delivery hatch, trash, and clear counters. A chef holds one thing. A plate takes each ingredient once. Delivery matches an order's ingredient set exactly.

**Orders.** A new order every 12 s (max 4 waiting), drawn from the seeded rail. Shallow recipes are weighted early and deeper ones later. Each order has a patience of 55–95 s, and an expired order costs points. (Tuned with `pnpm sim`: a hard bot delivers about 8 dishes a shift, an easy one about 5.)

**Score.** Delivery = 20 + 8 × ingredients, plus a speed tip of up to +50% for fast service. A burn costs −10, trashing a plate or dish costs −5, and an expired order costs −15. A streak multiplier goes ×1.1/×1.25/×1.5 at 3/5/8. Accusations: a correct one is +40 for the accuser and −40 for the saboteur. A wrong accusation is −10.

**Sabotage cards** (Mischief: +1 per delivery, max 5):
| Card | Cost | Effect on target |
|---|---|---|
| Wasabi Bomb | 2 | Whatever is cooking on their pan or cooker jumps to "about to burn" (1.5 s left) |
| Fish Swap | 2 | One protein on their plate in progress swaps fish ↔ lobster |
| Dull Knife | 1 | Their boards need +2 chops per item for 10 s |
| Soy Slick | 1 | Their chef moves at 60% speed for 6 s |
| Order Shuffle | 1 | Their oldest order loses 15 s of patience |
| Bamboo Shield | 1 | (self) Blocks the next sabotage aimed at you. The caster still pays |

Every sabotage is shown to its victim as an effect with no caster. In multiplayer the server never sends the caster to anyone else. In single player, the AI rivals cast cards too.

## Modes

- **Solo shift.** You against 1–3 AI chefs. The deterministic sim runs in your browser. At the end the server re-runs your input log to check the score before it goes onchain, so a client can't fake a score. A seeded **daily shift** puts everyone on the same orders for a fair leaderboard.
- **Multiplayer.** 2–4 humans, with AI chefs filling empty pods if wanted. Lobby with a room code, character select, then ready-up. The server is authoritative at 20 Hz. Clients send only `{move, interact, chop, card, target}` inputs and render interpolated snapshots. If a chef disconnects mid-shift, an AI takes over their pod so the match stays fair.

## Agent economy

**How agents hold keys, and what they can't do** (settled first):
- Each AI chef (Kenji, Mei, Tomo, Hana) and the Fixer has its own NEAR sub-account of the game account.
- Each holds one **function-call key** limited to the `kitchen` contract and a short method list (`agent_buy_card`, `agent_buy_scout`, `agent_enter`). Agents have no full-access key, so they can't move NEAR or call other contracts.
- The contract enforces a per-match and a per-day spending cap on each agent chef, and an agent spend needs that agent's own signature.
- The game server holds the agent keys (`~/.near-credentials` locally, a secret when hosted). It can sign as an agent only within those limits.

**The Fixer** sells sabotage cards. Its prices follow demand: each card bought this hour raises that card's price, and the price decays back. You can haggle once in plain words. The LLM voices the Fixer, and `packages/rules/market.ts` decides the price, inside a floor and ceiling.

**Scouting reports** (paying for data): before a ranked match, a chef can buy a rival's last-10-match profile from the Scout agent: favourite cards, average score and burn rate. AI chefs use it to pick targets.

**AI chefs' decisions are deterministic** (`packages/rules/bot.ts`). The model never picks a move or a target. It voices taunts and the Fixer's haggling only.

**AI chef difficulty (rules v2).** Solo shifts and rooms are played at a level the player (or room host) picks: **Easy / Normal / Hard**, default Normal. Every AI chef in the match plays at it (`packages/rules/bot2.ts`). They share the v1 planner, so they always know what to cook. The level changes how they carry it out: thinking time between actions, chopping speed, walking pace and detours, how often they forget a pan until it burns or grab the wrong crate, how long a sabotage leaves them dazed, and how often, how early and at whom they sabotage (Hard chefs all go for the leader). It's tuned against a reference human (`packages/rules/src/refhuman.ts`: ~300 ms per action, the odd detour, a forgotten pan now and then, a card about twice a minute). Over three AI chefs that player wins about 60 % on Easy, 40 % on Normal and 20 % on Hard (`pnpm balance`). The v1 line-up (hard, normal, normal) beat that player in every shift.

**Rules versions.** Bots decide inside the deterministic sim, so changing them would break the replay of settled matches. The match seed names the rules version and difficulty (`v2.normal.<hex>`; an untagged seed is v1), and its hash is committed at `create_match`, so neither can be swapped afterwards. The sim refuses a setup that disagrees with its seed, and `pnpm verify` checks it. Rules v1 (`bot.ts`) is frozen: a test replays matches recorded before v2, including a live settled league match, to the same state hash. The AI league stays on v1 with each chef at its persona level. **Rules v3** (seed `v3.normal.<hex>`) adds chef upgrades to the setup (below) and is otherwise v2; v2 is frozen the same way, by fixtures recorded on main before v3 (a solo with a loadout, a hard shift, a room takeover). The sim refuses gear in a v1/v2 setup, and a v3 chef without gear adds no fields to the state.

## NFTs

- **Chef NFT** (NEP-171 + NEP-177 metadata, written by us, no template): one is minted free per player (no deposit, no gas: the game's relayer pays and the contract pays the storage). Guests are invited to sign in and mint after their first shift. Each token holds:
  - a ryo **purse**: entry fees are paid from it and winnings go into it;
  - a card **inventory** (unused cards bought from the Fixer);
  - **stats**: shifts, deliveries, burns, sabotages landed, times caught, best score;
  - **level and title**, derived from stats onchain and shown as dynamic metadata (`extra` JSON and an SVG data-URI image rendered by the contract).
  - **energy** and **upgrades** (knife, pan, sandals, apron), bought with testnet NEAR (see "Energy and upgrades").

  Transferring the token transfers the purse, the inventory and the record. That's the NFT-as-account.
- **Recipe Scrolls**: 20 tokens, one per recipe, minted by the game in a launch auction or as season rewards. In ranked matches 2 ryo per delivery of that recipe go to the scroll's owner, from the pot. AI chefs own some scrolls, so agents earn passive income too.

## Energy and upgrades (paid in testnet NEAR)

Modelled on Sushi Bonks (energy per session, max 1000, a refill of +300 for 0.1), but every payment here is **testnet NEAR**: no USDC, no other token. All of it lives in the contract (`contracts/kitchen/src/econ.rs`) and is enforced there; guests are never affected.

**Energy.** It lives on the Chef NFT (transfer the chef and its energy goes with it).

| | |
|---|---|
| Maximum (regen cap) | 1000 (a new or migrated chef starts full) |
| A recorded shift | 100, taken by `create_match` from every player chef in the match |
| Regeneration | 1 point every 36 s = 100 an hour, from block timestamps, part-points kept; empty to full in 10 h |
| Energy pack | `buy_energy(chef)` with exactly **0.1 NEAR** attached: +300. Allowed whenever the chef is at or below 1000; bought energy can pass 1000 (regen stops above it) |
| Out of energy | the shift still plays, as a guest seat: nothing is recorded or spent (the server checks `get_chef` first) |
| AI chefs | the agents' own chefs use no energy: their contract spending caps already bound them |

So free play always comes back: about one recorded shift an hour without paying, ten from full.

**Upgrades.** `buy_upgrade(chef, slot)` with NEAR attached (any excess is refunded). Four slots, levels 1–5, bought one level at a time:

| Level | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Price (NEAR) | 0.05 | 0.1 | 0.2 | 0.3 | 0.5 |
| Needs chef level | 1 | 2 | 3 | 5 | 7 |

| Slot | Effect per level (in the sim, `packages/rules/src/gear.ts`) | At level 5 |
|---|---|---|
| Knife | an 8 % chance a chop counts twice (seeded by match, chef and chop number) | 40 % |
| Pan | cooked food on the pan or rice cooker takes 6 % longer to burn | 5 s → 6.5 s |
| Sandals | 2 % faster walking | +10 % |
| Apron | Dull Knife and Soy Slick wear off 6 % sooner; Order Shuffle takes 6 % less patience | −30 % |

**How upgrades reach the sim.** Like card loadouts, through the match setup: the referee reads the chef's levels (`get_chef`), puts them in the rules-v3 setup, and passes them to `create_match`, which refuses anything above what the chef owns (or above level 3 in a ranked match) and records them (`get_match_gear`, `match_gear` event). `pnpm verify` checks that the replayed setup's gear is exactly what the contract recorded. Every effect is integer ticks or a fixed multiplier, so replays stay exact.

**Fairness (no pay-to-win).** Three limits: each effect is small; levels are gated on chef level, which only comes from playing (level 5 of a slot needs a level-7 chef, about 1800 XP, a few dozen shifts); and **ranked shifts count at most level 3 of each slot** (the server caps it, the contract checks it). Measured with the reference human against three Normal AI chefs over 200 seeded shifts: no gear wins 42 %, the ranked cap (level 3 everywhere) 48 %, full level 5 47 %. A test pins the ranked-cap gain at no more than 12 points. Gear is public in the setup, so rivals in a room can see it.

**Where the NEAR goes.** Into the game contract's own account, counted in `treasury` (`get_economy` shows it). The treasury pays the storage behind free chef mints and matches; the owner can only withdraw what it has counted (`withdraw_treasury`), to top up the AI agents and the gas relayer. Every purchase emits an event (`energy_bought`, `upgraded`, each with the amount paid), and every shift's energy use too (`energy_used`).

**Why purchases aren't gasless.** The free actions (mint, faucet, ranked approval, accepting a Fixer offer) are NEP-366 meta-transactions through the game's relayer, which refuses any deposit. A purchase attaches NEAR, so it is an ordinary transaction from the player's wallet; the UI says so before the wallet opens.

**Contract upgrade.** The new fields (`chef_extra`, `match_gear`, `treasury`) are added to the root state only; tokens, matches and every collection keep their storage keys, and a chef with no energy entry reads as full with no gear. `migrate` reads the old root layout (`KitchenV1`) and writes the new one, and refuses to run twice. It's tested on the live testnet bytes (the `STATE` and token entries of `sushi-sabotage.testnet`), was dry-run on a scratch account deployed with the old wasm, and `sushi-sabotage.testnet` was upgraded with `with-init-call migrate`.

**Ryo** is a contract-internal currency, not a token on the market. The daily faucet gives 50 ryo to each chef. It exists only to make the in-game economy real and testable on testnet. A NEP-141 or NEP-245 wrapper is a stretch goal.

## Fair play: what the chain proves

1. **Match start.** The referee calls `create_match` with the order-rail seed hash, the chefs (by token) and the entry fee. Fees move from purses into the pot.
2. **During the shift.** Each sabotage is sealed (`seal_sabotage(match, commitment)`) in batches every ~2 s by the referee. The commitment hides caster, target and card. The order of seals proves when each one was cast.
3. **Shift end.** The referee calls `settle_match` with the seed, every sabotage opening (caster, target, card, tick, salt), every accusation and the final scores. The contract checks:
   - the seed matches its hash;
   - every opening matches a seal;
   - no seal is left unopened;
   - accusations are scored right;
   - payouts and royalties add up and stay inside the pot.

   It then pays out, updates stats and emits events.
4. **Replay.** `pnpm verify <matchId>` fetches the match from chain plus the public input log, checks the seed and every seal, re-runs the sim, and checks that the scores match the contract.

**What it doesn't prove**, and the README says so plainly: the game server sees all inputs during the shift, because it runs the sim. It holds the agent keys. Moving the referee into a TEE is a stretch goal.

## Art direction: a night-market sushi stall

- Four lantern-lit stall pods on a wet cobbled street at night: a back wall with lit shoji, a noren, a signboard with the chef's name, paper lanterns, string lights, stools, crates and steam vents.
- Chefs are chunky, toy-like figures with a face, a hachimaki headband and an apron; body, headband and cuffs are tinted per player at runtime.
- Food is readable at a glance: colour-coded, oversized and toy-like.
- **Every 3D asset is built by bpy scripts in `tools/blender/`**, run headless (`Blender -b -P`), exported to `.glb` and previewed to PNG for review. No paid or AI-generated asset packs. The scripts are in the repo, so `pnpm assets` rebuilds everything.
- three.js (WebGL2): one shadowing moon light, a warm key, a hemisphere fill, one lamp per stall and a stove light; a small generated environment map for reflections on metal and the wet street. Static stall geometry is merged per material to keep draw calls low.
- Bloom on lanterns, bulbs and flames, switched off on touch devices and dropped automatically if frames run long (`?fx=low` / `?fx=high` override). Pixel ratio capped at 1.75.
- Pooled particles: steam, sizzle sparks, smoke when food burns, confetti and a score pop on delivery, a purple puff on a sabotage hit; the camera shakes a little when it happens to you.
- Sound is synthesised in WebAudio: chop, sizzle, ding and a buzzer.

## Architecture

```
apps/web          three.js kitchen + UI (Vite, TypeScript), NEAR Connect wallet, guest mode
apps/server       rooms over WebSocket, authoritative sim, solo-run verifier, referee (NEAR), agents, NEAR AI
packages/rules    deterministic sim: recipes, stations, orders, sabotage, scoring, bots, market (pure, tested)
contracts/kitchen Rust near-sdk: chef NFTs, recipe scrolls, purses, matches, seals, settlement, agents, leaderboard
tools/blender     bpy scripts → .glb assets
```

- NEAR testnet. The contract is written from scratch with near-sdk. Agent sub-accounts use function-call keys.
- Login: guest (no chain), or a NEAR wallet through NEAR Connect. The server pays every transaction as referee, so players never sign gameplay.
- Hosting: one Docker image (the server also serves the built web app) on Azure Container Apps, the same as our other NEAR games.

## The AI league

Every 15 minutes three of the four AI chefs play a ranked shift against each other, headless: the same rules, seed commitment, sabotage seals and settlement as any other match. Fees go into the pot, the contract pays prizes and scroll royalties, and the season leaderboard moves. The economy keeps going when no human is playing. An AI chef sits out a ranked match (it becomes a friendly) if its daily cap wouldn't cover the fee.

## Cards as tokens

Sabotage cards are NEP-245 multi-tokens over chef inventories: an account's balance is its main chef's inventory. Buying from the Fixer mints, bringing a card into a match burns, and players can trade cards with `mt_transfer`. Recipe-scroll royalties are capped at 30% of a pot so a ranked match always has a prize.

## Arcade

Sushi Sabotage is built to live in an arcade launcher alongside Bazaar of Liars, Realm Ledger and Parkwright. It is a standalone app with its own URL, which the launcher links to or embeds. It has no shared code with those games.

## Plan (built in this order, always playable)

1. `packages/rules`: the sim, recipes, sabotage, scoring and bot, with tests and a headless bot-vs-bot balance run.
2. `contracts/kitchen`: NFTs, purses, matches, seals, settlement and agents, with unit tests, deployed to testnet.
3. `apps/web`: the three.js kitchen running the solo sim locally against bots.
4. `apps/server`: solo-run verification, multiplayer rooms, the referee and the agents.
5. Blender assets, the Fixer market, NEAR AI voices and the Whodunit UI.
6. Polish, Docker, Azure, README, video.
