import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { CARDS, DIFFICULTIES, SHIFT_TICKS, replay, stateHash, validAccusations, type BotSkill, type Card, type LogEntry } from '@sushi/rules';
import { ALL_AGENTS, CHEF_AGENTS, DAY_CAP, MATCH_CAP, agentBudgets, FIXER, accountOf, agentChef, agentEconomyTick, fixerOffer, haggleWithFixer, prices, recentActs, taunt } from './agents.ts';
import { PLAYER_RESERVE, affordableRounds } from './budget.ts';
import { BA_PATH, accountFromHeaders, authHandler } from './ba.ts';
import { view } from './chain.ts';
import { config, explorerTx } from './config.ts';
import { ChainMatch, planSeats, soloBots, type SeatPlan } from './match.ts';
import { attestation } from './nearai.ts';
import { Room } from './room.ts';
import { startLeague } from './league.ts';
import { startPruning } from './prune.ts';
import { chainStatus, startWatch } from './status.ts';
import { loadMatch, recentMatches } from './store.ts';

// ---------- tiny HTTP helpers ----------

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function body<T>(req: IncomingMessage, max = 2_000_000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}
const isTestChef = (name: string): boolean => /^e2e\b/i.test(name.trim());
const cleanName = (n: unknown): string => String(n ?? '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 20) || 'Chef';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  let file = normalize(join(config.webDist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(normalize(config.webDist))) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, 'index.html');
  if (!existsSync(file)) { res.writeHead(404).end('web app not built: pnpm build'); return; }
  const immutable = file.includes(`${join(config.webDist, 'assets')}`);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  createReadStream(file).pipe(res);
}

// ---------- solo shifts ----------

interface SoloRun { match: ChainMatch; expires: number; you: number }
const solos = new Map<string, SoloRun>();

async function soloStart(account: string | null, name: string, bots: number, loadout: number[], difficulty: BotSkill) {
  const seats: SeatPlan[] = [
    { name, kind: account ? 'human' : 'guest', account: account ?? undefined, loadout },
    ...soloBots(bots).map((a): SeatPlan => ({ name: a.name, kind: 'bot', agent: a })),
  ];
  const planned = await planSeats(seats);
  // a ranked shift (entry fees at stake) is never played against Easy chefs: that would farm the agents' fees
  if (planned.fee > 0 && difficulty === 'easy') difficulty = 'normal';
  const match = new ChainMatch('solo', planned.seats, planned.fee, difficulty);
  const setup = match.setup;
  solos.set(match.id, { match, expires: Date.now() + 15 * 60_000, you: 0 });
  const line = await Promise.race([
    taunt(soloBots(bots)[0], [name]),
    new Promise<null>((r) => setTimeout(() => r(null), 2500)),
  ]);
  if (line) match.rec.lines.push(line);
  // in solo the browser runs the sim, so it gets the seed now; the hash was committed first
  return {
    matchId: match.id, setup, difficulty, you: 0, ranked: planned.fee > 0, fee: planned.fee, seedHash: match.rec.seedHash,
    line: line ? { who: line.who, text: line.text, signed: !!line.signature } : null,
    // a signed-in chef out of energy plays an unrecorded (guest) shift
    noEnergy: !!planned.seats[0].noEnergy, recorded: !!planned.seats[0].chef,
  };
}

async function soloFinish(matchId: string, log: LogEntry[], clientHash: string, mine: { sab: number; accused: number }[]) {
  const run = solos.get(matchId);
  if (!run) throw new Error('no such solo shift (or it expired)');
  solos.delete(matchId);
  if (!Array.isArray(log) || log.length > SHIFT_TICKS * 3) throw new Error('bad input log');
  // only the player's own inputs count; bots decide for themselves
  const clean = log.filter((e) => e && e.c === run.you && Number.isInteger(e.t) && e.t >= 0 && e.t < SHIFT_TICKS).map((e) => ({ t: e.t, c: e.c, i: e.i }));
  const s = replay(run.match.setup, clean);
  run.match.rec.log = clean;
  // the referee's replay must land on the exact state the browser ended in
  const verified = stateHash(s) === clientHash;
  // your browser ran the sim and could know the culprits: your own accusations count only in
  // unranked shifts, where nothing is at stake; the bots' always count
  const acc = run.match.botAccusations(s);
  if (!run.match.rec.ranked) {
    acc.push(...validAccusations(s, (Array.isArray(mine) ? mine : []).slice(0, 64).map((a) => ({ victim: run.you, sab: Number(a.sab), accused: Number(a.accused) }))));
  }
  const { results, settled } = run.match.finish(s, acc);
  const reveal = s.sab.map((x) => ({ caster: x.caster, target: x.target, card: x.card, tick: x.tick, blocked: x.blocked, fizzled: x.fizzled }));
  void settled;
  return { results, reveal, accusations: acc, matchId, difficulty: run.match.difficulty, ranked: run.match.rec.ranked, verified, stateHash: stateHash(s) };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of solos) if (v.expires < now) solos.delete(k); }, 60_000).unref();

