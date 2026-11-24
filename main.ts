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
//
// Speed — the dev window carries tens of thousands of batches, and the
// final window is a much larger slice of the same stream, while the
// grader gives the bot one CPU and a 30-minute wall budget. The bot
// therefore never scans all coins in a batch. It keeps a small live set
// of buy candidates (coins whose trigger armed and which are not
// completed, positioned, pending or cooling down) and a small set of open
// positions, and re-evaluates a candidate only when its own price or
// reserves moved, when a cooldown of its own expired, or when cash or a
// position slot freed up for every candidate at once. Price comparisons
// are done as cross-multiplications against the entry and exit
// thresholds, never as a division, so no BigInt division runs per event.
// The stdin reader walks one buffer with an offset instead of copying
// the unread tail once per line. The trading rules themselves are
// unchanged: the same coins, in the same mint order, get the same orders
// as the straightforward scan would have produced.

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
const TRAIL_DROP_BPS = 1000; // sell on a 10% fall from its peak once armed
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

// A price is a rational pair: virtual SOL reserves over virtual token
// reserves, kept as two plain BigInt fields on the coin so no price
// object is ever allocated per event.

// True when price a sits above price b: aVs/aVt > bVs/bVt, by cross
// multiplication, with no division.
function priceAbove(aVs: bigint, aVt: bigint, bVs: bigint, bVt: bigint): boolean {
  return aVs * bVt > bVs * aVt;
}

// True when the rise of `now` over `base` is more than `bps` basis
// points: (now/base - 1) * 10000 > bps, rearranged to
// 10000 * nowVs * baseVt > (10000 + bps) * baseVs * nowVt. A missing or
// non-positive base price means a rise of zero, which never exceeds a
// positive threshold.
function riseAboveBps(
  nowVs: bigint,
  nowVt: bigint,
  baseVs: bigint,
  baseVt: bigint,
  bps: bigint,
): boolean {
  if (baseVs <= 0n || baseVt <= 0n || nowVt <= 0n) return false;
  return 10_000n * nowVs * baseVt > (10_000n + bps) * baseVs * nowVt;
}

// True when the rise of a price over an entry quoted as cost/tokens is
// at least `num/den` of the entry: a * nowVs * tokens >= b * cost *
// nowVt, where a/b is the threshold ratio in lowest terms. A missing or
// non-positive entry means a rise of zero, which never reaches a
// positive threshold.
function entryRiseAtLeast(
  nowVs: bigint,
  nowVt: bigint,
  cost: bigint,
  tokens: bigint,
  a: bigint,
  b: bigint,
): boolean {
  if (cost <= 0n || tokens <= 0n || nowVt <= 0n) return false;
  return a * nowVs * tokens >= b * cost * nowVt;
}

// True when the rise of a price over an entry quoted as cost/tokens is
// at most `num/den` of the entry (used for the stop loss, a negative
// threshold): a * nowVs * tokens <= b * cost * nowVt.
function entryRiseAtMost(
  nowVs: bigint,
  nowVt: bigint,
  cost: bigint,
  tokens: bigint,
  a: bigint,
  b: bigint,
): boolean {
  if (cost <= 0n || tokens <= 0n || nowVt <= 0n) return false;
  return a * nowVs * tokens <= b * cost * nowVt;
}

