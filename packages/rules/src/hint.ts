import { ITEM_LABEL, type ItemKind } from './content.ts';
import { COUNTERS, counterAt } from './layout.ts';
import { plan } from './bot.ts';
import type { State } from './sim.ts';

// Tutorial hints: the AI chefs' own planner, pointed at a human chef. It says what to do next
// for the most urgent order, and which counter to do it at.

export interface Hint { counter: number; action: 'act' | 'chop'; text: string }

const ASM = counterAt(4, 3);
const label = (k: ItemKind): string => ITEM_LABEL[k].toLowerCase();
const STATION: Record<string, string> = { cooker: 'rice cooker', pan: 'pan', pot: 'wasabi pot', board: 'cutting board' };

export function nextStep(s: State, i: number): Hint | null {
  const g = plan(s, i);
  if (!g) return null;
  const c = s.chefs[i];
  const counter = COUNTERS[g.counter];
  const held = c.held;
  const on = c.st[g.counter].item;
  let text: string;
  switch (counter.type) {
    case 'container': text = held?.k === 'plate' ? 'Scoop a nori cone onto your plate' : `Grab ${label(counter.source!)}`; break;
    case 'plates': text = 'Grab a plate from the rack'; break;
    case 'delivery': text = 'Serve the dish at the hatch'; break;
    case 'trash': text = held?.k === 'plate' ? 'That plate matches no order: bin it' : `Bin the ${held ? label(held.k) : 'item'}`; break;
    case 'board':
      text = g.action === 'chop' ? `Chop the ${on ? label(on.k) : 'item'} (press F)` : held ? `Put the ${label(held.k)} on a cutting board` : `Pick up the ${on ? label(on.k) : 'item'}`;
      break;
    case 'cooker': case 'pan': case 'pot':
      text = held ? `Put the ${label(held.k)} in the ${STATION[counter.type]}` : `Take the ${on ? label(on.k) : 'food'} off the ${STATION[counter.type]}${on && /burnt/.test(on.k) ? '' : ' before it burns'}`;
      break;
    default:
      if (g.counter === ASM) {
        text = held?.k === 'plate' ? 'Set the plate on the middle of the island' : held ? `Add the ${label(held.k)} to the plate` : on?.k === 'plate' ? 'Pick up the plate' : 'Clear the island';
      } else text = held ? `Set the ${label(held.k)} down here for now` : `Pick up the ${on ? label(on.k) : 'item'}`;
  }
  return { counter: g.counter, action: g.action, text };
}
