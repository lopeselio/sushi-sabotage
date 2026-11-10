//! Energy, upgrades, the treasury, and the migration from the v1 layout (with live testnet bytes).
use super::*;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const SEC: u64 = 1_000_000_000;
const T0: u64 = 1_800_000_000 * SEC;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(who: &str, ns: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("kitchen.testnet"))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(ns)
        .attached_deposit(deposit);
    testing_env!(b.build());
}
fn ctx(who: &str) {
    at(who, T0, NearToken::from_yoctonear(0));
}

fn sha(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}

fn setup() -> Kitchen {
    ctx("owner.testnet");
    Kitchen::new(acc("owner.testnet"), acc("ref.testnet"))
}

fn chef(k: &mut Kitchen, who: &str) -> String {
    ctx(who);
    k.mint_chef("Alice".into())
}

fn seat(c: &str) -> Seat {
    Seat { chef: Some(c.into()), name: c.into(), loadout: vec![] }
}

fn shift(k: &mut Kitchen, id: &str, seats: Vec<Seat>, ranked: bool, gear: Option<Vec<Vec<u8>>>, ns: u64) {
    at("ref.testnet", ns, NearToken::from_yoctonear(0));
    k.create_match(id.into(), sha(id), seats, 0, ranked, gear);
}

fn set_xp(k: &mut Kitchen, c: &str, xp: u64) {
    if let Kind::Chef { stats, .. } = &mut k.tokens.get_mut(c).unwrap().kind {
        stats.xp = xp;
    }
}

#[test]
fn a_new_chef_has_full_energy_and_a_shift_costs_100() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    let c = k.get_chef(a.clone()).unwrap();
    assert_eq!((c.energy, c.energy_max, c.gear.clone(), c.can_play), (ENERGY_MAX, 1000, vec![0, 0, 0, 0], true));
    shift(&mut k, "m1", vec![seat(&a)], false, None, T0);
    assert!(get_logs().iter().any(|l| l.contains("energy_used") && l.contains("\"energy\":900")));
    assert_eq!(k.get_chef(a).unwrap().energy, 900);
    assert!(k.get_match_gear("m1".into()).is_none());
}

#[test]
fn energy_regenerates_100_an_hour_from_block_time_up_to_the_cap() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    for n in 0..5 {
        shift(&mut k, &format!("m{n}"), vec![seat(&a)], false, None, T0);
    }
    assert_eq!(k.get_chef(a.clone()).unwrap().energy, 500);
    // 50 points and a bit later: the part-point is kept for the next one
    at("x.testnet", T0 + 50 * 36 * SEC + 20 * SEC, NearToken::from_yoctonear(0));
    let c = k.get_chef(a.clone()).unwrap();
    assert_eq!((c.energy, c.next_energy_secs), (550, 16));
    shift(&mut k, "m5", vec![seat(&a)], false, None, T0 + 50 * 36 * SEC + 20 * SEC);
    at("x.testnet", T0 + 51 * 36 * SEC, NearToken::from_yoctonear(0));
    assert_eq!(k.get_chef(a.clone()).unwrap().energy, 451);
    // a day later it's full, and no more
    at("x.testnet", T0 + 86_400 * SEC, NearToken::from_yoctonear(0));
    let c = k.get_chef(a).unwrap();
    assert_eq!((c.energy, c.next_energy_secs), (ENERGY_MAX, 0));
}

#[test]
#[should_panic(expected = "out of energy")]
fn an_empty_chef_cannot_start_a_recorded_shift() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    for n in 0..11 {
        shift(&mut k, &format!("m{n}"), vec![seat(&a)], false, None, T0);
    }
}

#[test]
fn agents_chefs_and_guests_use_no_energy() {
    let mut k = setup();
    ctx("owner.testnet");
    let kenji = k.register_agent(acc("kenji.kitchen.testnet"), "Kenji".into(), 100, 10);
    for n in 0..15 {
        shift(&mut k, &format!("m{n}"), vec![seat(&kenji), Seat { chef: None, name: "Guest".into(), loadout: vec![] }], false, None, T0);
    }
    assert_eq!(k.get_chef(kenji).unwrap().energy, ENERGY_MAX);
}