// ---- per-coin state ----
interface CoinState {
  mint: string;
  lastVs: bigint; // virtual SOL reserves at the latest price
  lastVt: bigint; // virtual token reserves at the latest price
  peakVs: bigint; // peak price since the current position opened
  peakVt: bigint;
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
  triggerArmed: boolean; // real reserves first reached 3 SOL
  triggerVs: bigint; // price when the trigger armed
  triggerVt: bigint;
  peakTrigVs: bigint; // highest price since the trigger armed
  peakTrigVt: bigint;
  buyPending: boolean; // a buy order is out and its fill has not come back
  sellPending: boolean; // a sell order is out and its fill has not come back
  buyRejectedSlot: number; // slot of the last rejected buy, for a retry cooldown
  hasPosition: boolean;
  entryCost: bigint; // cost_lamports of the open position
  entryTokens: bigint; // token_amount of the open position
  entrySlot: number; // slot when the open position first appeared
  syncSeen: boolean; // set while syncing this batch's account snapshot
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
  // Live buy candidates: trigger armed, not completed, no position, no
  // buy pending, fewer than 3 round trips, not cooling down. Only these
  // are ever considered for a buy, and only the dirty ones are
  // re-evaluated in a batch.
  private candidates = new Set<CoinState>();
  private dirty = new Set<CoinState>();
  // Coins waiting out a cooldown, mapped to the first slot they may be
  // considered again (exit cooldown or rejected-buy cooldown).
  private cooling = new Map<CoinState, number>();
  // Open positions, at most 5. Only these are ever considered for a sell.
  private openPositions = new Set<CoinState>();
  private orderCounter = 0;
  private cashLamports = 0n;
  private openPositionCount = 0;
  private reservedLamports = 0n; // cash spoken for by buys still awaiting fills
  private pendingBuys = new Map<string, bigint>(); // client_id -> reserved lamports
  private fullRescan = false; // cash or a position slot freed: re-check all candidates

  private coin(mint: string, slot: number, vs: bigint, vt: bigint): CoinState {
    let c = this.coins.get(mint);
    if (!c) {
      c = {
        mint,
        lastVs: vs,
        lastVt: vt,
        peakVs: vs,
        peakVt: vt,
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
        triggerArmed: false,
        triggerVs: 0n,
        triggerVt: 0n,
        peakTrigVs: 0n,
        peakTrigVt: 0n,
        buyPending: false,
        sellPending: false,
        buyRejectedSlot: -1_000_000,
        hasPosition: false,
        entryCost: 0n,
        entryTokens: 0n,
        entrySlot: 0,
        syncSeen: false,
      };
      this.coins.set(mint, c);
    }
    return c;
  }

  // Admit a coin to the buy-candidate set when it is eligible in every
  // way except price and cash, which are checked at evaluation time.
  private maybeCandidate(c: CoinState): void {
    if (
      c.triggerArmed &&
      !c.completed &&
      !c.hasPosition &&
      !c.buyPending &&
      c.roundTrips < MAX_ROUND_TRIPS_PER_MINT &&
      !this.cooling.has(c)
    ) {
      this.candidates.add(c);
    }
  }

  private dropCandidate(c: CoinState): void {
    this.candidates.delete(c);
    this.dirty.delete(c);
  }

  // Put a coin on cooldown until the given slot; a later cooldown only
  // ever extends the wait, never shortens it.
  private coolDown(c: CoinState, untilSlot: number): void {
    const prev = this.cooling.get(c);
    if (prev === undefined || untilSlot > prev) this.cooling.set(c, untilSlot);
  }

  // Record the latest real reserves for a coin, and arm the trigger the
  // first time reserves reach 3 SOL: the trigger price is the price at
  // that moment, and the peak since the trigger tracks how far the price
  // has run past it. A coin whose peak already ran more than 30% past
  // the trigger can never be bought again, so it leaves the candidates.
  private refreshReserves(c: CoinState, realSolReserves: bigint): void {
    c.realSolReserves = realSolReserves;
    if (!c.triggerArmed && realSolReserves >= BUY_MIN_REAL_SOL) {
      c.triggerArmed = true;
      c.triggerVs = c.lastVs;
      c.triggerVt = c.lastVt;
      c.peakTrigVs = c.lastVs;
      c.peakTrigVt = c.lastVt;
      this.maybeCandidate(c);
    }
    if (
      c.triggerArmed &&
      priceAbove(c.lastVs, c.lastVt, c.peakTrigVs, c.peakTrigVt)
    ) {
      c.peakTrigVs = c.lastVs;
      c.peakTrigVt = c.lastVt;
      if (
        riseAboveBps(
          c.peakTrigVs,
          c.peakTrigVt,
          c.triggerVs,
          c.triggerVt,
          BigInt(PEAK_SINCE_TRIGGER_MAX_BPS),
        )
      ) {
        this.dropCandidate(c);
      }
    }
  }

