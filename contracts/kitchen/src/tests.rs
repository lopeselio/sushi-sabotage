use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::json_types::U128;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("kitchen.testnet")).predecessor_account_id(acc(who)).signer_account_id(acc(who));
    testing_env!(b.build());
}

fn ctx_yocto(who: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("kitchen.testnet")).predecessor_account_id(acc(who)).attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
}

fn sha(s: &str) -> String {
    hex::encode(env::sha256_array(s.as_bytes()))
}

fn setup() -> Kitchen {
    ctx("owner.testnet");
    Kitchen::new(acc("owner.testnet"), acc("ref.testnet"))
}

fn chef(k: &mut Kitchen, who: &str, name: &str) -> String {
    ctx(who);
    k.mint_chef(name.into())
}

fn seat(c: &str) -> Seat {
    Seat { chef: Some(c.into()), name: c.into(), loadout: vec![] }
}

fn report(score: i64, dishes: Vec<u8>) -> SeatReport {
    SeatReport { score, dishes, burns: 0 }
}

#[test]
fn mint_one_chef_per_account_with_a_purse() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet", "Alice");
    assert_eq!(a, "chef-0");
    assert_eq!(k.get_token(a.clone()).unwrap().purse, STARTING_PURSE);
    assert_eq!(k.chef_of(acc("alice.testnet")), Some(a));
    assert!(get_logs().iter().any(|l| l.contains("nft_mint")));
}

#[test]
#[should_panic(expected = "already minted")]
fn second_mint_fails() {
    let mut k = setup();
    chef(&mut k, "alice.testnet", "Alice");
    chef(&mut k, "alice.testnet", "Alice2");
}

#[test]
#[should_panic(expected = "name")]
fn bad_names_rejected() {
    let mut k = setup();
    chef(&mut k, "alice.testnet", "<script>");
}

#[test]
fn daily_faucet_once_per_day() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet", "Alice");
    ctx("alice.testnet");
    assert_eq!(k.claim_daily(a.clone()), STARTING_PURSE + FAUCET);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("alice.testnet");
        k.claim_daily(a.clone())
    }));
    assert!(r.is_err());
}

#[test]
fn transfer_moves_purse_stats_and_main_chef() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet", "Alice");
    ctx_yocto("alice.testnet");
    k.nft_transfer(acc("bob.testnet"), a.clone(), None, None);
    assert_eq!(k.get_token(a.clone()).unwrap().owner_id, acc("bob.testnet"));
    assert_eq!(k.get_token(a.clone()).unwrap().purse, STARTING_PURSE);
    assert_eq!(k.chef_of(acc("bob.testnet")), Some(a.clone()));
    assert_eq!(k.chef_of(acc("alice.testnet")), None);
    assert_eq!(k.nft_tokens_for_owner(acc("bob.testnet"), None, None).len(), 1);
}

#[test]
fn fixer_offer_sells_a_card_with_receipt() {
    let mut k = setup();
    let fixer = chef(&mut k, "fixer.kitchen.testnet", "The Fixer");
    let a = chef(&mut k, "alice.testnet", "Alice");
    ctx("fixer.kitchen.testnet");
    let id = k.post_offer(fixer.clone(), a.clone(), "wasabi_bomb".into(), 24, 60);
    ctx("alice.testnet");
    assert_eq!(k.accept_offer(id), 1);
    assert_eq!(k.get_token(a.clone()).unwrap().purse, STARTING_PURSE - 24);
    assert_eq!(k.get_token(fixer).unwrap().purse, STARTING_PURSE + 24);
    assert!(get_logs().iter().any(|l| l.contains("receipt") && l.contains("card:wasabi_bomb")));
    assert!(k.get_offer(id).is_none());
}

#[test]
#[should_panic(expected = "daily spending cap")]
fn agent_caps_are_enforced() {
    let mut k = setup();
    ctx("owner.testnet");
    let kenji = k.register_agent(acc("kenji.kitchen.testnet"), "Kenji".into(), 30, 10);
    let fixer = chef(&mut k, "fixer.kitchen.testnet", "The Fixer");
    for price in [20u64, 20] {
        ctx("fixer.kitchen.testnet");
        let id = k.post_offer(fixer.clone(), kenji.clone(), "soy_slick".into(), price, 60);
        ctx("kenji.kitchen.testnet");
        k.accept_offer(id);
    }
}

#[test]
#[should_panic(expected = "per-match cap")]
fn agent_match_cap() {
    let mut k = setup();
    ctx("owner.testnet");
    let kenji = k.register_agent(acc("kenji.kitchen.testnet"), "Kenji".into(), 100, 10);
    ctx("kenji.kitchen.testnet");
    k.approve_referee(kenji.clone(), 50);
    ctx("ref.testnet");
    k.create_match("m1".into(), sha("seed"), vec![seat(&kenji)], 20, true, None);
}