#[test]
fn an_energy_pack_costs_exactly_a_tenth_of_a_near_and_goes_to_the_treasury() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    for n in 0..4 {
        shift(&mut k, &format!("m{n}"), vec![seat(&a)], false, None, T0);
    }
    at("alice.testnet", T0, ENERGY_PACK_PRICE);
    assert_eq!(k.buy_energy(a.clone()), 900);
    assert!(get_logs().iter().any(|l| l.contains("energy_bought") && l.contains("100000000000000000000000")));
    assert_eq!(k.get_economy().treasury, U128(ENERGY_PACK_PRICE.as_yoctonear()));
    // bought energy can pass the regen cap, but not stack while above it
    assert_eq!(k.get_chef(a.clone()).unwrap().energy, 900);
    at("alice.testnet", T0 + 3600 * SEC, ENERGY_PACK_PRICE);
    assert_eq!(k.buy_energy(a.clone()), 1300);
    at("x.testnet", T0 + 7200 * SEC, NearToken::from_yoctonear(0));
    assert_eq!(k.get_chef(a.clone()).unwrap().energy, 1300); // no regen above full
    let full = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        at("alice.testnet", T0, ENERGY_PACK_PRICE);
        k.buy_energy(a.clone())
    }));
    assert!(full.is_err());
    assert_eq!(k.get_economy().treasury, U128(2 * ENERGY_PACK_PRICE.as_yoctonear()));
}

#[test]
#[should_panic(expected = "exactly 0.1 NEAR")]
fn an_energy_pack_needs_the_exact_price() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    at("alice.testnet", T0, NearToken::from_millinear(50));
    k.buy_energy(a);
}

#[test]
#[should_panic(expected = "don't own")]
fn only_the_owner_buys_for_a_chef() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    at("mallory.testnet", T0, NearToken::from_millinear(50));
    k.buy_upgrade(a, "knife".into());
}

#[test]
fn upgrades_cost_near_rise_in_price_and_need_chef_levels() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    at("alice.testnet", T0, NearToken::from_millinear(80));
    assert_eq!(k.buy_upgrade(a.clone(), "knife".into()), 1);
    // only the price is counted; the 0.03 NEAR change goes back to the buyer
    assert_eq!(k.get_economy().treasury, U128(NearToken::from_millinear(50).as_yoctonear()));
    assert!(get_logs().iter().any(|l| l.contains("upgraded") && l.contains("\"slot\":\"knife\"") && l.contains("\"level\":1")));
    // level 2 needs a level-2 chef (50 xp)
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        at("alice.testnet", T0, NearToken::from_millinear(100));
        k.buy_upgrade(a.clone(), "knife".into())
    }));
    assert!(early.is_err());
    set_xp(&mut k, &a, 50);
    let cheap = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        at("alice.testnet", T0, NearToken::from_millinear(99));
        k.buy_upgrade(a.clone(), "knife".into())
    }));
    assert!(cheap.is_err());
    at("alice.testnet", T0, NearToken::from_millinear(100));
    assert_eq!(k.buy_upgrade(a.clone(), "knife".into()), 2);
    let c = k.get_chef(a.clone()).unwrap();
    assert_eq!(c.gear, vec![2, 0, 0, 0]);
    let next = c.next_gear[0].as_ref().unwrap();
    assert_eq!((next.level, next.price, next.chef_level), (3, U128(NearToken::from_millinear(200).as_yoctonear()), 3));
    // all the way up with a high-level chef
    set_xp(&mut k, &a, 5000);
    for (lvl, milli) in [(3u8, 200u128), (4, 300), (5, 500)] {
        at("alice.testnet", T0, NearToken::from_millinear(milli));
        assert_eq!(k.buy_upgrade(a.clone(), "knife".into()), lvl);
    }
    assert!(k.get_chef(a.clone()).unwrap().next_gear[0].is_none());
    let top = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        at("alice.testnet", T0, NearToken::from_near(1));
        k.buy_upgrade(a.clone(), "knife".into())
    }));
    assert!(top.is_err());
    assert_eq!(k.get_economy().treasury, U128(NearToken::from_millinear(50 + 100 + 200 + 300 + 500).as_yoctonear()));
}