  // Record a fresh price for a coin: last price and peak of an open position.
  private notePrice(c: CoinState, vs: bigint, vt: bigint): void {
    c.lastVs = vs;
    c.lastVt = vt;
    if (c.hasPosition && priceAbove(vs, vt, c.peakVs, c.peakVt)) {
      c.peakVs = vs;
      c.peakVt = vt;
    }
  }

  private noteTrade(
    mint: string,
    slot: number,
    vs: bigint,
    vt: bigint,
    isBuy: boolean,
    solAmount: bigint,
    realSolReserves: bigint,
  ): void {
    const c = this.coin(mint, slot, vs, vt);
    c.lastSlot = slot;
    this.notePrice(c, vs, vt);
    this.refreshReserves(c, realSolReserves);
    c.trades += 1;
    if (isBuy) {
      c.buys += 1;
      c.buyVol += solAmount;
    } else {
      c.sells += 1;
      c.sellVol += solAmount;
    }
    // A coin whose own price or reserves moved may have become buyable
    // (or unbuyable), so it is re-evaluated this batch.
    if (this.candidates.has(c)) this.dirty.add(c);
  }

  // Sync open positions from the harness account snapshot (ground truth).
  private syncAccount(account: any, slot: number): void {
    const cash = u64(account?.cash_lamports);
    const positions = Array.isArray(account?.positions) ? account.positions : [];
    // More cash, or a freed position slot, can make a candidate that was
    // skipped before buyable now, so every candidate is re-checked.
    if (cash > this.cashLamports || positions.length < this.openPositionCount) {
      this.fullRescan = true;
    }
    this.cashLamports = cash;
    this.openPositionCount = positions.length;
    for (const p of positions) {
      const mint = String(p.mint);
      const cost = u64(p.cost_lamports);
      const tokens = u64(p.token_amount);
      const c = this.coins.get(mint);
      if (!c) continue; // a position in a coin we never saw: hold it, do not trade it
      c.syncSeen = true;
      if (!c.hasPosition) {
        // A fresh position: record its entry and reset the peak to now.
        c.hasPosition = true;
        c.entryCost = cost;
        c.entryTokens = tokens;
        c.entrySlot = slot;
        c.peakVs = c.lastVs;
        c.peakVt = c.lastVt;
        this.openPositions.add(c);
        this.dropCandidate(c);
      } else {
        c.entryCost = cost;
        c.entryTokens = tokens;
      }
    }
    for (const c of this.openPositions) {
      if (!c.syncSeen) {
        // Position closed (sold, completed or written off) since last batch.
        c.hasPosition = false;
        c.roundTrips += 1;
        c.lastExitSlot = slot;
        c.entryCost = 0n;
        c.entryTokens = 0n;
        this.openPositions.delete(c);
        if (!c.completed && c.roundTrips < MAX_ROUND_TRIPS_PER_MINT) {
          this.coolDown(c, slot + REENTRY_COOLDOWN_SLOTS);
        }
      } else {
        c.syncSeen = false;
      }
    }
  }

  private buySize(realSolReserves: bigint): bigint {
    const cap = (realSolReserves * BigInt(BUY_SIZE_BPS_OF_RESERVE)) / 10_000n;
    const size = cap < BUY_SIZE_MAX ? cap : BUY_SIZE_MAX;
    return size;
  }

