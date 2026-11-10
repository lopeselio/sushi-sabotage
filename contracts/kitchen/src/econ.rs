//! Chef energy and upgrades, paid in testnet NEAR (DESIGN.md, "Energy and upgrades").
//!
//! - **Energy** lives on the Chef NFT (it moves with the token). A shift a signed-in chef plays costs
//!   `ENERGY_PER_SHIFT`, taken by `create_match`. It regenerates by itself at one point every
//!   `ENERGY_REGEN_NS` (100 an hour) up to `ENERGY_MAX`, from block timestamps, so free play always
//!   comes back. `buy_energy` adds `ENERGY_PACK` for exactly `ENERGY_PACK_PRICE`, whenever the chef
//!   is at or below full; bought energy can go past `ENERGY_MAX` (regen stops there). Agents' chefs
//!   (the AI league) don't use energy: their contract spending caps already limit them.
//! - **Upgrades**: four slots (knife, pan, sandals, apron), levels 1-5, each level priced in NEAR
//!   (`GEAR_PRICE_MILLINEAR`) and gated on the chef's own level (`GEAR_CHEF_LEVEL`), so they can't
//!   all be bought on day one. The referee passes each seat's gear to `create_match`, which checks
//!   it against the token (and caps it at `RANKED_GEAR_CAP` in a ranked match) and records it, so
//!   the replay and `pnpm verify` use exactly those levels.
//! - **Where the NEAR goes**: it stays in this contract's account and is counted in `treasury`.
//!   The treasury pays the storage of free chef mints and matches; the owner can only withdraw what
//!   it has counted (`withdraw_treasury`), e.g. to top up the agents and the gas relayer.
//!
//! Payments need an attached deposit, so they are ordinary wallet transactions from the player:
//! the game's gasless relayer never attaches deposits.

use crate::*;
use near_sdk::json_types::U128;

pub const ENERGY_MAX: u32 = 1000;
pub const ENERGY_PER_SHIFT: u32 = 100;
/// one energy point every 36 s = 100 an hour (a free shift an hour; empty to full in 10 h)
pub const ENERGY_REGEN_NS: u64 = 36_000_000_000;
pub const ENERGY_PACK: u32 = 300;
pub const ENERGY_PACK_PRICE: NearToken = NearToken::from_millinear(100);

pub const GEAR: [&str; 4] = ["knife", "pan", "sandals", "apron"];
pub const GEAR_MAX: u8 = 5;
/// price of level 1..5 of any slot, in milliNEAR (0.05, 0.1, 0.2, 0.3, 0.5 NEAR)
pub const GEAR_PRICE_MILLINEAR: [u128; 5] = [50, 100, 200, 300, 500];
/// the chef level needed to buy level 1..5 of any slot
pub const GEAR_CHEF_LEVEL: [u32; 5] = [1, 2, 3, 5, 7];
/// a ranked match counts at most this level per slot
pub const RANKED_GEAR_CAP: u8 = 3;

/// What a chef has beyond the v1 token layout. Stored apart from the token (keyed by token id) so
/// the tokens already onchain keep their layout; a chef with no entry has full energy and no gear.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ChefExtra {
    pub energy: u32,
    /// when `energy` was last brought up to date
    pub energy_ns: u64,
    pub gear: Vec<u8>,
}

impl ChefExtra {
    pub fn fresh(now: u64) -> Self {
        Self { energy: ENERGY_MAX, energy_ns: now, gear: vec![0; GEAR.len()] }
    }
    /// Adds the energy regenerated since `energy_ns`, keeping any part-point for later.
    pub fn regen(&mut self, now: u64) {
        if self.energy >= ENERGY_MAX {
            // full: regen only starts again once some is spent
            self.energy_ns = now;
            return;
        }
        if now <= self.energy_ns {
            return;
        }
        let gained = (now - self.energy_ns) / ENERGY_REGEN_NS;
        if self.energy as u64 + gained >= ENERGY_MAX as u64 {
            self.energy = ENERGY_MAX;
            self.energy_ns = now;
        } else {
            self.energy += gained as u32;
            self.energy_ns += gained * ENERGY_REGEN_NS;
        }
    }
}

#[near(serializers = [json])]
pub struct GearPrice {
    pub level: u8,
    pub price: U128,
    pub chef_level: u32,
}