#[test]
fn gear_is_checked_against_the_chef_capped_in_ranked_and_recorded() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    set_xp(&mut k, &a, 5000);
    for slot in ["pan", "pan", "pan", "pan", "sandals"] {
        at("alice.testnet", T0, NearToken::from_near(1));
        k.buy_upgrade(a.clone(), slot.into());
    }
    let guest = Seat { chef: None, name: "Guest".into(), loadout: vec![] };
    shift(&mut k, "u1", vec![seat(&a), guest.clone()], false, Some(vec![vec![0, 4, 1, 0], vec![]]), T0);
    assert_eq!(k.get_match_gear("u1".into()), Some(vec![vec![0, 4, 1, 0], vec![0, 0, 0, 0]]));
    assert!(get_logs().iter().any(|l| l.contains("match_gear")));
    // a ranked match can't use more than level 3, an upgrade the chef doesn't own, or gear on a guest
    for (id, ranked, g) in [
        ("r1", true, vec![vec![0, 4, 0, 0], vec![]]),
        ("r2", false, vec![vec![1, 0, 0, 0], vec![]]),
        ("r3", false, vec![vec![0, 0, 0, 0], vec![0, 1, 0, 0]]),
        ("r4", false, vec![vec![0, 1, 0, 0]]),
    ] {
        let seats = vec![seat(&a), guest.clone()];
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| shift(&mut k, id, seats, ranked, Some(g), T0)));
        assert!(r.is_err(), "{id} should be refused");
    }
    shift(&mut k, "r5", vec![seat(&a), guest], true, Some(vec![vec![0, 3, 1, 0], vec![]]), T0);
    assert_eq!(k.get_match_gear("r5".into()).unwrap()[0], vec![0, 3, 1, 0]);
}

#[test]
fn energy_and_gear_go_with_the_token_and_show_in_its_metadata() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    at("alice.testnet", T0, NearToken::from_millinear(50));
    k.buy_upgrade(a.clone(), "apron".into());
    shift(&mut k, "m1", vec![seat(&a)], false, None, T0);
    at("alice.testnet", T0, NearToken::from_yoctonear(1));
    k.nft_transfer(acc("bob.testnet"), a.clone(), None, None);
    let c = k.get_chef(a.clone()).unwrap();
    assert_eq!((c.energy, c.gear), (900, vec![0, 0, 0, 1]));
    let extra = k.nft_token(a).unwrap().metadata.extra.unwrap();
    assert!(extra.contains("\"energy\":900") && extra.contains("\"apron\":1"), "{extra}");
}

#[test]
fn only_the_owner_withdraws_and_never_more_than_the_treasury() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet");
    at("alice.testnet", T0, NearToken::from_millinear(50));
    k.buy_upgrade(a, "knife".into());
    let half = U128(NearToken::from_millinear(25).as_yoctonear());
    let thief = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("alice.testnet");
        k.withdraw_treasury(acc("alice.testnet"), half)
    }));
    assert!(thief.is_err());
    let too_much = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("owner.testnet");
        k.withdraw_treasury(acc("owner.testnet"), U128(NearToken::from_millinear(51).as_yoctonear()))
    }));
    assert!(too_much.is_err());
    ctx("owner.testnet");
    k.withdraw_treasury(acc("relay.testnet"), half);
    assert_eq!(k.get_economy().treasury, half);
}

// ---------- migration ----------

/// `STATE` of sushi-sabotage.testnet at block 277042280, before this upgrade (view_state, prefix "STATE").
const LIVE_STATE: &str = "1600000073757368692d7361626f746167652e746573746e65741a00000073757368692d7361626f746167652d7265662e746573746e657401000000001d0000000100000001010000000201000000040100000005090000000000000001000000060100000007350000000000000001000000080100000007000000060000000901000000760600000009010000006d010000000a";
/// Token entries from the same account: chef-0 (Kenji, an agent), chef-8 (the e2e player), scroll-3.
const LIVE_TOKENS: [(&str, &str); 3] = [
    ("chef-0", "1c0000006b656e6a692e73757368692d7361626f746167652e746573746e657400050000004b656e6a6959000000d20200000000000059010000a1000000190100004d000000160300000000000032410000000000000600000000000000000000000000000020510000000000000a000000000000006800000000000000"),
    ("chef-8", "1a00000073757368692d6532652d6d773878666a63362e746573746e6574000800000045324520436865660100000000000000000000000100000000000000000000000000000097ffffffffffffff0000000000000000060000000000000000000000000000001f510000000000000a000000000000007800000000000000"),
    ("scroll-3", "1c0000006b656e6a692e73757368692d7361626f746167652e746573746e6574010300000000000000000000000000000000"),
];