#[test]
#[should_panic(expected = "approved")]
fn fee_needs_owner_approval() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet", "Alice");
    ctx("ref.testnet");
    k.create_match("m1".into(), sha("seed"), vec![seat(&a)], 10, true, None);
}

fn two_chef_match(k: &mut Kitchen) -> (String, String) {
    let a = chef(k, "alice.testnet", "Alice");
    let b = chef(k, "bob.testnet", "Bob");
    for (who, c) in [("alice.testnet", &a), ("bob.testnet", &b)] {
        ctx(who);
        k.approve_referee(c.clone(), 10);
    }
    ctx("ref.testnet");
    k.create_match("m1".into(), sha("seed"), vec![seat(&a), seat(&b)], 10, true, None);
    (a, b)
}

#[test]
fn full_match_settles_with_seals_accusations_royalties_and_prizes() {
    let mut k = setup();
    let (a, b) = two_chef_match(&mut k);
    ctx("owner.testnet");
    let scroll = k.mint_scroll(0, acc("carol.testnet"));
    let o = Opening { caster: 0, target: 1, card: "wasabi_bomb".into(), tick: 400, salt: "s1".into() };
    ctx("ref.testnet");
    k.seal("m1".into(), vec![seal_of("m1", &o)]);
    k.settle_match(
        "m1".into(),
        "seed".into(),
        vec![o],
        vec![Accusation { victim: 1, sab: 0, accused: 0 }],
        vec![report(200, vec![0, 0, 3]), report(150, vec![1])],
    );
    let m = k.get_match("m1".into()).unwrap();
    assert!(m.settled);
    // Alice 200 - 40 caught = 160, Bob 150 + 40 = 190
    assert_eq!(m.finals, vec![160, 190]);
    assert_eq!(m.ranks, vec![2, 1]);
    // pot 20; two Azure Fin dishes pay the scroll 4
    assert_eq!(m.royalties, 4);
    assert_eq!(k.get_token(scroll).unwrap().purse, 4);
    // 16 left: Bob 60/90 -> 10 + dust, Alice 30/90 -> 5
    assert_eq!(m.payouts[0] + m.payouts[1], 16);
    assert!(m.payouts[1] > m.payouts[0]);
    let Kind::Chef { stats, .. } = k.get_token(b.clone()).unwrap().kind else { panic!() };
    assert_eq!((stats.wins, stats.sleuth, stats.delivered), (1, 1, 1));
    let Kind::Chef { stats, .. } = k.get_token(a.clone()).unwrap().kind else { panic!() };
    assert_eq!((stats.caught, stats.casts), (1, 1));
    let board = k.leaderboard(None);
    assert_eq!(board[0].chef, b);
}

#[test]
#[should_panic(expected = "does not match its seal")]
fn tampered_opening_rejected() {
    let mut k = setup();
    two_chef_match(&mut k);
    let o = Opening { caster: 0, target: 1, card: "wasabi_bomb".into(), tick: 400, salt: "s1".into() };
    ctx("ref.testnet");
    k.seal("m1".into(), vec![seal_of("m1", &o)]);
    let lie = Opening { caster: 1, ..o };
    k.settle_match("m1".into(), "seed".into(), vec![lie], vec![], vec![report(0, vec![]), report(0, vec![])]);
}

#[test]
#[should_panic(expected = "every seal must be opened")]
fn unopened_seal_rejected() {
    let mut k = setup();
    two_chef_match(&mut k);
    let o = Opening { caster: 0, target: 1, card: "soy_slick".into(), tick: 1, salt: "x".into() };
    ctx("ref.testnet");
    k.seal("m1".into(), vec![seal_of("m1", &o)]);
    k.settle_match("m1".into(), "seed".into(), vec![], vec![], vec![report(0, vec![]), report(0, vec![])]);
}

#[test]
#[should_panic(expected = "seed does not match")]
fn wrong_seed_rejected() {
    let mut k = setup();
    two_chef_match(&mut k);
    ctx("ref.testnet");
    k.settle_match("m1".into(), "other".into(), vec![], vec![], vec![report(0, vec![]), report(0, vec![])]);
}

#[test]
#[should_panic(expected = "only the referee")]
fn only_referee_settles() {
    let mut k = setup();
    two_chef_match(&mut k);
    ctx("alice.testnet");
    k.settle_match("m1".into(), "seed".into(), vec![], vec![], vec![report(0, vec![]), report(0, vec![])]);
}