  // The buy size when every gate except cash passes, else 0. Cash is
  // applied later, in mint order, because it depends on the buys already
  // queued in the same batch.
  private buySizeIfEligible(c: CoinState, slot: number, realSolReserves: bigint): bigint {
    if (c.completed) return 0n;
    if (c.hasPosition) return 0n;
    if (c.buyPending) return 0n; // an earlier buy is still awaiting its fill
    if (c.roundTrips >= MAX_ROUND_TRIPS_PER_MINT) return 0n;
    if (slot - c.lastExitSlot < REENTRY_COOLDOWN_SLOTS) return 0n;
    if (slot - c.buyRejectedSlot < BUY_RETRY_COOLDOWN_SLOTS) return 0n;
    if (c.trades < ENTRY_MIN_TRADES) return 0n;
    if (realSolReserves < BUY_MIN_REAL_SOL) return 0n;
    if (!c.triggerArmed) return 0n;
    // Never chase: the trigger edge is gone once the price has run more
    // than 10% past the trigger price — that entry is a top, not a start.
    if (
      riseAboveBps(
        c.lastVs,
        c.lastVt,
        c.triggerVs,
        c.triggerVt,
        BigInt(ENTRY_MAX_ABOVE_TRIGGER_BPS),
      )
    ) {
      return 0n;
    }
    // And never buy a retrace: if the price already ran 30% past the
    // trigger and came back, the move happened without us.
    if (
      riseAboveBps(
        c.peakTrigVs,
        c.peakTrigVt,
        c.triggerVs,
        c.triggerVt,
        BigInt(PEAK_SINCE_TRIGGER_MAX_BPS),
      )
    ) {
      return 0n;
    }
    const size = this.buySize(realSolReserves);
    if (size < BUY_SIZE_MIN) return 0n;
    return size;
  }

