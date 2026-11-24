// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// The harness speaks newline-delimited JSON on stdin: first a hello message
// (protocol, seed, universe, capital, caps, latency in slots, fees), then one
// batch message per slot window (seq, slot, events, marks, fills, account),
// then a done message. The bot answers every batch with exactly one reply
// line on stdout: {"type":"reply","seq":<same seq>,"orders":[...]}.
//
// Strategy — earliest-entry scalper on the pump.fun bonding curve. A trend
// signal was tried and abandoned: the price rise that looks like a trend
// is really one big trade, and by the batch-end price — the only price a
// bot can pay, two slots after the decision — the move is already over
// and the price is falling back. Every trend, dip and slow-grind variant
// lost money at batch granularity, so the bot goes back to the earliest
// entry, where the loss per trade is smallest;
//   * buy a coin at the first moment a trade of 0.01 SOL or more fits under
//     the 1%-of-real-reserve order cap with real reserves of 3 SOL (a buy
//     of about 0.027 SOL), and only while its price is still within 10% of
//     that trigger price and never ran 30% past it — never chase a coin
//     that already ran;
//   * buy a fixed slice (up to 0.25 SOL, at most 0.9% of real reserves, at
//     least 0.01 SOL so the round trip counts toward the minimum bar), at
//     most 5 open positions, at most 16 orders per batch, and never order
//     twice for the same intent while an earlier order still awaits its
//     fill (a rejected buy waits 1000 slots before it may be retried);
//     cash spoken for by buys still awaiting fills is reserved, so the bot
//     never over-commits the same lamports twice;
//   * fills are priced two slots after the decision, so every order allows
//     only 2% of slippage: a buy filling far above the decision price is
//     buying the spike, not the trigger, and a sell filling far below it
//     is giving the crash away — a rejected order costs nothing, so the bot
//     waits for a fill near its price instead of paying the move;
//   * exit a position on take profit (+80%), stop loss (-5%), a trailing
//     exit (once 20% up, sell if it falls 10% from its peak), a time exit
//     (the edge fades within about 10000 slots), or immediately when the
//     coin completes its bonding curve.
// All money math is integer BigInt lamports; prices are compared as rational
// pairs (virtual SOL reserves over virtual token reserves) so no float ever
// decides a trade. There is no clock, no randomness and no network use, so
// two runs over the same data produce the same action log byte for byte.

// ---- tunable parameters (all in lamports / basis points / slots) ----
// Entry is the earliest moment a buy fits the order cap: real reserves of
// at least 3 SOL (so a buy of about 0.027 SOL fits the 1% order cap and
// clears the 0.01 SOL round-trip bar), while the price is still within 10%
// of the trigger price and never ran 30% past it. A sweep of exit rules
// over the dev data at batch-end prices picked the tightest stop: the
// losers fall fast, so cutting them at -5% loses less than waiting for -15%.
const BUY_MIN_REAL_SOL = 3_000_000_000n; // 3 SOL of real reserves before a buy
const BUY_SIZE_MAX = 250_000_000n; // 0.25 SOL per buy at most
const BUY_SIZE_MIN = 10_000_000n; // 0.01 SOL per buy at least (round-trip bar)
const BUY_SIZE_BPS_OF_RESERVE = 90; // size at most 0.9% of real reserves
const ENTRY_MAX_ABOVE_TRIGGER_BPS = 1000; // refuse a buy once the price ran
// 10% past the trigger price: that entry is a top, not a start
const PEAK_SINCE_TRIGGER_MAX_BPS = 3000; // refuse a buy if the price already
// ran 30% past the trigger and came back: the move is over, not starting
const ENTRY_MIN_TRADES = 2; // at least 2 trades observed
const TAKE_PROFIT_BPS = 8000; // sell at +80% vs entry
const STOP_LOSS_BPS = -500; // sell at -5% vs entry
const TRAIL_ARM_BPS = 2000; // arm the trailing exit at +20%
const TRAIL_DROP_BPS = 1000; // sell on a 10% fall from the peak once armed
const MAX_HOLD_SLOTS = 10000; // time exit after about an hour of slots
const BUY_RETRY_COOLDOWN_SLOTS = 1000; // wait after a rejected buy before retrying
const BUY_SLIPPAGE_BPS = 200; // buys fill only near the decision price: a fill
// 2 slots later at a much higher price is buying the spike, not the trigger
const SELL_SLIPPAGE_BPS = 200; // sells fill only near the decision price too:
// a fill far below it gives the crash away, and a rejected order costs
// nothing, so the bot waits for a fill near its price instead
const MAX_ROUND_TRIPS_PER_MINT = 3; // do not churn one coin forever
const REENTRY_COOLDOWN_SLOTS = 1000; // wait after an exit before re-entering
const TX_FEE_LAMPORTS = 105_000n; // base 5000 + priority 100000 per trade
const FEE_BPS = 125; // protocol 95 + creator 30 bps, variable part