// ---------- routes ----------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    // wallet sign-in, sessions and gasless relay: Better Auth + better-near-auth
    if (p === BA_PATH || p.startsWith(`${BA_PATH}/`)) { await authHandler(req, res); return; }
    const me = await accountFromHeaders(req.headers);
    if (p === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION ?? 'dev' });
    if (p === '/api/status') {
      const st = config.chainEnabled ? await chainStatus() : null;
      return json(res, 200, { version: process.env.APP_VERSION ?? 'dev', chain: config.chainEnabled, warnings: st?.warnings ?? [], contract: st?.contract ?? null, accounts: st?.accounts ?? [] });
    }
    if (p === '/api/config') {
      return json(res, 200, {
        network: config.network, contract: config.contract, referee: config.referee, chain: config.chainEnabled,
        agents: await Promise.all(ALL_AGENTS.map(async (a) => ({ label: a.label, name: a.name, account: accountOf(a), chef: await agentChef(a), skill: a.skill ?? null }))),
      });
    }
    if (p === '/api/me') {
      // a guest is a normal visitor, not an error: 200 with null (no 401 in the browser console)
      if (!me) return json(res, 200, null);
      const chef = config.chainEnabled ? await view<string | null>('chef_of', { account_id: me }).catch(() => null) : null;
      const token = chef ? await view('nft_token', { token_id: chef }).catch(() => null) : null;
      const raw = chef ? await view('get_token', { token_id: chef }).catch(() => null) : null;
      const econ = chef ? await view('get_chef', { chef }).catch(() => null) : null;
      return json(res, 200, { accountId: me, chef, token, raw, econ });
    }
    if (p === '/api/economy') {
      // energy and upgrade prices (yoctoNEAR) and the treasury, straight from the contract
      return json(res, 200, config.chainEnabled ? await view('get_economy').catch(() => null) : null);
    }
    if (p === '/api/solo/start' && req.method === 'POST') {
      const b = await body<{ name?: string; bots?: number; loadout?: number[]; difficulty?: string }>(req);
      const difficulty = DIFFICULTIES.find((d) => d === b.difficulty) ?? 'normal';
      return json(res, 200, await soloStart(me, cleanName(b.name), Math.max(1, Math.min(3, Number(b.bots ?? 3))), Array.isArray(b.loadout) ? b.loadout.map(Number) : [], difficulty));
    }
    if (p === '/api/solo/finish' && req.method === 'POST') {
      const b = await body<{ matchId: string; log: LogEntry[]; stateHash?: string; accusations?: { sab: number; accused: number }[] }>(req);
      return json(res, 200, await soloFinish(String(b.matchId), b.log, String(b.stateHash ?? ''), b.accusations ?? []));
    }
    if (p === '/api/market') return json(res, 200, { prices: prices(), fixer: await agentChef(FIXER), cards: CARDS });
    if (p === '/api/market/haggle' && req.method === 'POST') {
      if (!me) return json(res, 401, { error: 'sign in with a NEAR wallet to buy cards' });
      const b = await body<{ card: Card; offer: number; round: 0 | 1; said?: string }>(req);
      if (!(CARDS as readonly string[]).includes(b.card)) return json(res, 400, { error: 'no such card' });
      const chef = await view<string | null>('chef_of', { account_id: me });
      if (!chef) return json(res, 400, { error: 'mint your chef first' });
      const reply = await haggleWithFixer(b.card, Number(b.offer), b.round === 1 ? 1 : 0, String(b.said ?? ''));
      let offer: { offerId: number; tx: string } | null = null;
      if (reply.outcome.kind === 'accept') offer = await fixerOffer(chef, b.card, reply.outcome.price);
      return json(res, 200, { outcome: reply.outcome, list: reply.list, line: { who: reply.line.who, text: reply.line.text, signed: !!reply.line.signature }, offer: offer && { ...offer, url: explorerTx(offer.tx) } });
    }
    if (p === '/api/leaderboard') {
      // the end-to-end test (e2e-player.ts) mints chefs named "E2E Chef" and plays ranked shifts with
      // them; they stay on the contract's board but aren't players, so the game's board leaves them out
      const rows = config.chainEnabled ? await view<{ chef: string; name: string; best: number }[]>('leaderboard', { limit: 40 }).catch(() => []) : [];
      return json(res, 200, rows.filter((r) => !isTestChef(r.name)).slice(0, 20));
    }
    if (p === '/api/agents') {
      const [budgets, st] = await Promise.all([agentBudgets(), config.chainEnabled ? chainStatus().catch(() => null) : null]);
      return json(res, 200, {
        // when the contract can't store anything new, every agent action below fails: say so up top
        storage: st?.contract.warning ?? null,
        acts: recentActs().map((a) => ({ ...a, url: a.tx ? explorerTx(a.tx) : undefined })),
        chefs: CHEF_AGENTS.map((a, i) => ({ name: a.name, account: accountOf(a), skill: a.skill, budget: budgets[i] })),
        league: { rankedRoundsLeft: affordableRounds(budgets), playerReserve: PLAYER_RESERVE, dayCap: DAY_CAP, matchCap: MATCH_CAP },
      });
    }
    if (p === '/api/matches') return json(res, 200, recentMatches(20).map((m) => ({ id: m.id, mode: m.mode, createdAt: m.createdAt, names: m.seats.map((s) => s.name), results: m.results, settled: m.settled, ranked: m.ranked })));
    if (p.startsWith('/api/match/')) {
      const m = loadMatch(p.slice('/api/match/'.length));
      if (!m) return json(res, 404, { error: 'no such match' });
      // the input log and seed are public only after the match is over
      const done = !!m.results;
      return json(res, 200, { ...m, seed: done ? m.seed : undefined, openings: done ? m.openings : [], log: done ? m.log : [], txs: m.txs.map((t) => ({ ...t, url: explorerTx(t.hash) })), pruned: m.pruned && { ...m.pruned, url: explorerTx(m.pruned.tx) } });
    }
    if (p === '/api/attestation') return json(res, 200, await attestation());
    if (p === '/api/rooms') return json(res, 200, Room.list());
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    serveStatic(req, res);
  } catch (e) {
    json(res, 400, { error: (e as Error).message });
  }
}