  // Returns true when the open position in this coin should be sold now.
  private shouldSell(c: CoinState, slot: number): boolean {
    if (!c.hasPosition) return false;
    if (c.sellPending) return false; // a sell is already awaiting its fill
    if (c.completed) return true;
    // Take profit at +80%: 5 * nowVs * tokens >= 9 * cost * nowVt.
    if (entryRiseAtLeast(c.lastVs, c.lastVt, c.entryCost, c.entryTokens, 5n, 9n)) {
      return true;
    }
    // Stop loss at -5%: 20 * nowVs * tokens <= 19 * cost * nowVt.
    if (entryRiseAtMost(c.lastVs, c.lastVt, c.entryCost, c.entryTokens, 20n, 19n)) {
      return true;
    }
    // Trailing exit, armed at +20% from the peak: 5 * peakVs * tokens >=
    // 6 * cost * peakVt; then sell on a 10% fall from the peak:
    // 10 * peakVs * lastVt >= 11 * lastVs * peakVt.
    if (entryRiseAtLeast(c.peakVs, c.peakVt, c.entryCost, c.entryTokens, 5n, 6n)) {
      if (
        c.lastVt > 0n &&
        c.peakVt > 0n &&
        c.lastVs > 0n &&
        10n * c.peakVs * c.lastVt >= 11n * c.lastVs * c.peakVt
      ) {
        return true;
      }
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
        const c = this.coin(
          mint,
          evSlot,
          u64(e.virtual_sol_reserves),
          u64(e.virtual_token_reserves),
        );
        c.lastSlot = evSlot;
        c.realSolReserves = 0n; // a fresh curve holds no real SOL yet
        if (e.is_mayhem_mode === true) c.completed = true;
      } else if (e.event === "TradeEvent") {
        this.noteTrade(
          mint,
          evSlot,
          u64(e.virtual_sol_reserves),
          u64(e.virtual_token_reserves),
          e.is_buy === true,
          u64(e.sol_amount),
          u64(e.real_sol_reserves),
        );
      } else if (e.event === "CompleteEvent") {
        const c = this.coins.get(mint);
        if (c) {
          c.completed = true;
          c.lastSlot = evSlot;
          this.dropCandidate(c);
          this.cooling.delete(c);
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
      const c = this.coins.get(mint);
      if (c) {
        c.lastSlot = typeof m.slot === "number" ? m.slot : slot;
        this.notePrice(c, u64(m.virtual_quote_reserves), u64(m.virtual_token_reserves));
        this.refreshReserves(c, u64(m.real_quote_reserves));
        if (this.candidates.has(c)) this.dirty.add(c);
      }
    }

    // Fills report what happened to the orders of earlier batches. Clear
    // the pending flag they answer so a coin is never ordered twice for
    // the same intent, remember rejected buys for a retry cooldown, and
    // release the cash a filled or rejected buy had reserved.
    const fills = Array.isArray(batch.fills) ? batch.fills : [];
    let freedReserved = false;
    for (const f of fills) {
      const c = this.coins.get(String(f.mint));
      if (!c) continue;
      if (f.side === "buy") {
        c.buyPending = false;
        const reserved = this.pendingBuys.get(String(f.client_id));
        if (reserved !== undefined) {
          this.pendingBuys.delete(String(f.client_id));
          this.reservedLamports -= reserved;
          freedReserved = true;
        }
        if (f.status === "rejected" || f.status === "failed") {
          c.buyRejectedSlot = slot;
          if (c.triggerArmed && !c.completed && c.roundTrips < MAX_ROUND_TRIPS_PER_MINT) {
            this.coolDown(c, slot + BUY_RETRY_COOLDOWN_SLOTS);
          }
        }
      } else if (f.side === "sell") {
        c.sellPending = false;
      }
    }
    if (freedReserved) this.fullRescan = true;

    this.syncAccount(batch.account, slot);

    // Cooldowns that expired this batch make their coins candidates
    // again, and they are re-evaluated now.
    if (this.cooling.size > 0) {
      for (const [c, until] of this.cooling) {
        if (slot >= until) {
          this.cooling.delete(c);
          const before = this.candidates.size;
          this.maybeCandidate(c);
          if (this.candidates.size > before) this.dirty.add(c);
        }
      }
    }

    const orders: any[] = [];
    const maxOrders = Math.max(0, this.config.maxOrdersPerBatch);

    // Sells first, mint-sorted, from the open positions only.
    const held = [...this.openPositions].sort((a, b) =>
      a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0,
    );
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

    // Buys next, mint-sorted, while a position slot is free. Only the
    // candidates that moved this batch (or every candidate, when cash or
    // a slot freed up) are evaluated; the eligible ones are then walked
    // in mint order with the cash check applied as buys are queued, which
    // is exactly the order the full scan used to produce.
    let freeSlots =
      this.config.maxOpenPositions - this.openPositionCount + sells;
    if (this.fullRescan) {
      for (const c of this.candidates) this.dirty.add(c);
      this.fullRescan = false;
    }
    const eligible: { c: CoinState; size: bigint }[] = [];
    for (const c of this.dirty) {
      const size = this.buySizeIfEligible(c, slot, c.realSolReserves);
      if (size > 0n) eligible.push({ c, size });
    }
    this.dirty.clear();
    eligible.sort((a, b) =>
      a.c.mint < b.c.mint ? -1 : a.c.mint > b.c.mint ? 1 : 0,
    );
    let spent = 0n;
    for (const { c, size } of eligible) {
      if (orders.length >= maxOrders) break;
      if (freeSlots <= 0) break;
      // Cash left after the buys already queued in this batch and the buys
      // of earlier batches still awaiting their fills.
      const available = this.cashLamports - spent - this.reservedLamports;
      // Keep enough cash for the trade plus its variable and fixed fees.
      const need = size + (size * BigInt(FEE_BPS)) / 10_000n + TX_FEE_LAMPORTS;
      if (available < need) continue;
      spent += need;
      c.buyPending = true;
      this.dropCandidate(c);
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
  // Offset-based line reader: the buffer is never copied per line, only
  // compacted when a chunk boundary leaves a partial line behind.
  let buf = Buffer.alloc(0);
  let start = 0;
  const handleLine = (line: string): void => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      bot.handleHello(msg);
    } else if (msg.type === "batch") {
      const reply = bot.handleBatch(msg);
      process.stdout.write(JSON.stringify(reply) + "\n");
    } else if (msg.type === "done") {
      process.exit(0);
    }
  };
  process.stdin.on("data", (chunk: Buffer) => {
    if (start > 0) {
      buf = Buffer.from(buf.subarray(start));
      start = 0;
    }
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let idx = buf.indexOf(10, start);
    while (idx !== -1) {
      handleLine(buf.toString("utf8", start, idx));
      start = idx + 1;
      idx = buf.indexOf(10, start);
    }
    if (start >= buf.length) {
      buf = Buffer.alloc(0);
      start = 0;
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

main().catch(() => process.exit(1));
