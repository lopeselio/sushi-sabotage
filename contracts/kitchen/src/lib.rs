//! Sushi Sabotage onchain kitchen.
//!
//! What lives here (DESIGN.md, "NFTs", "Agent economy", "Fair play"):
//! - NEP-171 tokens of two kinds, each with its own ryo **purse**:
//!   - Chef NFTs carry the purse, a card inventory and stats; transferring the token moves all three.
//!   - Recipe Scrolls (one per recipe) earn a royalty into their purse whenever anyone delivers
//!     that recipe in a ranked match.
//! - Matches: entry fees move from purses into a pot (only up to what each chef's owner approved),
//!   sabotage seals are posted during the shift, and settlement checks every opening against its
//!   seal, scores the accusations itself, pays royalties and prizes, and updates stats.
//! - The Fixer's offers: an agent posts a priced offer, the buyer accepts it, and a receipt event
//!   records the sale. Scout reports are bought the same way at a fixed price.
//! - Agent policies: per-day and per-match spending caps on agent-owned chefs, checked on every spend.
//!
//! The kitchen rules (cooking, scoring a shift) live in packages/rules and are replayable;
//! this contract checks what it can check (seed, seals, accusations, payouts) and records the rest.

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PublicKey,
};

mod econ;
mod mt;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_econ;

pub use econ::*;

pub const CARDS: [&str; 6] = ["wasabi_bomb", "fish_swap", "dull_knife", "soy_slick", "order_shuffle", "bamboo_shield"];
pub const RECIPE_NAMES: [&str; 20] = [
    "Azure Fin Maki", "Sun-Fin Maki", "Coral Drift Maki", "Wasabi Wave Maki", "Aurora Mist Maki",
    "Crimson Claw Maki", "Scarlet Tide Maki", "Emerald Reef Maki", "Volcanic Reef Maki", "Inferno Claw Maki",
    "Blue Current", "Solar Breeze", "Verdant Drift", "Wasabi Gale", "Celestial Mist",
    "Ruby Current", "Crimson Breeze", "Emerald Drift", "Typhoon Claw", "Solar Flare",
];
/// Methods an agent's function-call key may call.
pub const AGENT_METHODS: &str = "post_offer,accept_offer,buy_scout,approve_referee,claim_daily";
pub const AGENT_GAS_ALLOWANCE: NearToken = NearToken::from_millinear(500);

pub const DAY_NS: u64 = 86_400_000_000_000;
pub const FAUCET: u64 = 50;
pub const STARTING_PURSE: u64 = 100;
pub const ROYALTY: u64 = 2;
/// Recipe scrolls take at most this share (%) of a ranked pot.
pub const ROYALTY_SHARE: u64 = 30;
pub const SCOUT_PRICE: u64 = 5;
pub const ACCUSE_RIGHT: i64 = 40;
pub const CAUGHT: i64 = -40;
pub const ACCUSE_WRONG: i64 = -10;
pub const PRIZE_SHARES: [u64; 3] = [60, 30, 10];
const MAX_SEATS: usize = 4;
const MAX_SEALS: usize = 96;
/// A settled match can be pruned from storage this long after it was created.
pub const PRUNE_AFTER_NS: u64 = 12 * 3_600_000_000_000;
const MAX_PRUNE: usize = 50;
const MAX_NAME: usize = 20;
const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Tokens,
    TokenIds,
    Owned,
    OwnedSet { owner_hash: Vec<u8> },
    ChefOf,
    Minted,
    Agents,
    Offers,
    Matches,
    Board { season: u32 },
    Scrolls,
    // added in the energy/upgrades upgrade (migrate): append only, the index is the storage prefix
    ChefExtra,
    MatchGear,
}

// ---------- data ----------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChefStats {
    pub shifts: u32,
    pub delivered: u32,
    pub burns: u32,
    pub casts: u32,
    pub caught: u32,
    pub sleuth: u32,
    pub wins: u32,
    pub best: i64,
    pub xp: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    Chef { name: String, stats: ChefStats, inventory: Vec<u16>, last_claim_day: u64, approved_fee: u64 },
    Scroll { recipe: u8, earned: u64 },
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Token {
    pub owner_id: AccountId,
    pub kind: Kind,
    pub purse: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub chef: String,
    pub day_cap: u64,
    pub match_cap: u64,
    pub day: u64,
    pub spent_today: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Offer {
    pub seller_chef: String,
    pub buyer_chef: String,
    pub card: u8,
    pub price: u64,
    pub expires_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Seat {
    /// None for a guest seat (plays, but owns no token, pays and earns nothing)
    pub chef: Option<String>,
    pub name: String,
    pub loadout: Vec<u16>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Match {
    pub referee: AccountId,
    pub seed_hash: String,
    pub seats: Vec<Seat>,
    pub fee: u64,
    pub pot: u64,
    pub ranked: bool,
    pub seals: Vec<String>,
    pub created_ns: U64,
    pub settled: bool,
    pub finals: Vec<i64>,
    pub ranks: Vec<u8>,
    pub payouts: Vec<u64>,
    pub royalties: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Opening {
    pub caster: u8,
    pub target: u8,
    pub card: String,
    pub tick: u32,
    pub salt: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Accusation {
    pub victim: u8,
    pub sab: u32,
    pub accused: u8,
}

/// What the referee reports for each seat at settlement.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SeatReport {
    pub score: i64,
    pub dishes: Vec<u8>,
    pub burns: u32,
}

#[near(serializers = [json])]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub copies: Option<U64>,
    pub extra: Option<String>,
}

#[near(serializers = [json])]
pub struct JsonToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
    pub approved_account_ids: std::collections::HashMap<AccountId, u64>,
}

#[near(serializers = [json])]
pub struct ContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct BoardRow {
    pub chef: String,
    pub name: String,
    pub best: i64,
}

#[near(event_json(standard = "sushi_sabotage"))]
pub enum Event {
    #[event_version("1.0.0")]
    MatchCreated { match_id: String, seed_hash: String, chefs: Vec<Option<String>>, fee: u64, pot: u64, ranked: bool },
    #[event_version("1.0.0")]
    Sealed { match_id: String, from: u32, seals: Vec<String> },
    #[event_version("1.0.0")]
    Settled { match_id: String, seed: String, finals: Vec<i64>, ranks: Vec<u8>, payouts: Vec<u64>, royalties: u64, openings: u32 },
    #[event_version("1.0.0")]
    Receipt { buyer_chef: String, seller_chef: String, item: String, price: u64, by: AccountId },
    #[event_version("1.0.0")]
    Royalty { scroll: String, match_id: String, amount: u64 },
    #[event_version("1.0.0")]
    AgentRegistered { account: AccountId, chef: String, day_cap: u64, match_cap: u64 },
    #[event_version("1.0.0")]
    PurseMoved { from: String, to: String, amount: u64 },
    #[event_version("1.0.0")]
    EnergyUsed { chef: String, match_id: String, energy: u32 },
    #[event_version("1.0.0")]
    EnergyBought { chef: String, by: AccountId, energy: u32, paid: near_sdk::json_types::U128 },
    #[event_version("1.0.0")]
    Upgraded { chef: String, slot: String, level: u8, by: AccountId, paid: near_sdk::json_types::U128 },
    #[event_version("1.0.0")]
    MatchGear { match_id: String, gear: Vec<Vec<u8>> },
    #[event_version("1.0.0")]
    TreasuryWithdrawn { to: AccountId, amount: near_sdk::json_types::U128 },
    #[event_version("1.0.0")]
    Pruned { match_ids: Vec<String> },
}

// NEP-171 events are emitted by hand in the standard's exact shape.
fn nep171(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": [data] })
    ));
}