fn token_key(id: &str) -> Vec<u8> {
    // LookupMap<String, Token> under Key::Tokens (prefix [0]) with the borsh-encoded id
    let mut k = vec![0u8];
    k.extend((id.len() as u32).to_le_bytes());
    k.extend(id.as_bytes());
    k
}

fn load_live_state() {
    at("sushi-sabotage.testnet", T0, NearToken::from_yoctonear(0));
    env::storage_write(b"STATE", &hex::decode(LIVE_STATE).unwrap());
    for (id, v) in LIVE_TOKENS {
        env::storage_write(&token_key(id), &hex::decode(v).unwrap());
    }
}

#[test]
fn the_live_v1_state_parses_as_the_old_layout() {
    load_live_state();
    let raw = env::storage_read(b"STATE").unwrap();
    let old: KitchenV1 = near_sdk::borsh::from_slice(&raw).unwrap();
    assert_eq!(old.owner, acc("sushi-sabotage.testnet"));
    assert_eq!(old.referee, acc("sushi-sabotage-ref.testnet"));
    assert_eq!((old.next_chef, old.next_offer, old.season, old.token_ids.len()), (9, 53, 1, 29));
    // and the new layout can't be read from it, so the contract really needs `migrate`
    assert!(near_sdk::borsh::from_slice::<Kitchen>(&raw).is_err());
}

#[test]
fn migrate_keeps_every_token_and_adds_energy_gear_and_the_treasury() {
    load_live_state();
    let mut k = Kitchen::migrate();
    assert_eq!(k.get_referee(), acc("sushi-sabotage-ref.testnet"));
    assert_eq!(k.get_season(), 1);
    assert_eq!(k.nft_total_supply(), U128(29));
    let kenji = k.get_token("chef-0".into()).unwrap();
    assert_eq!(kenji.owner_id, acc("kenji.sushi-sabotage.testnet"));
    let Kind::Chef { name, stats, .. } = &kenji.kind else { panic!("chef-0 is a chef") };
    assert_eq!(name, "Kenji");
    let e2e = k.get_token("chef-8".into()).unwrap();
    let Kind::Chef { name, stats: s8, .. } = &e2e.kind else { panic!("chef-8 is a chef") };
    assert_eq!((name.as_str(), s8.shifts, s8.best), ("E2E Chef", 1, -105));
    assert!(matches!(k.get_token("scroll-3".into()).unwrap().kind, Kind::Scroll { recipe: 3, .. }));
    // existing chefs start full, with no gear; the treasury starts empty
    let c = k.get_chef("chef-8".into()).unwrap();
    assert_eq!((c.energy, c.gear.clone(), c.level), (ENERGY_MAX, vec![0, 0, 0, 0], level_of(s8.xp)));
    assert_eq!(k.get_chef("chef-0".into()).unwrap().level, level_of(stats.xp));
    assert_eq!(k.get_economy().treasury, U128(0));
    assert!(k.nft_token("chef-8".into()).unwrap().metadata.extra.unwrap().contains("\"energy\":1000"));
    // the next mint continues the old numbering, and the new features work on old chefs
    at("newbie.testnet", T0, NearToken::from_yoctonear(0));
    assert_eq!(k.mint_chef("Newbie".into()), "chef-9");
    at("sushi-e2e-mw8xfjc6.testnet", T0, NearToken::from_millinear(50));
    assert_eq!(k.buy_upgrade("chef-8".into(), "pan".into()), 1);
    at("sushi-e2e-mw8xfjc6.testnet", T0, NearToken::from_yoctonear(0));
    // writing the new state back (collections flush when dropped) and reading it again round-trips
    near_sdk::env::state_write(&k);
    drop(k);
    let back: Kitchen = near_sdk::env::state_read().unwrap();
    assert_eq!(back.get_chef("chef-8".into()).unwrap().gear, vec![0, 1, 0, 0]);
}

#[test]
#[should_panic(expected = "not the v1 layout")]
fn migrate_runs_only_once() {
    load_live_state();
    let k = Kitchen::migrate();
    near_sdk::env::state_write(&k);
    Kitchen::migrate();
}
