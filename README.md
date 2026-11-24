# pumpfun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/donatfarm01/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/donatfarm01/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Build a bot that trades 10 SOL of paper money on a 24h pump.fun replay. Best net PnL wins. Free to enter.

An earliest-entry scalper for the pump.fun bonding curve, written in TypeScript for the agent-fun/replay/v2 harness. It reads the harness hello and batch messages on stdin and answers each batch with one reply line of orders on stdout. A coin becomes a buy candidate at the first moment a trade of 0.01 SOL fits under the 1 percent of real reserve order cap, when its real SOL reserves reach 3 SOL, and only while its price is still within 10 percent of that trigger price and never ran 30 percent past it, so a late entry never chases a run. Buys are sized up to 0.25 SOL and at most 0.9 percent of real reserves, about 0.027 SOL at the trigger. Every order allows only 2 percent of slippage, so a fill two slots later lands near the decision price instead of paying the move. Positions exit on take profit at plus 80 percent, stop loss at minus 5 percent, a trailing exit once 20 percent up, a time exit after about 10000 slots, or immediately when the bonding curve completes. All money math is integer lamports, prices are compared as rational reserve pairs, and there is no clock, no randomness and no network use, so two runs over the same data produce the same action log.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=donatfarm01&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