// ---- small helpers ----
function u64(v: unknown): bigint {
  if (typeof v === "string") return BigInt(v);
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return 0n;
}

// A price is a rational pair: virtual SOL reserves over virtual token reserves.
interface Price {
  vs: bigint;
  vt: bigint;
}

function priceOf(vs: bigint, vt: bigint): Price {
  return { vs, vt };
}

// Rise of `now` over `base`, in basis points, as a signed BigInt.
// rise = (now/base - 1) * 10000, computed by cross-multiplication.
function riseBps(now: Price, base: Price): bigint {
  if (base.vs <= 0n || base.vt <= 0n || now.vt <= 0n) return 0n;
  const num = (now.vs * base.vt - base.vs * now.vt) * 10_000n;
  const den = base.vs * now.vt;
  return num / den;
}

// Rise of the current price over an entry quoted as cost/tokens, in bps.
function riseOverEntryBps(now: Price, costLamports: bigint, tokens: bigint): bigint {
  if (costLamports <= 0n || tokens <= 0n || now.vt <= 0n) return 0n;
  const num = (now.vs * tokens - costLamports * now.vt) * 10_000n;
  const den = costLamports * now.vt;
  return num / den;
}

// ---- per-coin state ----
interface CoinState {
  mint: string;
  firstPrice: Price;
  lastPrice: Price;
  peakPrice: Price; // peak since the current position opened (else last price)
  firstSlot: number;
  lastSlot: number;
  trades: number;
  buys: number;
  sells: number;
  buyVol: bigint; // SOL lamports bought by the crowd
  sellVol: bigint; // SOL lamports sold by the crowd
  completed: boolean;
  roundTrips: number;
  lastExitSlot: number;
  realSolReserves: bigint; // latest real SOL reserves, from trades or marks
  triggerPrice: Price | null; // price when real reserves first reached 3 SOL
  peakSinceTrigger: Price | null; // highest price since the trigger
  buyPending: boolean; // a buy order is out and its fill has not come back
  sellPending: boolean; // a sell order is out and its fill has not come back
  buyRejectedSlot: number; // slot of the last rejected buy, for a retry cooldown
  hasPosition: boolean;
  entryCost: bigint; // cost_lamports of the open position
  entryTokens: bigint; // token_amount of the open position
  entrySlot: number; // slot when the open position first appeared
}

interface Config {
  maxOpenPositions: number;
  maxOrdersPerBatch: number;
  maxOrderBpsOfReserve: number;
  capitalLamports: bigint;
}

const DEFAULT_CONFIG: Config = {
  maxOpenPositions: 5,
  maxOrdersPerBatch: 16,
  maxOrderBpsOfReserve: 100,
  capitalLamports: 10_000_000_000n,
};

class Bot {
  private config: Config = DEFAULT_CONFIG;
  private coins = new Map<string, CoinState>();
  private orderCounter = 0;
  private cashLamports = 0n;
  private openPositionCount = 0;
  private reservedLamports = 0n; // cash spoken for by buys still awaiting fills
  private pendingBuys = new Map<string, bigint>(); // client_id -> reserved lamports

  private coin(mint: string, slot: number, price: Price): CoinState {
    let c = this.coins.get(mint);
    if (!c) {
      c = {
        mint,
        firstPrice: price,
        lastPrice: price,
        peakPrice: price,
        firstSlot: slot,
        lastSlot: slot,
        trades: 0,
        buys: 0,
        sells: 0,
        buyVol: 0n,
        sellVol: 0n,
        completed: false,
        roundTrips: 0,
        lastExitSlot: -1_000_000,
        realSolReserves: 0n,
        triggerPrice: null,
        peakSinceTrigger: null,
        buyPending: false,
        sellPending: false,
        buyRejectedSlot: -1_000_000,
        hasPosition: false,
        entryCost: 0n,
        entryTokens: 0n,
        entrySlot: 0,
      };
      this.coins.set(mint, c);
    }
    return c;
  }