#[ext_contract(ext_receiver)]
pub trait NonFungibleTokenReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: String, msg: String) -> PromiseOrValue<bool>;
}

#[ext_contract(ext_self)]
pub trait SelfCallbacks {
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool;
}

pub fn seal_of(match_id: &str, o: &Opening) -> String {
    hex::encode(env::sha256_array(format!("{match_id}|{}|{}|{}|{}|{}", o.caster, o.target, o.card, o.tick, o.salt).as_bytes()))
}

pub fn level_of(xp: u64) -> u32 {
    // 1 + floor(sqrt(xp / 50))
    let n = xp / 50;
    let mut l = 0u64;
    while (l + 1) * (l + 1) <= n {
        l += 1;
    }
    1 + l as u32
}

pub fn title_of(level: u32) -> &'static str {
    match level {
        1 => "Dishwasher",
        2..=3 => "Line Cook",
        4..=5 => "Sous Chef",
        6..=8 => "Itamae",
        _ => "Master Itamae",
    }
}

fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= MAX_NAME
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_')
}

fn valid_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Kitchen {
    owner: AccountId,
    referee: AccountId,
    tokens: LookupMap<String, Token>,
    token_ids: Vector<String>,
    owned: LookupMap<AccountId, IterableSet<String>>,
    /// each account's main chef (the one it plays with)
    chef_of: LookupMap<AccountId, String>,
    /// accounts that already minted their free chef
    minted: LookupMap<AccountId, bool>,
    next_chef: u64,
    agents: LookupMap<AccountId, Agent>,
    offers: LookupMap<u64, Offer>,
    next_offer: u64,
    matches: LookupMap<String, Match>,
    season: u32,
    board: IterableMap<String, i64>,
    scroll_of: LookupMap<u8, String>,
    /// energy and gear per chef token (missing = full energy, no gear)
    chef_extra: LookupMap<String, ChefExtra>,
    /// the gear each seat played with, per match (only matches where someone had gear)
    match_gear: LookupMap<String, Vec<Vec<u8>>>,
    /// yoctoNEAR received for energy packs and upgrades, held by this account (econ.rs)
    treasury: u128,
}

/// The state layout before energy and upgrades, exactly as it is stored on testnet. `migrate`
/// reads it and writes the new layout; tokens, matches and every other entry keep their keys.
#[near(serializers = [borsh])]
pub struct KitchenV1 {
    owner: AccountId,
    referee: AccountId,
    tokens: LookupMap<String, Token>,
    token_ids: Vector<String>,
    owned: LookupMap<AccountId, IterableSet<String>>,
    chef_of: LookupMap<AccountId, String>,
    minted: LookupMap<AccountId, bool>,
    next_chef: u64,
    agents: LookupMap<AccountId, Agent>,
    offers: LookupMap<u64, Offer>,
    next_offer: u64,
    matches: LookupMap<String, Match>,
    season: u32,
    board: IterableMap<String, i64>,
    scroll_of: LookupMap<u8, String>,
}

#[near]
impl Kitchen {
    #[init]
    pub fn new(owner: AccountId, referee: AccountId) -> Self {
        Self {
            owner,
            referee,
            tokens: LookupMap::new(Key::Tokens),
            token_ids: Vector::new(Key::TokenIds),
            owned: LookupMap::new(Key::Owned),
            chef_of: LookupMap::new(Key::ChefOf),
            minted: LookupMap::new(Key::Minted),
            next_chef: 0,
            agents: LookupMap::new(Key::Agents),
            offers: LookupMap::new(Key::Offers),
            next_offer: 0,
            matches: LookupMap::new(Key::Matches),
            season: 1,
            board: IterableMap::new(Key::Board { season: 1 }),
            scroll_of: LookupMap::new(Key::Scrolls),
            chef_extra: LookupMap::new(Key::ChefExtra),
            match_gear: LookupMap::new(Key::MatchGear),
            treasury: 0,
        }
    }

