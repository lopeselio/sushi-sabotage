# Sushi Sabotage — agent notes

- Hackathon rules: https://nearhackathon.com/HACKATHON.md (deadline 2026-11-14 23:59 UTC; repo must stay public; hosted demo up to 2026-11-18, ideally 2026-11-25).
- Design source of truth: DESIGN.md. Keep README "do X, see Y" steps current — AI judges run them.
- Independent of Bazaar of Liars, Realm Ledger and Parkwright: no copied code. Recipes/idea come from our own Sushi Bonks (Monad); the Unity Kitchen Chaos course project in this folder is reference only and gitignored — never ship its code or assets.
- packages/rules is deterministic: no Math.random, no Date.now, no DOM. Replays must reproduce the state hash.
- The LLM never moves a chef, picks a target, sets a price or decides a sale; packages/rules does.
- Testnet only. Keys live in .env / ~/.near-credentials, never in the repo.
- Verify NEAR endpoints/SDK versions against docs.near.org/llms.txt and docs.near.ai/llms.txt, not memory.
- 3D assets: tools/blender/build_assets.py, run headless (`pnpm assets`); review the PNG previews.
- Commits: no Co-Authored-By or other AI attribution lines; small granular commits.