  // Record the latest real reserves for a coin, and arm the trigger the
  // first time reserves reach 3 SOL: the trigger price is the price at
  // that moment, and the peak since the trigger tracks how far the price
  // has run past it.
  private refreshReserves(c: CoinState, realSolReserves: bigint): void {
    c.realSolReserves = realSolReserves;
    if (c.triggerPrice === null && realSolReserves >= BUY_MIN_REAL_SOL) {
      c.triggerPrice = c.lastPrice;
      c.peakSinceTrigger = c.lastPrice;
    }
    if (c.peakSinceTrigger !== null && riseBps(c.lastPrice, c.peakSinceTrigger) > 0n) {
      c.peakSinceTrigger = c.lastPrice;
    }
  }

  // Record a fresh price for a coin: last price and peak of an open position.
  private notePrice(c: CoinState, price: Price): void {
    c.lastPrice = price;
    if (c.hasPosition && riseBps(price, c.peakPrice) > 0n) {
      c.peakPrice = price;
    }
  }

  private noteTrade(
    mint: string,
    slot: number,
    price: Price,
    isBuy: boolean,
    solAmount: bigint,
    realSolReserves: bigint,
  ): void {
    const c = this.coin(mint, slot, price);
    c.lastSlot = slot;
    this.notePrice(c, price);
    this.refreshReserves(c, realSolReserves);
    c.trades += 1;
    if (isBuy) {
      c.buys += 1;
      c.buyVol += solAmount;
    } else {
      c.sells += 1;
      c.sellVol += solAmount;
    }
    if (c.hasPosition && riseBps(price, c.peakPrice) > 0n) {
      c.peakPrice = price;
    }
  }

  // Sync open positions from the harness account snapshot (ground truth).
  private syncAccount(account: any, slot: number): void {
    this.cashLamports = u64(account?.cash_lamports);
    const seen = new Set<string>();
    const positions = Array.isArray(account?.positions) ? account.positions : [];
    this.openPositionCount = positions.length;
    for (const p of positions) {
      const mint = String(p.mint);
      seen.add(mint);
      const cost = u64(p.cost_lamports);
      const tokens = u64(p.token_amount);
      const c = this.coins.get(mint);
      if (!c) continue; // a position in a coin we never saw: hold it, do not trade it
      if (!c.hasPosition) {
        // A fresh position: record its entry and reset the peak to now.
        c.hasPosition = true;
        c.entryCost = cost;
        c.entryTokens = tokens;
        c.entrySlot = slot;
        c.peakPrice = c.lastPrice;
      } else {
        c.entryCost = cost;
        c.entryTokens = tokens;
      }
    }
    for (const c of this.coins.values()) {
      if (c.hasPosition && !seen.has(c.mint)) {
        // Position closed (sold, completed or written off) since last batch.
        c.hasPosition = false;
        c.roundTrips += 1;
        c.lastExitSlot = slot;
        c.entryCost = 0n;
        c.entryTokens = 0n;
      }
    }
  }

  private buySize(realSolReserves: bigint): bigint {
    const cap = (realSolReserves * BigInt(BUY_SIZE_BPS_OF_RESERVE)) / 10_000n;
    const size = cap < BUY_SIZE_MAX ? cap : BUY_SIZE_MAX;
    return size;
  }

