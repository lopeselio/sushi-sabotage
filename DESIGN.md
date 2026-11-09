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

## NFTs

- **Chef NFT** (NEP-171 + NEP-177 metadata, written by us, no template): one is minted free per player. Guests can claim one later. Each token holds:
  - a ryo **purse**: entry fees are paid from it and winnings go into it;
  - a card **inventory** (unused cards bought from the Fixer);
  - **stats**: shifts, deliveries, burns, sabotages landed, times caught, best score;
  - **level and title**, derived from stats onchain and shown as dynamic metadata (`extra` JSON and an SVG data-URI image rendered by the contract).

  Transferring the token transfers the purse, the inventory and the record. That's the NFT-as-account.
- **Recipe Scrolls**: 20 tokens, one per recipe, minted by the game in a launch auction or as season rewards. In ranked matches 2 ryo per delivery of that recipe go to the scroll's owner, from the pot. AI chefs own some scrolls, so agents earn passive income too.

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
4. **Replay.** `pnpm verify <matchId>` fetches the match from chain plus the public input log and re-runs the sim. Anyone can check that the scores match.

**What it doesn't prove**, and the README says so plainly: the game server sees all inputs during the shift, because it runs the sim. It holds the agent keys. Moving the referee into a TEE is a stretch goal.

## Art direction: a night-market sushi stall

- Four lantern-lit stall pods on a wet stone street at night, with steam, paper lanterns and noren curtains.
- Chefs are chunky, toy-like figures with headbands, tinted per player at runtime.
- Food is readable at a glance: colour-coded, oversized and toy-like.
- **Every 3D asset is built by bpy scripts in `tools/blender/`**, run headless (`Blender -b -P`), exported to `.glb` and previewed to PNG for review. No paid or AI-generated asset packs. The scripts are in the repo, so `pnpm assets` rebuilds everything.
- three.js (WebGL2), with soft shadows, lantern point lights, bloom on lanterns and stoves, and steam particles.
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

## Arcade

Sushi Sabotage is built to live in an arcade launcher alongside Bazaar of Liars, Realm Ledger and Parkwright. It is a standalone app with its own URL, which the launcher links to or embeds. It has no shared code with those games.

## Plan (built in this order, always playable)

1. `packages/rules`: the sim, recipes, sabotage, scoring and bot, with tests and a headless bot-vs-bot balance run.
2. `contracts/kitchen`: NFTs, purses, matches, seals, settlement and agents, with unit tests, deployed to testnet.
3. `apps/web`: the three.js kitchen running the solo sim locally against bots.
4. `apps/server`: solo-run verification, multiplayer rooms, the referee and the agents.
5. Blender assets, the Fixer market, NEAR AI voices and the Whodunit UI.
6. Polish, Docker, Azure, README, video.