const server = createServer((req, res) => { void route(req, res); });

// ---------- websocket: multiplayer rooms ----------

const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 512 }, maxPayload: 16_000 });
wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  let room: Room | null = null;
  // the session cookie rides on the WebSocket upgrade (same origin)
  let account: string | null = null;
  const ready = accountFromHeaders(req.headers).then((a) => { account = a; }).catch(() => undefined);
  let name = 'Chef';
  const reply = (m: unknown): void => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  ws.on('message', async (raw) => {
    await ready; // messages wait for the session lookup; they stay in order
    let m: Record<string, unknown>;
    try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    try {
      switch (m.t) {
        case 'hello': name = cleanName(m.name); reply({ t: 'hello', account }); break;
        case 'create': room?.leave(ws); room = new Room(); room.join(ws, name, account); break;
        case 'join': { const r = Room.get(String(m.code ?? '')); if (!r) throw new Error('no room with that code'); room?.leave(ws); r.join(ws, name, account); room = r; break; }
        case 'addBot': room?.addBot(ws); break;
        case 'difficulty': room?.setDifficulty(ws, String(m.level ?? '')); break;
        case 'kick': room?.kick(ws, Number(m.seat)); break;
        case 'ready': room?.setReady(ws, !!m.ready, Array.isArray(m.loadout) ? (m.loadout as number[]) : []); break;
        case 'in': room?.input(ws, (m.i ?? {}) as never); break;
        case 'accuse': room?.accuse(ws, Array.isArray(m.list) ? (m.list as never) : []); break;
        case 'leave': room?.leave(ws); room = null; break;
      }
    } catch (e) {
      reply({ t: 'error', msg: (e as Error).message });
    }
  });
  ws.on('close', () => room?.leave(ws));
});

server.listen(config.port, () => {
  console.log(`Sushi Sabotage on :${config.port} (contract ${config.contract}, chain ${config.chainEnabled ? 'on' : 'off'})`);
});

// the AI chefs run their own economy every few minutes (AGENT_TICK=0 turns it off, e.g. for a local
// test server next to the hosted one; LEAGUE_MINUTES=0 does the same for the league)
if (config.chainEnabled) {
  if (process.env.AGENT_TICK !== '0') {
    const loop = (): void => { void agentEconomyTick().catch((e) => console.warn('agent tick:', (e as Error).message)); };
    setTimeout(loop, 5000);
    setInterval(loop, 10 * 60_000).unref();
  }
  startLeague();
  startWatch();
  startPruning();
}
