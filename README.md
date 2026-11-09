# Sushi Sabotage

A three-minute sushi kitchen race for 1–4 chefs, in the browser. You cook the same orders as your rivals. You can also wreck their dishes while they cook: drop a wasabi bomb in a rival's pan, swap the fish on their plate, dull their knives. They see the effect, not who did it. When the shift ends, everyone accuses someone. Then the sabotage log, sealed onchain as it happened, is opened and checked by the contract.

The rival chefs are AI agents with their own NEAR accounts. They pay entry fees, buy sabotage cards from the Fixer (another agent), and pay a Scout agent for reports on the leader. Every chef is an NFT that holds its own purse, cards and record.

Built for NEAR HACKATHON (Nov 2026). Tracks: **Games With Real Economies**, **Privacy & Private AI**, **Agent Economy**, **NFTs That Do Something**. Design: [DESIGN.md](DESIGN.md).

- Contract (testnet): [`sushi-sabotage.testnet`](https://testnet.nearblocks.io/address/sushi-sabotage.testnet). The referee is [`sushi-sabotage-ref.testnet`](https://testnet.nearblocks.io/address/sushi-sabotage-ref.testnet).
- Agents (sub-accounts, each with only a function-call key): `kenji`, `mei`, `hana` and `tomo` (AI chefs), `fixer` (sells cards) and `scout` (sells reports), all `.sushi-sabotage.testnet`.

## Try it (do X, see Y)

Hosted demo: https://sushi-sabotage.happyflower-1d86c59e.northeurope.azurecontainerapps.io/ (Azure Container Apps). Locally:

```bash
pnpm install
pnpm --filter @sushi/web build
pnpm start            # http://localhost:8787 (server + built web app)
```

Without NEAR keys, run `CHAIN=0 pnpm start`. Everything plays the same, but nothing is written onchain.

1. **Play a solo shift.** Open the page, type a chef name and press **Start shift**.
   - You see an AI chef's taunt. With a NEAR AI key set, it's "signed by a TEE model on NEAR AI".
   - Then a 3-second countdown, and your stall on a night-market street with three rival stalls.
   - **WASD** to move, **E** to pick up or put down, **F** to chop. Orders appear top-left.
2. **Cook a dish.** For *Azure Fin Maki*:
   - **Rice:** raw rice → cooker (3 s) → board (3 chops) = sushi rice.
   - **Base:** nori sheet → board (3 chops) = nori roll.
   - **Fish:** fish → board (3 chops) → pan (3 s) = seared fish. Take it off within 5 s or it burns.
   - **Plate it:** take a plate from the rack, put it on a counter, add the three, and carry it to the hatch at the front. You see "+points", and one Mischief pip lights up.
3. **Sabotage.** With Mischief charged, press **Tab** to pick a target, then **1–6** for a card.
   - The rival's stall flashes red. The AI chefs do the same to you, and you get "Someone hit you with …".
   - **V** shows all four kitchens at once.
4. **Shift end.** The page says "The referee is re-running your shift to check it…". The server replays your input log through the same deterministic sim, then you see:
   - the results table;
   - **the sealed sabotage log, opened**: who hit whom, with what, and when;
   - links to `create_match`, `seal xN` and `settle_match` on nearblocks.

   In `settle_match`, the contract checks every opening against its seal and pays out.
5. **The proof.** **Proof bundle (JSON)** opens `/api/match/<id>`. It holds:
   - the seed, whose hash was committed at `create_match`;
   - the full input log;
   - every seal and its opening (salt included), and the accusations;
   - the signed NEAR AI lines.

   To check a seal: `sha256("<match>|<caster>|<target>|<card>|<tick>|<salt>")` must equal the seal posted onchain mid-shift.
6. **Multiplayer.**
   - **Create room** gives you a 4-letter code. Open a second browser window, enter the code and press **Join**.
   - The host can **Add AI chef**. Everyone presses **Ready**.
   - The server runs the shift at 20 Hz. Neither window ever receives the caster of a sabotage: check `/ws` frames in devtools, where the caster is `-1`.
   - After the shift comes **Whodunit?**: for each hit, pick a suspect. Right is +40 to you and −40 to them; wrong is −10.
   - The contract scores the accusations itself in `settle_match`.
7. **Your Chef NFT** (needs a NEAR testnet wallet).
   - Press **Sign in with NEAR** and pick a wallet. It adds a key limited to this contract's game methods, then signs one message to prove the account.
   - Go to **My Chef → Mint chef**. There's no gas prompt: the limited key signs it.
   - You see the NFT card. It shows level, title, purse (100 ryo), stats and cards, and updates after every shift.
   - **Claim daily 50 ryo** adds to the purse. **Enable ranked (10 ryo/match)** lets the referee charge an entry fee into the prize pot.
8. **The Night Market.**
   - Pick a card and offer a price, optionally with a line of text. The Fixer answers in character.
   - The **price comes from `packages/rules/src/market.ts`**: demand raises it, it decays over an hour, and there's one counter-offer with an 80 % floor. The model only does the talking.
   - On accept, the Fixer agent posts an onchain offer, and your browser accepts it. The page shows the receipt, and the card lands in your chef NFT's inventory.
9. **The agents.** The **Agents** page lists each agent account and the receipts of what they did on their own (every 4 minutes):
   - claim the faucet;
   - buy their favourite card from the Fixer;
   - pay Scout Nori 5 ryo for a report on the current leader.

   A scouted leader becomes that AI chef's preferred sabotage target in the next shift.

## How it works

```
apps/web          three.js night market (Vite, TS), HUD, NEAR Connect wallet, guest play
apps/server       rooms over WebSocket (authoritative 20 Hz sim), solo replay check, referee, agents, NEAR AI
packages/rules    deterministic sim: 20 recipes, stations, orders, sabotage, scoring, AI chefs, market pricing
contracts/kitchen Rust near-sdk 5.29: chef + recipe-scroll NFTs (NEP-171) with purses, offers, agent caps, matches, seals, settlement
tools/blender     bpy script that builds every 3D model (.glb) and its preview
```

- **Deterministic rules.**
  - `packages/rules` uses no `Math.random`, `Date` or DOM. The same setup and input log give the same state hash, and tests check this.
  - The AI chefs are deterministic planners inside the sim (`bot.ts`). They play by sending the same inputs a human does.
  - The language model never moves a chef, picks a target or sets a price.
- **Sealed sabotage (privacy).**
  - Each card cast during a shift becomes `sha256(match|caster|target|card|tick|salt)`. The referee posts these with `seal` every ~3 s.
  - At the end, `settle_match` gets every opening. The contract refuses the settlement unless:
    - the seed matches the hash committed at `create_match`;
    - every seal is opened, in order, and matches.
  - It then scores the accusations itself.
  - In multiplayer, the server strips the caster from every client's view.
  - In solo, your browser runs the sim, so it could know the culprits. That's why only the AI chefs' accusations score in solo.
- **Private AI.**
  - The Fixer's haggling and the AI chefs' taunts come from a TEE-hosted model on NEAR AI Cloud.
  - Each reply is stored in the match's proof bundle with its exact request and response bytes and the enclave's signature.
  - `/api/attestation` returns a fresh attestation report bound to a nonce.
- **Agent economy.**
  - Agents are sub-accounts created by the contract (`create_agent_account`) with a single function-call key. It's limited to `post_offer`, `accept_offer`, `buy_scout`, `approve_referee` and `claim_daily`.
  - `register_agent` puts the agent's chef under caps: 60 ryo/day, 10 ryo per match entry. `spend()` enforces them on every purchase and entry fee.
  - Agents can't move NEAR or call other contracts.
- **NFTs that do something.**
  - A Chef NFT is the account: its purse, card inventory, stats and best score are stored on the token. `nft_transfer` moves all of it.
  - Metadata is generated from that state on every read: title "Name · Title · Lv N", an SVG card and an `extra` JSON.
  - The 20 **Recipe Scrolls** each have their own purse. In ranked matches, 2 ryo per delivered dish go from the pot to that recipe's scroll. The AI chefs own 16 of them, so agents earn passive income. `move_purse` moves a scroll's earnings into your chef.
- **Chain invisible.**
  - Guests play with no wallet.
  - Signed-in players sign gameplay through the function-call key added at sign-in, so there are no popups.
  - The referee pays for every match transaction.

### What the chain does *not* prove

- During a multiplayer shift, the game server runs the sim, so it sees every input. It also holds the agents' keys.
- Shift scores are reported by the referee. They're reproducible from the public input log (`replay()` in `packages/rules`), but the contract doesn't re-run the sim.
- Moving the referee into a TEE would close that gap. It isn't done.

## Tests

```bash
pnpm --filter @sushi/rules test     # sim, sabotage, accusations, replay determinism, market
pnpm contract:test                   # 16 contract tests: NFTs, transfers, offers, caps, seals, settlement, royalties
pnpm sim 10                          # headless AI-only shifts: balance check
```

## Deploying

- **Contract:** `pnpm contract:build`, then `near contract deploy sushi-sabotage.testnet use-file contracts/kitchen/target/near/sushi_sabotage_kitchen.wasm with-init-call new json-args '{"owner":"sushi-sabotage.testnet","referee":"sushi-sabotage-ref.testnet"}' …`.
- **Agents:** `pnpm --filter @sushi/server setup:agents`. It creates the six agent accounts with function-call keys, registers them, approves fees and mints the 20 scrolls. It is idempotent.
- **Hosting:** `scripts/deploy-azure.sh`. One Docker image runs on Azure Container Apps; the server serves the web app.

## Lineage, reuse and disclosures

- **Our earlier game.** Recipes, ingredient chains and the chef/session/leaderboard idea come from **Sushi Bonks** (Unity, Monad testnet: https://github.com/IntoTheVerse/sushi-nads). Nothing from it is reused as code. This NEAR version is a new codebase written in the hackathon window: three.js client, TypeScript server and rules, Rust contract, Blender scripts.
- **Genre.** The station rules (cut, cook, burn, plate, deliver) follow the kitchen-game genre. We studied a Unity Netcode course project for netcode structure only; none of its code or assets are included.
- **Other projects.** Sushi Sabotage is independent of our other NEAR HACKATHON projects (Bazaar of Liars, Realm Ledger, Parkwright). It has its own repo, contract, rules, art and server, and no shared code. They're meant to sit together in one arcade launcher.
- **Libraries:**
  - three.js
  - near-api-js
  - @hot-labs/near-connect and function-call-key-plugin
  - @noble/hashes and @noble/curves
  - ws
  - Vite
  - near-sdk (Rust)
- **AI-written code:** this code was written with an AI coding assistant (Claude Code) and reviewed by the author.
- **Assets:** every 3D model is generated by `tools/blender/build_assets.py` (run `pnpm assets`). Sounds are synthesised in WebAudio. Fonts are Inter and Dela Gothic One (Google Fonts, OFL). No paid or AI-generated asset packs.

## License

MIT
