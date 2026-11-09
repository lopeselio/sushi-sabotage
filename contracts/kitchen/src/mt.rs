//! NEP-245 multi-token view of the sabotage cards.
//!
//! Each of the six cards is a fungible token id ("wasabi_bomb", …). An account's balance is the
//! card inventory of its main Chef NFT, so cards can be traded between players with standard
//! multi-token calls, and a chef sold with `nft_transfer` still takes its cards with it.
//! Cards are minted when bought from the Fixer and burned when brought into a match.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseOrValue};

use crate::{Kind, Kitchen, KitchenExt, CARDS};

const GAS_FOR_MT_RESOLVE: Gas = Gas::from_tgas(20);
const GAS_FOR_MT_ON_TRANSFER: Gas = Gas::from_tgas(35);

fn supply_key(card: usize) -> Vec<u8> {
    format!("mts:{card}").into_bytes()
}
fn supply(card: usize) -> u128 {
    env::storage_read(&supply_key(card)).map(|b| u128::from_le_bytes(b.try_into().unwrap_or([0; 16]))).unwrap_or(0)
}
fn set_supply(card: usize, v: u128) {
    env::storage_write(&supply_key(card), &v.to_le_bytes());
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep245", "version": "1.0.0", "event": name, "data": [data] })));
}

pub(crate) fn minted(owner: &AccountId, card: usize, amount: u128) {
    set_supply(card, supply(card) + amount);
    event("mt_mint", json!({ "owner_id": owner, "token_ids": [CARDS[card]], "amounts": [amount.to_string()] }));
}

pub(crate) fn burned(owner: &AccountId, card: usize, amount: u128) {
    set_supply(card, supply(card).saturating_sub(amount));
    event("mt_burn", json!({ "owner_id": owner, "token_ids": [CARDS[card]], "amounts": [amount.to_string()] }));
}

fn card_index(token_id: &str) -> usize {
    CARDS.iter().position(|c| *c == token_id).unwrap_or_else(|| env::panic_str("no such card token"))
}

#[near(serializers = [json])]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[allow(dead_code)]
#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(&mut self, sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> PromiseOrValue<Vec<U128>>;
}

#[allow(dead_code)]
#[ext_contract(ext_mt_self)]
pub trait MtSelf {
    fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128>;
}

impl Kitchen {
    fn balance(&self, account: &AccountId, card: usize) -> u128 {
        let Some(chef) = self.chef_of.get(account) else { return 0 };
        match self.tokens.get(chef).map(|t| &t.kind) {
            Some(Kind::Chef { inventory, .. }) => inventory[card] as u128,
            _ => 0,
        }
    }

    fn add_cards(&mut self, account: &AccountId, card: usize, delta: i128) {
        let chef = self.chef_of.get(account).cloned().unwrap_or_else(|| env::panic_str("that account has no chef to hold cards"));
        let t = self.tokens.get_mut(&chef).unwrap();
        if let Kind::Chef { inventory, .. } = &mut t.kind {
            let now = inventory[card] as i128 + delta;
            require!(now >= 0, "not enough cards");
            require!(now <= u16::MAX as i128, "too many cards");
            inventory[card] = now as u16;
        }
    }

    fn move_cards(&mut self, from: &AccountId, to: &AccountId, token_ids: &[String], amounts: &[U128], memo: Option<String>) {
        require!(from != to, "sender and receiver are the same");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must match");
        for (id, amt) in token_ids.iter().zip(amounts) {
            let card = card_index(id);
            require!(amt.0 > 0 && amt.0 <= u16::MAX as u128, "bad amount");
            self.add_cards(from, card, -(amt.0 as i128));
            self.add_cards(to, card, amt.0 as i128);
        }
        let mut data = json!({
            "old_owner_id": from, "new_owner_id": to,
            "token_ids": token_ids, "amounts": amounts.iter().map(|a| a.0.to_string()).collect::<Vec<_>>(),
        });
        if let Some(m) = memo {
            data["memo"] = json!(m);
        }
        event("mt_transfer", data);
    }
}

#[near]
impl Kitchen {
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.move_cards(&sender, &receiver_id, &[token_id], &[amount], memo);
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approvals.map(|a| a.iter().all(|x| x.is_none())).unwrap_or(true), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.move_cards(&sender, &receiver_id, &token_ids, &amounts, memo);
    }

    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        require!(approval.is_none(), "approvals are not supported");
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], None, memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        near_sdk::assert_one_yocto();
        require!(approvals.map(|a| a.iter().all(|x| x.is_none())).unwrap_or(true), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.move_cards(&sender, &receiver_id, &token_ids, &amounts, memo);
        let owners = vec![sender.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_MT_ON_TRANSFER)
            .mt_on_transfer(sender.clone(), owners.clone(), token_ids.clone(), amounts.clone(), msg)
            .then(ext_mt_self::ext(env::current_account_id()).with_static_gas(GAS_FOR_MT_RESOLVE).mt_resolve_transfer(owners, receiver_id, token_ids, amounts))
            .into()
    }

    /// Returns what the receiver kept; unused amounts go back to the sender (if the receiver still has them).
    #[private]
    pub fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128> {
        let unused: Vec<U128> = match env::promise_result_checked(0, 1024) {
            Ok(v) => near_sdk::serde_json::from_slice::<Vec<U128>>(&v).ok().filter(|u| u.len() == amounts.len()).unwrap_or_else(|| amounts.clone()),
            Err(_) => amounts.clone(),
        };
        let mut kept = vec![];
        for (k, id) in token_ids.iter().enumerate() {
            let card = card_index(id);
            let want_back = unused[k].0.min(amounts[k].0).min(self.balance(&receiver_id, card));
            if want_back > 0 && self.chef_of.get(&previous_owner_ids[k]).is_some() {
                self.add_cards(&receiver_id, card, -(want_back as i128));
                self.add_cards(&previous_owner_ids[k], card, want_back as i128);
                event("mt_transfer", json!({ "old_owner_id": receiver_id, "new_owner_id": previous_owner_ids[k], "token_ids": [id], "amounts": [want_back.to_string()] }));
            }
            kept.push(U128(amounts[k].0 - want_back));
        }
        kept
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.balance(&account_id, card_index(&token_id)))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|id| U128(self.balance(&account_id, card_index(id)))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        CARDS.iter().position(|c| *c == token_id).map(|k| U128(supply(k)))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|id| self.mt_supply(id)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<MtToken>> {
        token_ids.into_iter().map(|id| CARDS.contains(&id.as_str()).then(|| MtToken { token_id: id, owner_id: None })).collect()
    }

    /// One-off after upgrading: count every card already in chef inventories into the supply.
    pub fn mt_reindex_supply(&mut self) -> Vec<U128> {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        let mut totals = [0u128; CARDS.len()];
        for i in 0..self.token_ids.len() {
            let id = self.token_ids.get(i).unwrap();
            if let Some(Kind::Chef { inventory, .. }) = self.tokens.get(id).map(|t| &t.kind) {
                for (k, n) in inventory.iter().enumerate() {
                    totals[k] += *n as u128;
                }
            }
        }
        for (k, t) in totals.iter().enumerate() {
            set_supply(k, *t);
        }
        totals.iter().map(|t| U128(*t)).collect()
    }
}