  private shouldBuy(c: CoinState, slot: number, realSolReserves: bigint, availableCash: bigint): bigint {
    if (c.completed) return 0n;
    if (c.hasPosition) return 0n;
    if (c.buyPending) return 0n; // an earlier buy is still awaiting its fill
    if (c.roundTrips >= MAX_ROUND_TRIPS_PER_MINT) return 0n;
    if (slot - c.lastExitSlot < REENTRY_COOLDOWN_SLOTS) return 0n;
    if (slot - c.buyRejectedSlot < BUY_RETRY_COOLDOWN_SLOTS) return 0n;
    if (c.trades < ENTRY_MIN_TRADES) return 0n;
    if (realSolReserves < BUY_MIN_REAL_SOL) return 0n;
    if (c.triggerPrice === null) return 0n;
    // Never chase: the trigger edge is gone once the price has run more
    // than 10% past the trigger price — that entry is a top, not a start.
    if (riseBps(c.lastPrice, c.triggerPrice) > BigInt(ENTRY_MAX_ABOVE_TRIGGER_BPS)) return 0n;
    // And never buy a retrace: if the price already ran 30% past the
    // trigger and came back, the move happened without us.
    if (
      c.peakSinceTrigger !== null &&
      riseBps(c.peakSinceTrigger, c.triggerPrice) > BigInt(PEAK_SINCE_TRIGGER_MAX_BPS)
    ) {
      return 0n;
    }
    const size = this.buySize(realSolReserves);
    if (size < BUY_SIZE_MIN) return 0n;
    // Keep enough cash for the trade plus its variable and fixed fees.
    const need = size + (size * BigInt(FEE_BPS)) / 10_000n + TX_FEE_LAMPORTS;
    if (availableCash < need) return 0n;
    return size;
  }

  // Returns true when the open position in this coin should be sold now.
  private shouldSell(c: CoinState, slot: number): boolean {
    if (!c.hasPosition) return false;
    if (c.sellPending) return false; // a sell is already awaiting its fill
    if (c.completed) return true;
    const rise = riseOverEntryBps(c.lastPrice, c.entryCost, c.entryTokens);
    if (rise >= BigInt(TAKE_PROFIT_BPS)) return true;
    if (rise <= BigInt(STOP_LOSS_BPS)) return true;
    const peakRise = riseOverEntryBps(c.peakPrice, c.entryCost, c.entryTokens);
    if (peakRise >= BigInt(TRAIL_ARM_BPS)) {
      // Once armed, sell when the price has fallen 20% from its peak.
      const drop = riseBps(c.peakPrice, c.lastPrice);
      if (drop >= BigInt(TRAIL_DROP_BPS)) return true;
    }
    if (slot - c.entrySlot >= MAX_HOLD_SLOTS) return true;
    return false;
  }

  private nextClientId(): string {
    this.orderCounter += 1;
    return `p${this.orderCounter}`;
  }