#[test]
fn loadout_comes_out_of_inventory() {
    let mut k = setup();
    let fixer = chef(&mut k, "fixer.kitchen.testnet", "The Fixer");
    let a = chef(&mut k, "alice.testnet", "Alice");
    ctx("fixer.kitchen.testnet");
    let id = k.post_offer(fixer, a.clone(), "fish_swap".into(), 10, 60);
    ctx("alice.testnet");
    k.accept_offer(id);
    ctx("ref.testnet");
    k.create_match("m2".into(), sha("s"), vec![Seat { chef: Some(a.clone()), name: "Alice".into(), loadout: vec![0, 1, 0, 0, 0, 0] }], 0, false, None);
    let Kind::Chef { inventory, .. } = k.get_token(a).unwrap().kind else { panic!() };
    assert_eq!(inventory[1], 0);
}

#[test]
fn dynamic_metadata_reflects_stats() {
    let mut k = setup();
    let a = chef(&mut k, "alice.testnet", "Alice");
    let t = k.nft_token(a).unwrap();
    assert_eq!(t.metadata.title.as_deref(), Some("Alice · Dishwasher · Lv 1"));
    assert!(t.metadata.media.unwrap().starts_with("data:image/svg+xml,"));
    assert!(t.metadata.extra.unwrap().contains("\"purse\":100"));
    assert_eq!(level_of(50 * 9), 4);
}

#[test]
fn royalties_never_take_more_than_their_share() {
    let mut k = setup();
    let (_a, _b) = two_chef_match(&mut k);
    ctx("owner.testnet");
    k.mint_scroll(0, acc("carol.testnet"));
    ctx("ref.testnet");
    // 20 Azure Fin dishes would be 40 ryo of royalties; the pot is 20, scrolls get at most 30% = 6
    k.settle_match("m1".into(), "seed".into(), vec![], vec![], vec![report(100, vec![0; 20]), report(50, vec![])]);
    let m = k.get_match("m1".into()).unwrap();
    assert_eq!(m.royalties, 6);
    assert_eq!(m.payouts.iter().sum::<u64>(), 14);
}

fn buy_card(k: &mut Kitchen, buyer_acct: &str, buyer: &str, card: &str) {
    ctx("fixer.kitchen.testnet");
    let fixer = k.chef_of(acc("fixer.kitchen.testnet")).unwrap();
    let id = k.post_offer(fixer, buyer.into(), card.into(), 5, 60);
    ctx(buyer_acct);
    k.accept_offer(id);
}

#[test]
fn cards_are_nep245_tokens() {
    let mut k = setup();
    chef(&mut k, "fixer.kitchen.testnet", "The Fixer");
    let a = chef(&mut k, "alice.testnet", "Alice");
    let _b = chef(&mut k, "bob.testnet", "Bob");
    buy_card(&mut k, "alice.testnet", &a, "soy_slick");
    buy_card(&mut k, "alice.testnet", &a, "soy_slick");
    assert!(get_logs().iter().any(|l| l.contains("nep245") && l.contains("mt_mint")));
    assert_eq!(k.mt_balance_of(acc("alice.testnet"), "soy_slick".into()).0, 2);
    assert_eq!(k.mt_supply("soy_slick".into()).unwrap().0, 2);
    ctx_yocto("alice.testnet");
    k.mt_transfer(acc("bob.testnet"), "soy_slick".into(), U128(1), None, None);
    assert!(get_logs().iter().any(|l| l.contains("mt_transfer")));
    assert_eq!(k.mt_batch_balance_of(acc("bob.testnet"), vec!["soy_slick".into(), "fish_swap".into()]).iter().map(|x| x.0).collect::<Vec<_>>(), vec![1, 0]);
    // using a card in a match burns it
    ctx("ref.testnet");
    k.create_match("m3".into(), sha("s"), vec![Seat { chef: Some(a.clone()), name: "Alice".into(), loadout: vec![0, 0, 0, 1, 0, 0] }], 0, false, None);
    assert_eq!(k.mt_supply("soy_slick".into()).unwrap().0, 1);
    assert!(get_logs().iter().any(|l| l.contains("mt_burn")));
}

#[test]
#[should_panic(expected = "not enough cards")]
fn cannot_send_cards_you_dont_have() {
    let mut k = setup();
    chef(&mut k, "alice.testnet", "Alice");
    chef(&mut k, "bob.testnet", "Bob");
    ctx_yocto("alice.testnet");
    k.mt_transfer(acc("bob.testnet"), "wasabi_bomb".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "no chef")]
fn cards_need_a_chef_to_land_on() {
    let mut k = setup();
    chef(&mut k, "fixer.kitchen.testnet", "The Fixer");
    let a = chef(&mut k, "alice.testnet", "Alice");
    buy_card(&mut k, "alice.testnet", &a, "dull_knife");
    ctx_yocto("alice.testnet");
    k.mt_transfer(acc("nobody.testnet"), "dull_knife".into(), U128(1), None, None);
}
