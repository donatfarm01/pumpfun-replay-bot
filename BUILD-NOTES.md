Build notes for the pump.fun replay sprint bot.

The entry is a single TypeScript file at the repository root, written from the
replay protocol schema and the competition rules alone. The bot talks to the
house harness over standard input and standard output using newline delimited
JSON. The harness sends one hello message first, then one batch message per
slot window, then a done message. The bot answers each batch with one reply
that carries the same sequence number and a list of orders.

The strategy is an earliest entry scalper. The first version waited for a
ten percent rise with buy dominance before buying, and the local grade of
that version lost almost eight SOL with a win rate near twenty percent and a
drawdown near eighty percent: buying after a rise means buying the top of
the first spike. An offline analysis of the development window then showed
the edge sits at the earliest tradable moment instead. Coins bought the first
time their real reserves reach about one and a fifth SOL reach plus thirty
percent before minus fifteen percent about sixty four percent of the time,
while coins bought after a ten percent rise win that race only about half
the time, and coins bought on a dip after a twenty percent fall win it only
about a quarter of the time. The median coin reaches its highest price
within about two thousand slots of that trigger, and the gains fade after
that, so positions are held at most that long. The current version therefore
buys at the trigger, never chases a coin that already ran more than fifty
percent from first sight, and exits on take profit at eighty percent, stop
loss at fifteen percent, a trailing exit armed at thirty percent, or a time
exit after two thousand slots.

That version still lost about one and eight tenths SOL on the local grade,
with a win rate near twelve percent and more than two hundred thousand
rejected orders. Two faults explained it. First, the entry was measured
from the creation price, so by the time a free position slot appeared the
price was often far above the trigger price where the edge lives. Second,
the bot re-emitted a buy for the same coin in every batch while its earlier
order still awaited a fill, which flooded the harness with orders that could
only be rejected for insufficient cash or size. The current version measures
every entry from the trigger price and refuses entries more than fifteen
percent above it, takes profit at fifty percent instead of eighty, and tracks
pending orders: a coin with a buy or sell still awaiting its fill is never
ordered again for the same intent, and a rejected buy waits a thousand slots
before it may be retried.

The local grade still showed every token losing on balance, with only
fifty-four of three hundred seventy-two tokens ahead and a win rate near
fourteen percent, far below the fifty-six percent the offline race promised
for trigger entries. The gap is execution, not the signal: a fill lands two
slots after the decision, so with ten percent of slippage a buy could fill
far above the price that was decided on, and a sell allowed twenty-five
percent could fill far below it, giving the crash away. A sweep of exit
rules over the dev data, with instant fills at trigger prices, showed every
reasonable exit rule profitable — the best was take profit eighty percent,
stop loss fifteen percent, a trailing exit armed at thirty percent with a
twenty percent drop, and a ten-thousand-slot hold — and showed that entering
later, at three SOL of real reserves with a bigger size, earns about twice
as much as entering at one point two SOL. The current version therefore
buys at three SOL of real reserves, takes profit at eighty percent, holds up
to ten thousand slots, and lets every order fill only within two percent of
its decision price: a rejected order costs nothing, so the bot waits for a
fill near its price instead of paying the move.

That still lost about one SOL on the local grade, with a win rate near
eighteen percent. A faithful replay of the harness showed why: the trigger
edge lives inside a single slot. A coin that wins from its trigger price
has usually already surged by the batch-end price, the only price a bot
can pay, and from that price every entry window loses money — the move is
over before the bot can act. The coins the bot did buy were the ones that
had not surged, which is why they kept losing. What looked like a way out
was a steady grind instead: a coin up more than fifteen percent over five
hundred slots without a ten percent pullback. But that turned out to be
the same mirage measured differently. The rise is really one big trade,
not a grind — there are almost no coins whose price climbs fifteen percent
without a single trade jumping it more than two percent — and a two-slot
delay in entering flips the signal from sixty-four percent winners to
twenty-three percent. A dip-buy, a slow build to the trigger, and holding
high-reserve coins for completion were all tested the same way and all
lost money at batch granularity. The only thing that helped was cutting
losers faster: a sweep of exit rules at batch-end prices showed a stop
loss of minus five percent with a trailing exit armed at twenty percent
and a ten percent drop loses about half as much as the wider exits. The
current version therefore keeps the earliest entry at three SOL of real
reserves and exits at take profit eighty percent, stop loss minus five
percent, trailing twenty over ten, and a ten-thousand-slot hold. On the
local grade it loses about a third of a SOL, with a win rate near sixteen
percent and a maximum drawdown near six percent — the smallest loss of
every version tried, and the only one whose ninety-percent interval
reaches above zero.

A position is sold in full when any exit rule fires. A completed bonding
curve sells immediately. The open position count and the cash balance are
taken from the account snapshot in each batch, never from local guesses, so a
rejected or failed fill cannot desynchronise the bot. At most five positions
are open at once and at most sixteen orders go out in one batch.

Determinism was a design constraint from the start. All money math uses
integer lamports. Prices are compared as rational pairs of virtual reserves,
so no floating point number ever decides a trade. There is no clock, no
unseeded randomness and no network access anywhere in the code. Orders are
emitted sells first and then buys, both in mint sorted order, and each order
carries a client identifier from a simple counter, so the same batch stream
always produces the same reply stream byte for byte.

The minimum bar shaped two choices. A round trip must be at least one
hundredth of a SOL on each of at least twenty coins, so the buy size floor
is exactly that amount and the entry filter only admits coins whose reserves
allow a buy of that size under the order cap. Maximum drawdown is fifty
percent, so the stop loss and the trailing exit cap the loss on any single
position, and at most five small positions are open at once, which bounds
how much of the ten SOL of paper capital is at risk at any moment.

Local verification used the kit command line grade local with the process
driver on the published development window, run twice to compare the action
logs, plus the kit check without transcripts. The numbers from those runs
are recorded in the build report handed to the parent, not in this file.

A later round of the same entry was rejected by the grader with a run
completes timeout, so the bot was reworked for speed without touching the
trading rules. The cause was work that grew with every coin ever seen:
each batch rebuilt and sorted the whole coin list twice, scanned it once
more to sync the account, and recomputed several BigInt divisions per
trade, while the input reader copied the unread tail of its buffer once
per line. On the development window that already cost the bot about
thirteen seconds of processor time per run, and the final window is a
much larger slice of the same stream on a single processor, so the same
code would run out of its thirty-minute budget there. The fix keeps a
small live set of buy candidates and a small set of open positions, and
re-evaluates a candidate only when its own price or reserves moved, when
a cooldown of its own expired, or when cash or a position slot freed up
for every candidate at once. Price rises are compared by
cross-multiplication against the entry and exit thresholds instead of
being computed as divisions, prices are kept as plain pairs of integers
instead of fresh objects per event, and the input reader walks one
buffer with an offset. The trading rules, constants, order of orders and
mint ordering are unchanged, and the reworked bot produces the same
action log byte for byte as the version before it on the development
window, with the same net profit and loss and the same guardrail
results, while using about two seconds of processor time per run instead
of about thirteen.