  // One batch in, one reply out. Orders are emitted sells-first (freeing
  // position slots), then buys, both in mint-sorted order so the reply is
  // fully determined by the batch content.
  handleBatch(batch: any): { type: string; seq: number; orders: any[] } {
    const seq = typeof batch.seq === "number" ? batch.seq : 0;
    const slot = typeof batch.slot === "number" ? batch.slot : 0;

    const events = Array.isArray(batch.events) ? batch.events : [];
    for (const e of events) {
      const mint = typeof e.mint === "string" ? e.mint : "";
      if (!mint) continue;
      const evSlot = typeof e.slot === "number" ? e.slot : slot;
      if (e.event === "CreateEvent") {
        const price = priceOf(u64(e.virtual_sol_reserves), u64(e.virtual_token_reserves));
        const c = this.coin(mint, evSlot, price);
        c.lastSlot = evSlot;
        c.realSolReserves = 0n; // a fresh curve holds no real SOL yet
        if (e.is_mayhem_mode === true) c.completed = true;
      } else if (e.event === "TradeEvent") {
        const price = priceOf(u64(e.virtual_sol_reserves), u64(e.virtual_token_reserves));
        this.noteTrade(
          mint,
          evSlot,
          price,
          e.is_buy === true,
          u64(e.sol_amount),
          u64(e.real_sol_reserves),
        );
      } else if (e.event === "CompleteEvent") {
        const c = this.coins.get(mint);
        if (c) {
          c.completed = true;
          c.lastSlot = evSlot;
        }
      }
    }

    // Marks carry the freshest reserves per mint; they re-price everything.
    // Real reserves are tracked on the coin itself (trades update them too),
    // so a buy never depends on a mark arriving for that mint.
    const marks = Array.isArray(batch.marks) ? batch.marks : [];
    for (const m of marks) {
      const mint = typeof m.mint === "string" ? m.mint : "";
      if (!mint) continue;
      const price = priceOf(u64(m.virtual_quote_reserves), u64(m.virtual_token_reserves));
      const c = this.coins.get(mint);
      if (c) {
        c.lastSlot = typeof m.slot === "number" ? m.slot : slot;
        this.notePrice(c, price);
        this.refreshReserves(c, u64(m.real_quote_reserves));
      }
    }

    // Fills report what happened to the orders of earlier batches. Clear
    // the pending flag they answer so a coin is never ordered twice for
    // the same intent, remember rejected buys for a retry cooldown, and
    // release the cash a filled or rejected buy had reserved.
    const fills = Array.isArray(batch.fills) ? batch.fills : [];
    for (const f of fills) {
      const c = this.coins.get(String(f.mint));
      if (!c) continue;
      if (f.side === "buy") {
        c.buyPending = false;
        const reserved = this.pendingBuys.get(String(f.client_id));
        if (reserved !== undefined) {
          this.pendingBuys.delete(String(f.client_id));
          this.reservedLamports -= reserved;
        }
        if (f.status === "rejected" || f.status === "failed") {
          c.buyRejectedSlot = slot;
        }
      } else if (f.side === "sell") {
        c.sellPending = false;
      }
    }

    this.syncAccount(batch.account, slot);

    const orders: any[] = [];
    const maxOrders = Math.max(0, this.config.maxOrdersPerBatch);

    // Sells first, mint-sorted.
    const held = [...this.coins.values()]
      .filter((c) => c.hasPosition)
      .sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
    let sells = 0;
    for (const c of held) {
      if (orders.length >= maxOrders) break;
      if (!this.shouldSell(c, slot)) continue;
      c.sellPending = true;
      orders.push({
        side: "sell",
        client_id: this.nextClientId(),
        mint: c.mint,
        token_amount: c.entryTokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      sells += 1;
    }

    // Buys next, mint-sorted, while a position slot is free.
    let freeSlots =
      this.config.maxOpenPositions - this.openPositionCount + sells;
    const candidates = [...this.coins.values()].sort((a, b) =>
      a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0,
    );
    let spent = 0n;
    for (const c of candidates) {
      if (orders.length >= maxOrders) break;
      if (freeSlots <= 0) break;
      const real = c.realSolReserves;
      // Cash left after the buys already queued in this batch and the buys
      // of earlier batches still awaiting their fills.
      const available = this.cashLamports - spent - this.reservedLamports;
      const size = this.shouldBuy(c, slot, real, available);
      if (size <= 0n) continue;
      const need = size + (size * BigInt(FEE_BPS)) / 10_000n + TX_FEE_LAMPORTS;
      if (available < need) continue;
      spent += need;
      c.buyPending = true;
      const clientId = this.nextClientId();
      this.pendingBuys.set(clientId, need);
      this.reservedLamports += need;
      orders.push({
        side: "buy",
        client_id: clientId,
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      freeSlots -= 1;
    }

    return { type: "reply", seq, orders };
  }

  handleHello(hello: any): void {
    const caps = hello?.caps;
    if (caps) {
      this.config = {
        maxOpenPositions:
          typeof caps.max_open_positions === "number"
            ? caps.max_open_positions
            : DEFAULT_CONFIG.maxOpenPositions,
        maxOrdersPerBatch:
          typeof caps.max_orders_per_batch === "number"
            ? caps.max_orders_per_batch
            : DEFAULT_CONFIG.maxOrdersPerBatch,
        maxOrderBpsOfReserve:
          typeof caps.max_order_bps_of_real_reserve === "number"
            ? caps.max_order_bps_of_real_reserve
            : DEFAULT_CONFIG.maxOrderBpsOfReserve,
        capitalLamports: u64(hello?.capital?.lamports) || DEFAULT_CONFIG.capitalLamports,
      };
    }
    this.cashLamports = this.config.capitalLamports;
  }
}

async function main(): Promise<void> {
  const bot = new Bot();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "hello") {
        bot.handleHello(msg);
      } else if (msg.type === "batch") {
        const reply = bot.handleBatch(msg);
        process.stdout.write(JSON.stringify(reply) + "\n");
      } else if (msg.type === "done") {
        process.exit(0);
      }
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(1));