    /// One-time upgrade from the v1 layout (deploy with `with-init-call migrate`). Only the root
    /// state struct changes: three fields are added, every collection keeps its prefix, and chefs
    /// without an energy entry read as full energy and no gear. Running it again fails, because the
    /// stored state no longer parses as v1.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
        let old: KitchenV1 = near_sdk::borsh::from_slice(&raw).unwrap_or_else(|_| env::panic_str("state is not the v1 layout (already migrated?)"));
        Self {
            owner: old.owner,
            referee: old.referee,
            tokens: old.tokens,
            token_ids: old.token_ids,
            owned: old.owned,
            chef_of: old.chef_of,
            minted: old.minted,
            next_chef: old.next_chef,
            agents: old.agents,
            offers: old.offers,
            next_offer: old.next_offer,
            matches: old.matches,
            season: old.season,
            board: old.board,
            scroll_of: old.scroll_of,
            chef_extra: LookupMap::new(Key::ChefExtra),
            match_gear: LookupMap::new(Key::MatchGear),
            treasury: 0,
        }
    }

    // ---------- admin ----------

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }
    fn only_referee(&self) {
        require!(env::predecessor_account_id() == self.referee, "only the referee");
    }

    pub fn set_referee(&mut self, referee: AccountId) {
        self.only_owner();
        self.referee = referee;
    }

    /// Creates `{name}.{this contract}` whose only key is a function-call key for the agent methods.
    #[payable]
    pub fn create_agent_account(&mut self, name: String, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(!name.is_empty() && !name.contains('.'), "agent name must be one label");
        let account: AccountId =
            format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("invalid agent name"));
        Promise::new(account).create_account().transfer(env::attached_deposit()).add_access_key_allowance(
            public_key,
            near_sdk::Allowance::limited(AGENT_GAS_ALLOWANCE).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Mints a chef for an agent account and puts it under a spending policy.
    pub fn register_agent(&mut self, account: AccountId, name: String, day_cap: u64, match_cap: u64) -> String {
        self.only_owner();
        let chef = match self.chef_of.get(&account) {
            Some(c) => c.clone(),
            None => self.mint_chef_internal(account.clone(), name),
        };
        self.agents.insert(account.clone(), Agent { chef: chef.clone(), day_cap, match_cap, day: 0, spent_today: 0 });
        Event::AgentRegistered { account, chef: chef.clone(), day_cap, match_cap }.emit();
        chef
    }

    pub fn mint_scroll(&mut self, recipe: u8, to: AccountId) -> String {
        require!(env::predecessor_account_id() == self.owner || env::predecessor_account_id() == self.referee, "only owner or referee");
        require!((recipe as usize) < RECIPE_NAMES.len(), "no such recipe");
        require!(self.scroll_of.get(&recipe).is_none(), "scroll already minted");
        let id = format!("scroll-{recipe}");
        self.insert_token(id.clone(), Token { owner_id: to, kind: Kind::Scroll { recipe, earned: 0 }, purse: 0 });
        self.scroll_of.insert(recipe, id.clone());
        id
    }

    pub fn start_new_season(&mut self) {
        self.only_owner();
        self.board.clear();
        self.season += 1;
        self.board = IterableMap::new(Key::Board { season: self.season });
    }

    // ---------- chefs ----------

    /// Your free chef: one per account, with a starting purse. Callable from a function-call key.
    pub fn mint_chef(&mut self, name: String) -> String {
        let who = env::predecessor_account_id();
        require!(self.minted.get(&who).is_none(), "this account already minted its chef");
        self.mint_chef_internal(who, name)
    }

    /// The referee mints for a player who signed in (e.g. a guest claiming their chef).
    pub fn mint_chef_for(&mut self, owner: AccountId, name: String) -> String {
        self.only_referee();
        require!(self.minted.get(&owner).is_none(), "this account already minted its chef");
        self.mint_chef_internal(owner, name)
    }

    pub fn rename_chef(&mut self, chef: String, name: String) {
        require!(valid_name(&name), "name: 1-20 letters, digits, spaces, - or _");
        let t = self.owned_token_mut(&chef);
        if let Kind::Chef { name: n, .. } = &mut t.kind {
            *n = name;
        } else {
            env::panic_str("not a chef");
        }
    }

    /// The daily faucet: +50 ryo once per UTC day.
    pub fn claim_daily(&mut self, chef: String) -> u64 {
        let day = env::block_timestamp() / DAY_NS;
        let t = self.owned_token_mut(&chef);
        match &mut t.kind {
            Kind::Chef { last_claim_day, .. } => {
                // stored as day + 1, so 0 means never claimed
                require!(*last_claim_day != day + 1, "already claimed today");
                *last_claim_day = day + 1;
            }
            _ => env::panic_str("not a chef"),
        }
        t.purse += FAUCET;
        t.purse
    }

    /// Lets the referee take up to `max_fee` ryo per match from this chef's purse as an entry fee.
    pub fn approve_referee(&mut self, chef: String, max_fee: u64) {
        let t = self.owned_token_mut(&chef);
        match &mut t.kind {
            Kind::Chef { approved_fee, .. } => *approved_fee = max_fee,
            _ => env::panic_str("not a chef"),
        }
    }

    /// Moves ryo between two tokens you own (e.g. a scroll's royalties into your chef).
    pub fn move_purse(&mut self, from: String, to: String, amount: u64) {
        require!(from != to, "same token");
        let who = env::predecessor_account_id();
        let mut a = self.tokens.get(&from).cloned().unwrap_or_else(|| env::panic_str("no such token"));
        let mut b = self.tokens.get(&to).cloned().unwrap_or_else(|| env::panic_str("no such token"));
        require!(a.owner_id == who && b.owner_id == who, "you must own both tokens");
        require!(a.purse >= amount, "not enough ryo");
        a.purse -= amount;
        b.purse += amount;
        self.tokens.insert(from.clone(), a);
        self.tokens.insert(to.clone(), b);
        Event::PurseMoved { from, to, amount }.emit();
    }

    // ---------- the Fixer's market ----------

    /// A seller (the Fixer, or any chef) offers one card to one buyer at a price, for `ttl_secs`.
    pub fn post_offer(&mut self, seller_chef: String, buyer_chef: String, card: String, price: u64, ttl_secs: u32) -> u64 {
        self.owned_token_mut(&seller_chef);
        require!(self.tokens.get(&buyer_chef).map(|t| matches!(t.kind, Kind::Chef { .. })).unwrap_or(false), "no such buyer chef");
        let card = CARDS.iter().position(|c| *c == card).unwrap_or_else(|| env::panic_str("no such card")) as u8;
        require!(price > 0 && ttl_secs > 0 && ttl_secs <= 3600, "bad price or ttl");
        let id = self.next_offer;
        self.next_offer += 1;
        let expires = env::block_timestamp() + ttl_secs as u64 * 1_000_000_000;
        self.offers.insert(id, Offer { seller_chef, buyer_chef, card, price, expires_ns: U64(expires) });
        id
    }

    pub fn accept_offer(&mut self, offer_id: u64) -> u16 {
        let o = self.offers.get(&offer_id).cloned().unwrap_or_else(|| env::panic_str("no such offer"));
        require!(env::block_timestamp() <= o.expires_ns.0, "offer expired");
        self.owned_token_mut(&o.buyer_chef);
        self.spend(&o.buyer_chef, o.price, false);
        let left = {
            let t = self.tokens.get_mut(&o.buyer_chef).unwrap();
            match &mut t.kind {
                Kind::Chef { inventory, .. } => {
                    inventory[o.card as usize] += 1;
                    inventory[o.card as usize]
                }
                _ => unreachable!(),
            }
        };
        self.credit(&o.seller_chef, o.price);
        self.offers.remove(&offer_id);
        let buyer_owner = self.tokens.get(&o.buyer_chef).unwrap().owner_id.clone();
        mt::minted(&buyer_owner, o.card as usize, 1);
        Event::Receipt {
            buyer_chef: o.buyer_chef,
            seller_chef: o.seller_chef,
            item: format!("card:{}", CARDS[o.card as usize]),
            price: o.price,
            by: env::predecessor_account_id(),
        }
        .emit();
        left
    }

    /// Pays a scout chef for a report on another chef (paying for data). The report itself is the
    /// scout's profile of `about_chef`, built from that chef's onchain history.
    pub fn buy_scout(&mut self, buyer_chef: String, scout_chef: String, about_chef: String) {
        self.owned_token_mut(&buyer_chef);
        require!(self.tokens.get(&about_chef).is_some(), "no such chef to scout");
        require!(self.tokens.get(&scout_chef).is_some(), "no such scout");
        self.spend(&buyer_chef, SCOUT_PRICE, false);
        self.credit(&scout_chef, SCOUT_PRICE);
        Event::Receipt {
            buyer_chef,
            seller_chef: scout_chef,
            item: format!("scout:{about_chef}"),
            price: SCOUT_PRICE,
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    // ---------- matches ----------

    /// Opens a match: takes each token seat's entry fee (within its approval and agent caps),
    /// its card loadout (from inventory) and a shift's energy, and records each seat's gear
    /// (`gear`: per seat, one level per slot, checked against the chef; omit for none).
    pub fn create_match(&mut self, match_id: String, seed_hash: String, seats: Vec<Seat>, fee: u64, ranked: bool, gear: Option<Vec<Vec<u8>>>) {
        self.only_referee();
        require!(!match_id.is_empty() && match_id.len() <= 64 && !match_id.contains('|'), "bad match id");
        require!(self.matches.get(&match_id).is_none(), "match exists");
        require!(valid_hex64(&seed_hash), "seed hash must be 64 lowercase hex");
        require!(!seats.is_empty() && seats.len() <= MAX_SEATS, "1-4 seats");
        let mut pot = 0u64;
        let mut seen: Vec<String> = vec![];
        for s in &seats {
            require!(s.loadout.len() == CARDS.len() || s.loadout.is_empty(), "loadout: one count per card");
            let Some(chef) = &s.chef else {
                require!(s.loadout.iter().all(|n| *n == 0), "guest seats bring no cards");
                continue;
            };
            require!(!seen.contains(chef), "a chef can take one seat");
            seen.push(chef.clone());
            let t = self.tokens.get(chef).cloned().unwrap_or_else(|| env::panic_str("no such chef"));
            let Kind::Chef { approved_fee, .. } = &t.kind else { env::panic_str("seat token is not a chef") };
            if fee > 0 {
                require!(*approved_fee >= fee, "entry fee above what the chef's owner approved");
                self.spend(chef, fee, true);
                pot += fee;
            }
            if !s.loadout.is_empty() {
                let t = self.tokens.get_mut(chef).unwrap();
                let owner = t.owner_id.clone();
                if let Kind::Chef { inventory: inv, .. } = &mut t.kind {
                    for (k, n) in s.loadout.iter().enumerate() {
                        require!(inv[k] >= *n, "loadout exceeds the chef's cards");
                        inv[k] -= *n;
                    }
                }
                // cards brought to a match are used up
                for (k, n) in s.loadout.iter().enumerate() {
                    if *n > 0 {
                        mt::burned(&owner, k, *n as u128);
                    }
                }
            }
        }
        self.start_shift_econ(&match_id, &seats, gear, ranked);
        let created = env::block_timestamp();
        Event::MatchCreated {
            match_id: match_id.clone(),
            seed_hash: seed_hash.clone(),
            chefs: seats.iter().map(|s| s.chef.clone()).collect(),
            fee,
            pot,
            ranked,
        }
        .emit();
        self.matches.insert(
            match_id,
            Match {
                referee: env::predecessor_account_id(),
                seed_hash,
                seats,
                fee,
                pot,
                ranked,
                seals: vec![],
                created_ns: U64(created),
                settled: false,
                finals: vec![],
                ranks: vec![],
                payouts: vec![],
                royalties: 0,
            },
        );
    }

    /// Posts sabotage seals in cast order. Each hides caster, target, card and tick until settlement.
    pub fn seal(&mut self, match_id: String, seals: Vec<String>) {
        self.only_referee();
        let m = self.matches.get_mut(&match_id).unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled, "match settled");
        require!(m.seals.len() + seals.len() <= MAX_SEALS, "too many seals");
        require!(seals.iter().all(|s| valid_hex64(s)), "seals must be 64 lowercase hex");
        let from = m.seals.len() as u32;
        m.seals.extend(seals.iter().cloned());
        Event::Sealed { match_id, from, seals }.emit();
    }

    /// Ends a match. Checks the seed and every seal, scores accusations, pays out and updates stats.
    pub fn settle_match(&mut self, match_id: String, seed: String, openings: Vec<Opening>, accusations: Vec<Accusation>, reports: Vec<SeatReport>) {
        self.only_referee();
        let mut m = self.matches.get(&match_id).cloned().unwrap_or_else(|| env::panic_str("no such match"));
        require!(!m.settled, "match already settled");
        let n = m.seats.len();
        require!(hex::encode(env::sha256_array(seed.as_bytes())) == m.seed_hash, "seed does not match its hash");
        require!(openings.len() == m.seals.len(), "every seal must be opened, and nothing else");
        require!(reports.len() == n, "one report per seat");
        for (k, o) in openings.iter().enumerate() {
            require!((o.caster as usize) < n && (o.target as usize) < n, "opening names a seat that isn't in the match");
            require!(CARDS.contains(&o.card.as_str()), "opening names an unknown card");
            require!(seal_of(&match_id, o) == m.seals[k], format!("opening {k} does not match its seal"));
        }
        for r in &reports {
            require!(r.dishes.iter().all(|d| (*d as usize) < RECIPE_NAMES.len()), "unknown recipe in a report");
        }

        // accusations, scored here with the same rule as packages/rules
        let mut delta = vec![0i64; n];
        let mut used = vec![false; openings.len()];
        let mut sleuth = vec![0u32; n];
        let mut caught = vec![0u32; n];
        for a in &accusations {
            let k = a.sab as usize;
            if k >= openings.len() || used[k] {
                continue;
            }
            let o = &openings[k];
            if o.target != a.victim || o.card == "bamboo_shield" || a.accused == a.victim || (a.accused as usize) >= n {
                continue;
            }
            used[k] = true;
            if a.accused == o.caster {
                delta[a.victim as usize] += ACCUSE_RIGHT;
                delta[o.caster as usize] += CAUGHT;
                sleuth[a.victim as usize] += 1;
                caught[o.caster as usize] += 1;
            } else {
                delta[a.victim as usize] += ACCUSE_WRONG;
            }
        }
        let finals: Vec<i64> = (0..n).map(|i| reports[i].score + delta[i]).collect();
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by(|&a, &b| finals[b].cmp(&finals[a]).then(a.cmp(&b)));
        let mut ranks = vec![0u8; n];
        for (r, &i) in order.iter().enumerate() {
            ranks[i] = (r + 1) as u8;
        }

        // royalties to recipe scrolls (ranked only), from the pot
        let mut pot = m.pot;
        let mut royalties = 0u64;
        // scrolls share at most ROYALTY_SHARE % of the pot, so there's always a prize
        let royalty_budget = m.pot * ROYALTY_SHARE / 100;
        if m.ranked {
            for r in &reports {
                for d in &r.dishes {
                    if royalties + ROYALTY > royalty_budget {
                        break;
                    }
                    if let Some(scroll) = self.scroll_of.get(d).cloned() {
                        let t = self.tokens.get_mut(&scroll).unwrap();
                        t.purse += ROYALTY;
                        if let Kind::Scroll { earned, .. } = &mut t.kind {
                            *earned += ROYALTY;
                        }
                        pot -= ROYALTY;
                        royalties += ROYALTY;
                        Event::Royalty { scroll, match_id: match_id.clone(), amount: ROYALTY }.emit();
                    }
                }
            }
        }

        // prizes to the top token seats
        let mut payouts = vec![0u64; n];
        let paid: Vec<usize> = order.iter().copied().filter(|&i| m.seats[i].chef.is_some()).take(3).collect();
        if !paid.is_empty() && pot > 0 {
            let total: u64 = PRIZE_SHARES[..paid.len()].iter().sum();
            let mut left = pot;
            for (k, &i) in paid.iter().enumerate() {
                let share = pot * PRIZE_SHARES[k] / total;
                payouts[i] = share;
                left -= share;
            }
            payouts[paid[0]] += left;
            for &i in &paid {
                self.credit(m.seats[i].chef.as_ref().unwrap(), payouts[i]);
            }
        }

        // stats and the season board
        for i in 0..n {
            let Some(chef) = m.seats[i].chef.clone() else { continue };
            let casts = openings.iter().filter(|o| o.caster as usize == i && o.card != "bamboo_shield").count() as u32;
            let t = self.tokens.get_mut(&chef).unwrap();
            if let Kind::Chef { stats, .. } = &mut t.kind {
                stats.shifts += 1;
                stats.delivered += reports[i].dishes.len() as u32;
                stats.burns += reports[i].burns;
                stats.casts += casts;
                stats.caught += caught[i];
                stats.sleuth += sleuth[i];
                if ranks[i] == 1 && n > 1 {
                    stats.wins += 1;
                }
                if stats.shifts == 1 || finals[i] > stats.best {
                    stats.best = finals[i];
                }
                stats.xp += reports[i].dishes.len() as u64 * 10 + sleuth[i] as u64 * 20 + if ranks[i] == 1 && n > 1 { 50 } else { 0 };
            }
            if m.ranked {
                let best = self.board.get(&chef).copied();
                if best.map(|b| finals[i] > b).unwrap_or(true) {
                    self.board.insert(chef, finals[i]);
                }
            }
        }

        Event::Settled {
            match_id: match_id.clone(),
            seed,
            finals: finals.clone(),
            ranks: ranks.clone(),
            payouts: payouts.clone(),
            royalties,
            openings: openings.len() as u32,
        }
        .emit();
        m.settled = true;
        m.finals = finals;
        m.ranks = ranks;
        m.payouts = payouts;
        m.royalties = royalties;
        m.pot = 0;
        self.matches.insert(match_id, m);
    }

    /// Frees the storage of settled matches at least PRUNE_AFTER_NS old (referee only, up to 50 a
    /// call). Every byte stored locks contract NEAR, and the AI league settles a match every 15
    /// minutes; a pruned match's full record stays in its MatchCreated, Sealed and Settled events.
    /// Unsettled, too-young and unknown ids are skipped. Returns the ids it pruned.
    pub fn prune_matches(&mut self, match_ids: Vec<String>) -> Vec<String> {
        self.only_referee();
        require!(match_ids.len() <= MAX_PRUNE, "at most 50 matches a call");
        let now = env::block_timestamp();
        let mut pruned = vec![];
        for id in match_ids {
            let Some(m) = self.matches.get(&id) else { continue };
            if !m.settled || now < m.created_ns.0.saturating_add(PRUNE_AFTER_NS) {
                continue;
            }
            self.matches.remove(&id);
            self.match_gear.remove(&id);
            pruned.push(id);
        }
        if !pruned.is_empty() {
            Event::Pruned { match_ids: pruned.clone() }.emit();
        }
        pruned
    }

    // ---------- views ----------

    pub fn get_match(&self, match_id: String) -> Option<Match> {
        self.matches.get(&match_id).cloned()
    }
    pub fn get_token(&self, token_id: String) -> Option<Token> {
        self.tokens.get(&token_id).cloned()
    }
    pub fn chef_of(&self, account_id: AccountId) -> Option<String> {
        self.chef_of.get(&account_id).cloned()
    }
    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).cloned()
    }
    pub fn get_offer(&self, offer_id: u64) -> Option<Offer> {
        self.offers.get(&offer_id).cloned()
    }
    pub fn get_referee(&self) -> AccountId {
        self.referee.clone()
    }
    pub fn get_season(&self) -> u32 {
        self.season
    }
    pub fn leaderboard(&self, limit: Option<u32>) -> Vec<BoardRow> {
        let mut rows: Vec<BoardRow> = self
            .board
            .iter()
            .map(|(chef, best)| BoardRow { chef: chef.clone(), name: self.chef_name(chef), best: *best })
            .collect();
        rows.sort_by(|a, b| b.best.cmp(&a.best).then(a.chef.cmp(&b.chef)));
        rows.truncate(limit.unwrap_or(20).min(100) as usize);
        rows
    }

    // ---------- NEP-171 ----------

    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String, approval_id: Option<u64>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_internal(&sender, &receiver_id, &token_id, memo);
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        require!(approval_id.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.transfer_internal(&sender, &receiver_id, &token_id, memo);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).nft_resolve_transfer(sender, receiver_id, token_id))
            .into()
    }

    #[private]
    pub fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: String) -> bool {
        // a receiver that fails or answers garbage gets the token returned
        let return_it = match env::promise_result_checked(0, 16) {
            Ok(v) => serde_json::from_slice::<bool>(&v).unwrap_or(true),
            Err(_) => true,
        };
        if !return_it {
            return true;
        }
        // give it back only if the receiver still holds it
        if self.tokens.get(&token_id).map(|t| t.owner_id == receiver_id).unwrap_or(false) {
            self.move_token(&receiver_id, &previous_owner_id, &token_id);
            nep171("nft_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_id, "token_ids": [token_id] }));
            return false;
        }
        true
    }

    pub fn nft_token(&self, token_id: String) -> Option<JsonToken> {
        self.tokens.get(&token_id).map(|t| self.json_token(&token_id, t))
    }

    pub fn nft_metadata(&self) -> ContractMetadata {
        ContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "Sushi Sabotage".into(),
            symbol: "SUSHI".into(),
            icon: Some(icon_svg()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> near_sdk::json_types::U128 {
        (self.token_ids.len() as u128).into()
    }

    pub fn nft_tokens(&self, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let start = from_index.map(|i| i.0 as u32).unwrap_or(0);
        let lim = limit.unwrap_or(50).min(100) as u32;
        (start..self.token_ids.len().min(start.saturating_add(lim)))
            .filter_map(|i| {
                let id = self.token_ids.get(i)?;
                self.tokens.get(id).map(|t| self.json_token(id, t))
            })
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> near_sdk::json_types::U128 {
        (self.owned.get(&account_id).map(|s| s.len()).unwrap_or(0) as u128).into()
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<JsonToken> {
        let Some(set) = self.owned.get(&account_id) else { return vec![] };
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        set.iter()
            .skip(start)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|id| self.tokens.get(id).map(|t| self.json_token(id, t)))
            .collect()
    }
}

// ---------- internals ----------

impl Kitchen {
    fn mint_chef_internal(&mut self, owner: AccountId, name: String) -> String {
        require!(valid_name(&name), "name: 1-20 letters, digits, spaces, - or _");
        let id = format!("chef-{}", self.next_chef);
        self.next_chef += 1;
        self.minted.insert(owner.clone(), true);
        self.insert_token(
            id.clone(),
            Token {
                owner_id: owner,
                kind: Kind::Chef { name, stats: ChefStats::default(), inventory: vec![0; CARDS.len()], last_claim_day: 0, approved_fee: 0 },
                purse: STARTING_PURSE,
            },
        );
        id
    }

    fn insert_token(&mut self, id: String, t: Token) {
        let owner = t.owner_id.clone();
        let is_chef = matches!(t.kind, Kind::Chef { .. });
        self.tokens.insert(id.clone(), t);
        self.token_ids.push(id.clone());
        self.add_owned(&owner, &id);
        if is_chef && self.chef_of.get(&owner).is_none() {
            self.chef_of.insert(owner.clone(), id.clone());
        }
        nep171("nft_mint", json!({ "owner_id": owner, "token_ids": [id] }));
    }

    fn add_owned(&mut self, owner: &AccountId, id: &str) {
        if self.owned.get(owner).is_none() {
            let set = IterableSet::new(Key::OwnedSet { owner_hash: env::sha256(owner.as_bytes()) });
            self.owned.insert(owner.clone(), set);
        }
        self.owned.get_mut(owner).unwrap().insert(id.to_string());
    }

    fn transfer_internal(&mut self, sender: &AccountId, receiver: &AccountId, token_id: &str, memo: Option<String>) {
        let t = self.tokens.get(token_id).unwrap_or_else(|| env::panic_str("no such token"));
        require!(&t.owner_id == sender, "only the owner can transfer");
        require!(sender != receiver, "already yours");
        // an agent's registered chef stays with the agent: its policy is bound to it
        if let Some(a) = self.agents.get(sender) {
            require!(a.chef != token_id, "an agent's own chef can't be transferred");
        }
        self.move_token(sender, receiver, token_id);
        let mut data = json!({ "old_owner_id": sender, "new_owner_id": receiver, "token_ids": [token_id] });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        nep171("nft_transfer", data);
    }

    fn move_token(&mut self, from: &AccountId, to: &AccountId, token_id: &str) {
        let mut t = self.tokens.get(token_id).cloned().unwrap();
        t.owner_id = to.clone();
        let is_chef = matches!(t.kind, Kind::Chef { .. });
        if let Kind::Chef { approved_fee, .. } = &mut t.kind {
            *approved_fee = 0; // a new owner approves fees themselves
        }
        self.tokens.insert(token_id.to_string(), t);
        if let Some(set) = self.owned.get_mut(from) {
            set.remove(token_id);
        }
        self.add_owned(to, token_id);
        if is_chef {
            if self.chef_of.get(from).map(|c| c == token_id).unwrap_or(false) {
                self.chef_of.remove(from);
                // fall back to another chef the sender still owns
                let other = self.owned.get(from).and_then(|s| {
                    s.iter().find(|id| self.tokens.get(*id).map(|x| matches!(x.kind, Kind::Chef { .. })).unwrap_or(false)).cloned()
                });
                if let Some(o) = other {
                    self.chef_of.insert(from.clone(), o);
                }
            }
            if self.chef_of.get(to).is_none() {
                self.chef_of.insert(to.clone(), token_id.to_string());
            }
        }
    }

    /// The caller must own `token_id`; returns it for editing.
    fn owned_token_mut(&mut self, token_id: &str) -> &mut Token {
        let who = env::predecessor_account_id();
        let t = self.tokens.get_mut(token_id).unwrap_or_else(|| env::panic_str("no such token"));
        require!(t.owner_id == who, "you don't own that token");
        t
    }

    /// Takes ryo from a chef's purse, enforcing the owner's agent policy if it's an agent.
    fn spend(&mut self, chef: &str, amount: u64, entry_fee: bool) {
        let owner = self.tokens.get(chef).map(|t| t.owner_id.clone()).unwrap_or_else(|| env::panic_str("no such chef"));
        if let Some(a) = self.agents.get_mut(&owner) {
            if a.chef == chef {
                let day = env::block_timestamp() / DAY_NS;
                if a.day != day {
                    a.day = day;
                    a.spent_today = 0;
                }
                if entry_fee {
                    require!(amount <= a.match_cap, "agent policy: entry fee over the per-match cap");
                }
                require!(a.spent_today + amount <= a.day_cap, "agent policy: over the daily spending cap");
                a.spent_today += amount;
            }
        }
        let t = self.tokens.get_mut(chef).unwrap();
        require!(t.purse >= amount, "not enough ryo in the purse");
        t.purse -= amount;
    }

    fn credit(&mut self, token_id: &str, amount: u64) {
        let t = self.tokens.get_mut(token_id).unwrap_or_else(|| env::panic_str("no such token"));
        t.purse += amount;
    }

    fn chef_name(&self, chef: &str) -> String {
        match self.tokens.get(chef).map(|t| &t.kind) {
            Some(Kind::Chef { name, .. }) => name.clone(),
            _ => chef.to_string(),
        }
    }

    fn json_token(&self, id: &str, t: &Token) -> JsonToken {
        let metadata = match &t.kind {
            Kind::Chef { name, stats, inventory, .. } => {
                let level = level_of(stats.xp);
                let title = title_of(level);
                let x = self.extra_of(id, env::block_timestamp());
                let extra = json!({
                    "kind": "chef", "purse": t.purse, "level": level, "title": title, "stats": stats,
                    "energy": x.energy, "energy_max": ENERGY_MAX,
                    "gear": GEAR.iter().zip(x.gear.iter()).map(|(g, l)| (g.to_string(), json!(l))).collect::<serde_json::Map<_, _>>(),
                    "inventory": CARDS.iter().zip(inventory.iter()).map(|(c, n)| (c.to_string(), json!(n))).collect::<serde_json::Map<_, _>>(),
                });
                TokenMetadata {
                    title: Some(format!("{name} · {title} · Lv {level}")),
                    description: Some(format!("A Sushi Sabotage chef. Purse {} ryo, {} dishes served, best shift {}.", t.purse, stats.delivered, stats.best)),
                    media: Some(chef_svg(name, title, level, t.purse, stats, &x)),
                    copies: Some(U64(1)),
                    extra: Some(extra.to_string()),
                }
            }
            Kind::Scroll { recipe, earned } => {
                let name = RECIPE_NAMES[*recipe as usize];
                TokenMetadata {
                    title: Some(format!("Recipe Scroll: {name}")),
                    description: Some(format!("Earns {ROYALTY} ryo every time anyone serves {name} in a ranked match. Earned so far: {earned}.")),
                    media: Some(scroll_svg(name, *earned)),
                    copies: Some(U64(1)),
                    extra: Some(json!({ "kind": "scroll", "recipe": recipe, "earned": earned, "purse": t.purse }).to_string()),
                }
            }
        };
        JsonToken { token_id: id.to_string(), owner_id: t.owner_id.clone(), metadata, approved_account_ids: Default::default() }
    }
}

// SVGs are percent-encoded data URIs built from fixed templates; names are restricted to [A-Za-z0-9 _-].
fn data_uri(svg: String) -> String {
    let mut out = String::from("data:image/svg+xml,");
    for b in svg.bytes() {
        match b {
            b'<' => out.push_str("%3C"),
            b'>' => out.push_str("%3E"),
            b'#' => out.push_str("%23"),
            b'"' => out.push('\''),
            b'%' => out.push_str("%25"),
            _ => out.push(b as char),
        }
    }
    out
}

fn chef_svg(name: &str, title: &str, level: u32, purse: u64, s: &ChefStats, x: &ChefExtra) -> String {
    data_uri(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 400\"><rect width=\"320\" height=\"400\" rx=\"24\" fill=\"#1b1420\"/>\
<circle cx=\"160\" cy=\"150\" r=\"70\" fill=\"#f4d6b8\"/><rect x=\"92\" y=\"78\" width=\"136\" height=\"26\" rx=\"8\" fill=\"#e2433b\"/>\
<circle cx=\"135\" cy=\"150\" r=\"8\" fill=\"#1b1420\"/><circle cx=\"185\" cy=\"150\" r=\"8\" fill=\"#1b1420\"/>\
<path d=\"M135 180 Q160 196 185 180\" stroke=\"#1b1420\" stroke-width=\"6\" fill=\"none\"/>\
<text x=\"160\" y=\"260\" font-family=\"sans-serif\" font-size=\"26\" fill=\"#fff3e0\" text-anchor=\"middle\">{name}</text>\
<text x=\"160\" y=\"290\" font-family=\"sans-serif\" font-size=\"16\" fill=\"#ffb547\" text-anchor=\"middle\">{title} - Lv {level}</text>\
<text x=\"160\" y=\"330\" font-family=\"sans-serif\" font-size=\"14\" fill=\"#cdbfd6\" text-anchor=\"middle\">{purse} ryo - {} served - best {}</text>\
<text x=\"160\" y=\"355\" font-family=\"sans-serif\" font-size=\"14\" fill=\"#cdbfd6\" text-anchor=\"middle\">{} sabotages - caught {} - sleuth {}</text>\
<rect x=\"60\" y=\"368\" width=\"200\" height=\"8\" rx=\"4\" fill=\"#3a2c40\"/><rect x=\"60\" y=\"368\" width=\"{}\" height=\"8\" rx=\"4\" fill=\"#7ee08a\"/>\
<text x=\"160\" y=\"392\" font-family=\"sans-serif\" font-size=\"12\" fill=\"#cdbfd6\" text-anchor=\"middle\">energy {} - knife {} pan {} sandals {} apron {}</text></svg>",
        s.delivered, s.best, s.casts, s.caught, s.sleuth,
        x.energy as u64 * 200 / ENERGY_MAX as u64, x.energy, x.gear[0], x.gear[1], x.gear[2], x.gear[3]
    ))
}

fn scroll_svg(name: &str, earned: u64) -> String {
    data_uri(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 400\"><rect width=\"320\" height=\"400\" rx=\"24\" fill=\"#2a1d12\"/>\
<rect x=\"40\" y=\"40\" width=\"240\" height=\"320\" rx=\"12\" fill=\"#f1e2c2\"/><rect x=\"30\" y=\"30\" width=\"260\" height=\"20\" rx=\"10\" fill=\"#8a5a2b\"/>\
<rect x=\"30\" y=\"350\" width=\"260\" height=\"20\" rx=\"10\" fill=\"#8a5a2b\"/>\
<text x=\"160\" y=\"190\" font-family=\"serif\" font-size=\"24\" fill=\"#3a2614\" text-anchor=\"middle\">{name}</text>\
<text x=\"160\" y=\"230\" font-family=\"sans-serif\" font-size=\"15\" fill=\"#8a5a2b\" text-anchor=\"middle\">earned {earned} ryo</text></svg>"
    ))
}

fn icon_svg() -> String {
    data_uri("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><circle cx=\"32\" cy=\"32\" r=\"30\" fill=\"#1b1420\"/><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"#fff\"/><circle cx=\"32\" cy=\"32\" r=\"10\" fill=\"#e2433b\"/></svg>".to_string())
}
