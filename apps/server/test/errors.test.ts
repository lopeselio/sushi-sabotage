import { describe, expect, it } from 'vitest';
import { readableError } from '../src/chain.ts';

describe('failed calls in words', () => {
  it('names the storage outage even when the JSON was cut off', () => {
    const cut = 'post_offer failed: {"ActionError":{"index":null,"kind":{"LackBalanceForState":{"account_id":"sushi-sabotage.testnet","am';
    expect(readableError(new Error(cut))).toBe('post_offer failed: the contract is out of storage NEAR (LackBalanceForState)');
  });
  it('quotes a contract panic', () => {
    const e = new Error('accept_offer failed: {"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: offer expired"}}}}');
    expect(readableError(e)).toBe('accept_offer failed: the contract refused: offer expired');
  });
  it('falls back to the error kind, and leaves plain messages alone', () => {
    expect(readableError(new Error('seal failed: {"ActionError":{"index":0,"kind":{"AccountDoesNotExist":{}}}}'))).toBe('seal failed: transaction failed (AccountDoesNotExist)');
    expect(readableError(new Error('no RPC answered'))).toBe('no RPC answered');
  });
});