#[near(serializers = [json])]
pub struct ChefEcon {
    pub chef: String,
    pub level: u32,
    pub energy: u32,
    pub energy_max: u32,
    pub energy_per_shift: u32,
    /// seconds until the next energy point (0 when full)
    pub next_energy_secs: u64,
    pub gear: Vec<u8>,
    /// the next level of each slot (None when maxed), with its price and the chef level it needs
    pub next_gear: Vec<Option<GearPrice>>,
    /// whether a shift played now would be recorded (enough energy, or an agent's chef)
    pub can_play: bool,
}

#[near(serializers = [json])]
pub struct Economy {
    pub energy_max: u32,
    pub energy_per_shift: u32,
    pub energy_regen_secs: u64,
    pub energy_pack: u32,
    pub energy_pack_price: U128,
    pub gear: Vec<String>,
    pub gear_max: u8,
    pub gear_prices: Vec<U128>,
    pub gear_chef_level: Vec<u32>,
    pub ranked_gear_cap: u8,
    pub treasury: U128,
}

pub fn gear_price(level: u8) -> NearToken {
    NearToken::from_millinear(GEAR_PRICE_MILLINEAR[(level - 1) as usize])
}

#[near]
impl Kitchen {
    /// Buys one energy pack for a chef you own: attach exactly 0.1 NEAR. Allowed whenever the chef
    /// is at or below full (1000); the whole pack is added, so it can take a full chef to 1300.
    #[payable]
    pub fn buy_energy(&mut self, chef: String) -> u32 {
        let paid = env::attached_deposit();
        require!(paid == ENERGY_PACK_PRICE, "attach exactly 0.1 NEAR for an energy pack");
        self.owned_chef(&chef);
        let now = env::block_timestamp();
        let mut x = self.extra_of(&chef, now);
        require!(x.energy <= ENERGY_MAX, "energy is already above full: play a shift first");
        x.energy += ENERGY_PACK;
        let energy = x.energy;
        self.chef_extra.insert(chef.clone(), x);
        self.treasury += paid.as_yoctonear();
        Event::EnergyBought { chef, by: env::predecessor_account_id(), energy, paid: U128(paid.as_yoctonear()) }.emit();
        energy
    }

    /// Buys the next level of an upgrade slot (`knife`, `pan`, `sandals` or `apron`) for a chef
    /// you own. Attach at least its price; anything over it is refunded.
    #[payable]
    pub fn buy_upgrade(&mut self, chef: String, slot: String) -> u8 {
        let k = GEAR.iter().position(|g| *g == slot).unwrap_or_else(|| env::panic_str("slot: knife, pan, sandals or apron"));
        let stats_xp = self.owned_chef(&chef);
        let now = env::block_timestamp();
        let mut x = self.extra_of(&chef, now);
        let level = x.gear[k] + 1;
        require!(level <= GEAR_MAX, "already at the top level");
        let need = GEAR_CHEF_LEVEL[(level - 1) as usize];
        require!(level_of(stats_xp) >= need, format!("level {level} needs a level {need} chef"));
        let price = gear_price(level);
        let paid = env::attached_deposit();
        require!(paid >= price, format!("level {level} costs {} milliNEAR", price.as_millinear()));
        x.gear[k] = level;
        self.chef_extra.insert(chef.clone(), x);
        self.treasury += price.as_yoctonear();
        let change = paid.saturating_sub(price);
        if !change.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(change);
        }
        Event::Upgraded { chef, slot, level, by: env::predecessor_account_id(), paid: U128(price.as_yoctonear()) }.emit();
        level
    }

    /// Sends NEAR the treasury has counted to `to` (owner only, never more than the treasury).
    pub fn withdraw_treasury(&mut self, to: AccountId, amount: U128) -> Promise {
        self.only_owner();
        require!(amount.0 <= self.treasury, "more than the treasury holds");
        self.treasury -= amount.0;
        Event::TreasuryWithdrawn { to: to.clone(), amount }.emit();
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// A chef's energy (brought up to date), gear and next upgrade prices.
    pub fn get_chef(&self, chef: String) -> Option<ChefEcon> {
        let t = self.tokens.get(&chef)?;
        let Kind::Chef { stats, .. } = &t.kind else { return None };
        let now = env::block_timestamp();
        let x = self.extra_of(&chef, now);
        let level = level_of(stats.xp);
        let agent = self.is_agent_chef(&chef);
        Some(ChefEcon {
            chef,
            level,
            energy: x.energy,
            energy_max: ENERGY_MAX,
            energy_per_shift: ENERGY_PER_SHIFT,
            next_energy_secs: if x.energy >= ENERGY_MAX { 0 } else { (x.energy_ns + ENERGY_REGEN_NS).saturating_sub(now) / 1_000_000_000 },
            next_gear: x
                .gear
                .iter()
                .map(|l| {
                    (*l < GEAR_MAX).then(|| GearPrice {
                        level: l + 1,
                        price: U128(gear_price(l + 1).as_yoctonear()),
                        chef_level: GEAR_CHEF_LEVEL[*l as usize],
                    })
                })
                .collect(),
            gear: x.gear,
            can_play: agent || x.energy >= ENERGY_PER_SHIFT,
        })
    }

    /// The price list and the treasury.
    pub fn get_economy(&self) -> Economy {
        Economy {
            energy_max: ENERGY_MAX,
            energy_per_shift: ENERGY_PER_SHIFT,
            energy_regen_secs: ENERGY_REGEN_NS / 1_000_000_000,
            energy_pack: ENERGY_PACK,
            energy_pack_price: U128(ENERGY_PACK_PRICE.as_yoctonear()),
            gear: GEAR.iter().map(|g| g.to_string()).collect(),
            gear_max: GEAR_MAX,
            gear_prices: (1..=GEAR_MAX).map(|l| U128(gear_price(l).as_yoctonear())).collect(),
            gear_chef_level: GEAR_CHEF_LEVEL.to_vec(),
            ranked_gear_cap: RANKED_GEAR_CAP,
            treasury: U128(self.treasury),
        }
    }

    /// The gear each seat played a match with (recorded at create_match), or None if nobody had any.
    pub fn get_match_gear(&self, match_id: String) -> Option<Vec<Vec<u8>>> {
        self.match_gear.get(&match_id).cloned()
    }
}

impl Kitchen {
    pub(crate) fn extra_of(&self, chef: &str, now: u64) -> ChefExtra {
        let mut x = self.chef_extra.get(chef).cloned().unwrap_or_else(|| ChefExtra::fresh(now));
        x.regen(now);
        x
    }

    /// The caller must own `chef` and it must be a chef; returns its xp.
    fn owned_chef(&self, chef: &str) -> u64 {
        let t = self.tokens.get(chef).unwrap_or_else(|| env::panic_str("no such token"));
        require!(t.owner_id == env::predecessor_account_id(), "you don't own that token");
        match &t.kind {
            Kind::Chef { stats, .. } => stats.xp,
            _ => env::panic_str("not a chef"),
        }
    }

    pub(crate) fn is_agent_chef(&self, chef: &str) -> bool {
        self.tokens
            .get(chef)
            .and_then(|t| self.agents.get(&t.owner_id))
            .map(|a| a.chef == chef)
            .unwrap_or(false)
    }

    /// At create_match: takes a shift's energy from every player chef, and checks and records gear.
    pub(crate) fn start_shift_econ(&mut self, match_id: &str, seats: &[Seat], gear: Option<Vec<Vec<u8>>>, ranked: bool) {
        let now = env::block_timestamp();
        if let Some(g) = &gear {
            require!(g.len() == seats.len(), "gear: one entry per seat");
        }
        let mut recorded: Vec<Vec<u8>> = vec![];
        let mut any = false;
        for (i, s) in seats.iter().enumerate() {
            let want = gear.as_ref().map(|g| g[i].clone()).unwrap_or_default();
            require!(want.is_empty() || want.len() == GEAR.len(), "gear: one level per slot");
            let Some(chef) = &s.chef else {
                require!(want.iter().all(|l| *l == 0), "guest seats have no gear");
                recorded.push(vec![0; GEAR.len()]);
                continue;
            };
            let agent = self.is_agent_chef(chef);
            let mut x = self.extra_of(chef, now);
            if !agent {
                require!(x.energy >= ENERGY_PER_SHIFT, format!("{chef} is out of energy"));
                x.energy -= ENERGY_PER_SHIFT;
                Event::EnergyUsed { chef: chef.clone(), match_id: match_id.to_string(), energy: x.energy }.emit();
            }
            let mut row = vec![0u8; GEAR.len()];
            for (k, l) in want.iter().enumerate() {
                require!(*l <= x.gear[k], "gear above what the chef owns");
                require!(!ranked || *l <= RANKED_GEAR_CAP, "ranked gear is capped at level 3");
                row[k] = *l;
                any |= *l > 0;
            }
            recorded.push(row);
            if !agent || self.chef_extra.get(chef).is_some() {
                self.chef_extra.insert(chef.clone(), x);
            }
        }
        if any {
            Event::MatchGear { match_id: match_id.to_string(), gear: recorded.clone() }.emit();
            self.match_gear.insert(match_id.to_string(), recorded);
        }
    }
}
