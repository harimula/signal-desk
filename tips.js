// Signal Desk hover help — one engine for every page (index.html, retire.html, rentemi.html).
// Any table header, stat title, field label or chip whose text is in TIPS below gets a subtle dotted underline;
// hovering (mouse), tapping (touch) or focusing it shows a small card that explains it. Screen readers get the same
// text through aria-describedby. Add an explanation = add one line to TIPS; nothing else to wire up.
(function () {
  'use strict';
  const T = {
    // ---------- tables: screener / watch lists ----------
    'symbol': 'The stock’s ticker and company name. Tap a row for the full breakdown: chart, score parts and the reasons behind the rating.',
    'rating': 'The site’s verdict from the score: Top Buy (60+), Buy (25+), Hold, Sell (below −25), Top Sell (below −60). Top Buy also needs 6 of the 8 trend-template points. Rule-based, not advice.',
    'score': 'A −100…+100 number combining trend (price vs the 20/50/100/200-day averages), momentum (MACD, RSI), relative strength vs the market, volume and the trend template. Higher = stronger setup.',
    'price now': 'The latest price: live when a Finnhub key is saved on this device, otherwise the last refresh (about every 10 minutes in market hours).',
    'price': 'The latest price the page has for this stock.',
    'day %': 'Change since yesterday’s close.',
    'call price': 'The price when the current rating was first given. Compare it with today’s price to see how the call has done.',
    'since call': 'How far the price has moved since the rating was given. “against” means it moved the wrong way for that call (down after a Buy, up after a Sell).',
    'street': 'Wall Street analysts’ average recommendation (Strong buy … Sell) and how many analysts cover the stock. Source: Yahoo Finance.',
    'target δ': 'How far the analysts’ average 12-month price target is above (+) or below (−) today’s price.',
    'trend': 'The last few months of closing prices as a small line, with today’s dot at the end.',
    'rsi': '14-day Relative Strength Index, 0–100. Above 70 is stretched (overbought), below 30 is washed out (oversold).',
    'rsi-2': 'A 2-day RSI, 0–100: the bot’s dip signal. Below the buy level (10 by default) in an uptrend means a sharp short-term pullback — the moment the strategy buys.',
    '20d %': 'Price change over the last 20 trading days (about one month).',
    '60d %': 'Price change over the last 60 trading days (about three months).',
    'vs 52w high': 'How far the price is below its highest close of the past year. Near 0% = trading at the top of its range.',
    'entry zone / trigger': 'The price area where the rules would buy: a pullback zone for an uptrend, or the breakout level it must clear first.',
    'stop / watch': 'Where the idea is wrong: the stop-loss price for a buy, or the level to watch for a sell.',
    'industry': 'The stock’s industry group. The heat map and sector limits use it.',
    '★': 'Add the stock to your watchlist. The “★ Watchlist” filter then shows only these.',
    'signal': 'What today’s rules say for this stock: buy, sell, or wait — and why.',
    'buy at': 'The limit price the rules would buy at.',
    'sell at': 'The price at which the rules would take profit.',
    'sell near': 'The price level where the rules would sell.',
    'stop': 'The stop-loss: the price where the trade is closed to cap the loss.',
    'last day': 'How these rules did on this stock on the most recent trading day.',
    '45-day total': 'How these rules did on this stock over the last 45 trading days, added up.',
    'track record': 'How the signal has worked on this stock recently: hits vs misses.',
    'range': 'Today’s low to high.',
    // ---------- tables: bot ----------
    'what': 'The stock, or the option contract (CALL or PUT with strike and expiry).',
    'type': 'Stock, or an option (CALL = bet on a rise, PUT = bet on a fall).',
    'qty': 'Shares held, or option contracts (each contract = 100 shares).',
    'bought': 'When the position was bought, or the price paid.',
    'bought at': 'Average price paid per share (per contract for options).',
    'now': 'The current price per share (per contract for options).',
    'p/l $': 'Profit or loss in dollars, unrealized for open positions.',
    'p/l %': 'Profit or loss as a percentage of what was paid.',
    'status': 'Where the stock stands against the bot’s rules right now.',
    'stock': 'The stock’s ticker.',
    '200-day': 'The 200-day moving average. The bot only buys dips in stocks trading above it (an uptrend); PUTs need it below.',
    'buys / calls if it…': 'The closing price that would push RSI-2 below the buy level. The bot then buys shares and/or a CALL (next morning, or at once with Intraday signals on).',
    'put if it…': 'The closing price that would push RSI-2 above the PUT level in a downtrend — the mirror of the dip buy.',
    'position': 'What the bot holds: shares or an option contract.',
    'sells when': 'The exit rule: the price close that triggers the sale (the 5-day average) or the time limit.',
    'safety exits': 'Protective exits that work at any time: the hard-floor stop for shares; take-profit, stop and expiry rule for options.',
    'setup right now': 'A day-trading pattern firing at this moment: ORB = opening-range breakout, VWAP = pullback to the volume-weighted average price.',
    'side': 'Long = bet on a rise (shares or CALL). Short = bet on a fall (bought as a PUT; the bot never shorts stock).',
    'entry': 'The price the day trade would buy at.',
    'target': 'The take-profit price: the risk (entry minus stop) times the target multiple.',
    'rel. vol': 'Relative volume: today’s trading so far vs a normal day by this time. 1.5× = 50% busier than usual.',
    'why': 'The reason the setup fired, in plain words.',
    'open day trade': 'A day trade the bot has on right now. It is always sold before the close.',
    'opened': 'When the day trade was opened (Eastern time).',
    // ---------- tables: research / performance ----------
    'yearly return': 'Compound growth per year in the test (CAGR), after trading costs.',
    'sharpe': 'Return per unit of risk (volatility). Above 1 is good; above 2 is excellent.',
    'max drawdown': 'The worst drop from a peak to a later low during the test — the pain you would have sat through.',
    'rules': 'The rule settings used for this row of the test.',
    'trades': 'How many trades the rules made.',
    'win': 'Share of trades that made money.',
    'win rate': 'Share of trades that made money.',
    'avg r': 'Average result per trade in R, where 1R = the money risked. +0.2R means each trade made a fifth of its risk on average.',
    'per trade': 'Average dollars made or lost per trade.',
    'profit factor': 'Money won ÷ money lost. Above 1.0 makes money; 1.5+ is solid.',
    'worst run': 'The deepest losing streak, in R.',
    'years +': 'How many of the tested years ended positive.',
    'expectancy': 'Average profit per trade. Above $0 over 50+ trades is what a real edge looks like.',
    'net p/l': 'Total profit minus total loss.',
    // ---------- tables: news / rules / options ----------
    'when': 'Date and time (Eastern).',
    'event': 'The scheduled release or headline.',
    'what to expect': 'Why it matters and how markets usually react.',
    'component': 'One building block of the score.',
    'meaning': 'What this part measures and how it counts.',
    'rule': 'The rule in plain words.',
    // ---------- India bot (simulation) ----------
    'value now': 'What the simulated ₹ stake is worth today: cash plus every open position at its last close.',
    'nifty 50 since start': 'How the Nifty 50 index moved since the simulation started — the bar to beat. Simply holding an index fund would have done this.',
    'last close': 'The stock’s closing price on the day the buy was planned.', 'money set aside': 'Rupees reserved for this buy: 10% of the strategy’s money (whole shares are bought at the next open).',
    'bought on': 'The trading day the simulated buy filled at the opening price.', 'p/l ₹': 'Profit or loss in rupees after the 0.15% costs on each side.',
    '50-day high': 'The highest close of the previous 50 trading days. A close above it, in an uptrend, is the breakout buy signal.', 'gap': 'How far the price still is below its 50-day high.',
    'buys if it…': 'The closing price that would push RSI-2 under the buy level, making it a buy for the next open.', 'at': 'The price of that buy or sell.', 'sold on': 'The trading day the simulated sale filled at the close.',
    'reason': 'Which exit rule fired.', 'strategy': 'Which of the two strategies made this trade: trend breakout or RSI-2 dip buying.',
    'simulated stake': 'How many rupees the India simulation treats as her money. Applies when the simulation restarts.',
    'share for trend breakout': 'How the stake is split: this % to trend breakout, the rest to RSI-2. Applies on restart.',
    'money per position': 'Each buy uses this % of that strategy’s money (10% was tested).', 'max positions per strategy': 'Most stocks one strategy holds at once (6 was tested).',
    'rsi-2 max hold': 'Sell after this many sessions if the exit rule has not fired.',
    'trend breakout': 'Buys a stock that closes at a 50-day high while above its 200-day average; sells on a close below its 20-day low. The best NSE test result.',
    'rsi-2 dip buying': 'The US bot’s strategy: buy an uptrend stock after a sharp 2-day dip, sell on the bounce. Weaker on NSE because of costs.',
    'india telegram summary': 'One Telegram message after each NSE day with the simulated buys, sells and value against the Nifty 50.',
    '5 years': 'The bot’s exact rules replayed on real prices over the last 5 years from a fresh start, next to index funds you could simply have bought.',
    'per year': 'Average growth per year over the 5 years (compound annual growth rate).', 'worst fall': 'The biggest drop from a high point to a later low during the 5 years.',
    // ---------- stat boxes ----------
    'today': 'Change in account value since yesterday’s close (open and closed trades together).',
    'realized today': 'Profit or loss locked in by trades closed today.',
    'total realized': 'Profit or loss from every closed trade since the bot started.',
    'in trades now': 'What every open position is worth right now, and the share of your stake (or account) that is.',
    'your stake': 'The money you told the bot to treat as yours (Bot settings → 3). “now” = stake + all profits and losses.',
    'account value': 'Total value of the practice account (cash + positions).',
    'closed trades': 'Round trips finished (bought and sold), with the share that made money.',
    'expectancy / trade': 'Average profit per closed trade.',
    'avg win / avg loss': 'The average winning trade vs the average losing trade.',
    'worst drawdown': 'The biggest drop in closed-trade profit from a high point.',
    'days counted': 'How many trading days are in this tally.',
    'working today': 'Trades the rules have open today.',
    'started with': 'Money at the start of the test period.',
    'finished with': 'Money at the end of the test period.',
    'result': 'Total gain or loss over the period.',
    'total since you started': 'Everything gained or lost since tracking began.',
    'trades won': 'Share of trades that made money.',
    'for every $1 lost, it won': 'Profit factor in words: dollars won for each dollar lost.',
    'worst dip along the way': 'The deepest fall from a high during the period.',
    'strike · expiry': 'The option’s strike price and expiry date.',
    'premium ≈': 'Estimated price of the option per share; one contract costs 100× this.',
    'stop at': 'Price where the trade would be closed to limit the loss.',
    'buy when stock dips to': 'The stock price that triggers the option buy.',
    'buy when stock rises to': 'The stock price that triggers the option buy on a breakout.',
    // ---------- Bot settings ----------
    'alpaca api key': 'Your Alpaca paper-trading key. It is sealed in this browser and stored only as a GitHub secret; the page never keeps it.',
    'alpaca secret': 'The secret that goes with the Alpaca key. Sealed and stored the same way.',
    'journal passphrase': 'Encrypts the bot’s journal on the public site and signs you in on other devices. Use 12+ characters and keep it safe — it is your account password.',
    'live api key': 'Only for real money. Leave empty while practising.',
    'live secret': 'Only for real money. Leave empty while practising.',
    'trade stocks': 'Buy shares on RSI-2 dips (held 1–10 days).',
    'trade call options': 'Also buy a CALL on the same dips — more leverage, more risk.',
    'trade put options': 'Buy a PUT when a downtrend stock pops (RSI-2 high). Experimental.',
    'intraday signals': 'Use the live price during the day instead of waiting for the close. More trades; this variant was never backtested.',
    'scan the whole market': 'Each morning, pick the most-traded US stocks (by dollar volume) instead of a fixed list.',
    'only my list': 'Watch only the stocks you list in section 6.',
    'how many stocks to watch': 'How many of the most-traded stocks the morning scan keeps.',
    'minimum share price': 'Skip stocks below this price (penny stocks move erratically).',
    'money the bot works with': 'Your stake: sizes, loss limits and the pattern-day-trader rule are worked out on this amount instead of the whole account. 0 = the whole account.',
    'size it in': 'Size each trade as a % of your money, or as a fixed dollar amount.',
    'per trade, %': 'Most of your money one trade of this kind may use.', 'per trade, $': 'Most dollars one trade of this kind may use.',
    'all stocks together, %': 'Ceiling for all stock positions combined, as a % of your money (0 = no ceiling).', 'all stocks together, $': 'Ceiling in dollars for all stock positions combined (0 = no ceiling).',
    'all calls together, %': 'Ceiling for all CALL positions combined (0 = no ceiling).', 'all calls together, $': 'Ceiling in dollars for all CALLs combined (0 = no ceiling).',
    'all puts together, %': 'Ceiling for all PUT positions combined (0 = no ceiling).', 'all puts together, $': 'Ceiling in dollars for all PUTs combined (0 = no ceiling).',
    'risk per stock trade': 'How much of your money one stock trade may lose if its stop is hit.',
    'risk per option trade': 'How much one option trade may lose at its stop.',
    'total risk cap': 'The most that all open trades together may lose if every stop is hit at once.',
    'max stock positions': 'The most different stocks held at once.',
    'max option positions (calls + puts)': 'The most different option contracts (CALLs and PUTs together) held at once.',
    'max positions per sector': 'Stops the bot piling into one industry.',
    'daily loss limit': 'Down this much today → no new trades until tomorrow (and options are closed). With the money split on, this is the stock part’s limit, as a % of the stock money.',
    'calls share': 'The part of your stake CALL options may use together. Stocks get whatever CALLs, PUTs and SPY don’t (30 CALLs + 10 PUTs + 5 SPY = 55% stocks). Example: $100,000 stake, 30% → up to $30,000 in CALLs.',
    'puts share': 'The part of your stake PUT options may use together. Stocks get whatever CALLs and PUTs don’t.',
    'options daily loss limit': 'If CALLs lose this % of the CALL money in a day, new CALLs stop and open CALLs are closed; the same for PUTs on the PUT money. Stocks and the other option type carry on.',
    'weekly loss limit': 'Down this much this week → no new trades until next week.',
    'losing streak limit': 'This many losing trades in a row today → done for the day.',
    'rsi-2 buy level': 'Buy when RSI-2 drops below this. Lower = fewer, deeper dips. 10 is the tested value.',
    'max hold': 'Sell a stock after this many trading days if the exit rule has not fired.',
    'hard floor': 'Emergency stop: sell if a stock falls this far below its buy price. Placed at the broker, so it works even if the bot is down.',
    'stock stop (hard floor)': 'Sell a stock if it falls this % below its buy price. The stop sits at the broker, so it works even if the bot is down. Tightening it moves the stops of stocks already held.',
    'which dips to buy first': 'When several stocks dip on the same day and the bot has room for only some, this decides the order. Leaders first buys the stocks that beat the market most over the last 3 months; the research found that better than taking the deepest dips.',
    'leaders first': 'Buys the dipping stocks whose 3-month return beat the market most. Strong stocks that stumble tend to bounce back fastest.',
    'deepest dip first': 'Buys the stocks with the lowest RSI-2 first — the order used in the original 33-year test.',
    '3-mo vs market': 'How much the stock’s 3-month return beat (or trailed) the S&P 500. With Leaders first on, the dips with the highest figure are bought first.',
    'short-term tax': 'Your tax rate on gains from positions held a year or less — every bot trade. For a high earner: 37% federal + 3.8% investment-income tax = 40.8%. Change it to your own rate; it is remembered on this device.',
    'long-term': 'Your tax rate on gains from holdings kept over a year — the index funds, if held the whole 5 years. For a high earner: 20% + 3.8% = 23.8%.',
    'before tax': 'What the money became, ignoring taxes.',
    'after tax': 'What you would keep after federal tax: the bot pays short-term tax on each year’s profit; a fund held 5 years pays a little on dividends each year and long-term tax on the gain when sold.',
    'spy money per trade': 'How much of the SPY share one trade may use. 100% = all of it (one $5,000 trade on a $5,000 share); 50% = $2,500 per trade, so a losing trade costs half as much. Lower it to leave room for more than one trade at a time (section 4c).',
    'spy take-profit': 'Sell the SPY option as soon as it is up this % from its buy price. The order rests at the broker, so it fills at exchange speed. Example: bought at $2.00, 15% → sold at $2.30.',
    'spy stop': 'Sell the SPY option when it is down this % from its buy price. Example: bought at $2.00, 15% → sold at about $1.70. Checked on every live quote.',
    'spy time stop': 'Sell the SPY option after this many minutes whatever the price. Quick trades that have not worked by then are closed.',
    'spy trades open at once': 'How many SPY quick trades may be open together. Each needs its own fresh break: a second CALL only when SPY breaks a new, higher 15-minute high; a PUT can open beside a CALL when SPY turns down. It never buys more because a trade is losing. Each trade still uses SPY money per trade.',
    'spy max trades per day': 'The most SPY quick trades in one day. After that the sleeve waits for tomorrow.',
    'spy losses in a row that end its day': 'After this many losing SPY trades in a row, the sleeve stops for the day. The other parts of the bot carry on.',
    'spy daily loss limit': 'If the SPY sleeve loses this % of its own money in a day, it stops for the day and closes its open trade. Example: $5,000 share, 25% → stops after $1,250 lost.',
    'spy expiry, max days out': 'How far out the SPY option may expire, in trading days. 1 = the next trading day. Same-day options are never bought: they lose value fastest.',
    'spy trades from': 'The SPY sleeve opens trades only from this time (ET). Earlier, the 15-minute levels do not exist yet.',
    'spy trades until': 'No new SPY trades after this time (ET). Anything open is closed by its own exits or by 3:45 PM.',
    'day trades from': 'The day-trade engine opens trades only from this time (ET).',
    'day trades until': 'No new day trades after this time (ET). Open day trades are flat by 3:50 PM.',
    'entry window closes at': 'Last time of day (ET) the swing part may buy a dip. Later dips wait for tomorrow. 10:00 AM – 3:45 PM.',
    'last nse day': 'The India simulation’s gain or loss over its most recent NSE trading day.',
    'github token': 'A personal access token that lets this page read and save the bot’s settings in your GitHub repository. It is stored only in this browser (and in your encrypted sync blob).',
    'repository': 'Your GitHub repository, as owner/name, where the bot and its settings live.',
    'sold': 'When the position was sold (New York time).',
    'trade': 'The option contract: SPY, CALL or PUT, and its symbol.',
    'exits': 'The prices and time at which this trade will be closed, whichever comes first.',
    'p/l': 'Profit or loss in dollars, with the percentage of the money put in.',
    'above 50 / 200-day': 'How many of the rated stocks trade above their 50-day and 200-day averages. Both high = a broad, healthy uptrend; both low = a weak market.',
    'buy-rated': 'How many stocks currently score Buy or Top Buy.',
    'sell-rated': 'How many stocks currently score Sell or Top Sell.',
    'hold': 'How many stocks currently score Hold — no edge either way.',
    'breadth above 50-day': 'The share of rated stocks above their 50-day average. Above 50% means most stocks are rising, not just the big names.',
    'top stock': 'The highest-scoring stock right now.',
    'avg since call': 'The average move of every tracked rating since the day it was made — how the calls have done so far.',
    'sector index': 'The index used to measure each Indian sector against the Nifty 50.',
    'at close': 'Figures as of the last completed trading session.',
    'for every ₹1 lost, it won': 'The profit factor: total gains divided by total losses. 1.5 means ₹1.50 was made for every ₹1 lost; below 1 means a losing strategy.',
    'spy quick options': 'An experimental, separate part of the bot: CALLs and PUTs on SPY alone, held minutes. It spends only its own share of the stake and has its own brakes. Not tested on history — judge it on the practice account.',
    'spy quick-options share': 'The part of your money the SPY quick-options trades may use (each trade uses its “money per trade” %, never more than is free). Stocks get whatever is left after CALLs, PUTs and this. The trading rules are in section 4c.',
    'where the money goes': 'All four shares of your stake in one place: stocks, CALLs, PUTs and SPY quick options. Stocks always get whatever the others don’t. The bar shows the split; the total can never exceed 100%.',
    'separate daily loss limits for stocks, calls and puts': 'On: each part has its own daily loss limit and losing-streak count, so a bad day in one never stops the others. Off: one shared pool and one account-wide daily limit. The shares cap each part either way.',
    'losses in a row that end its day': 'After this many losing SPY trades in a row, the sleeve stops for the day.',
    'expiry, max days out': 'How far out the option may expire. 1 = the next trading day. Same-day options are never bought: they lose value fastest.',
    'stock take-profit': 'Sell a stock as soon as it is up this % from its buy price, at any time of day, instead of waiting for the RSI-2 exit at the close. 0 = off.',
    'cancel unfilled entries after': 'Minutes a buy order may wait unfilled before it is cancelled.',
    'option take-profit': 'Sell the option at this % gain.',
    'option stop': 'Sell the option at this % loss. New options are only bought when the bid/ask spread is under half this %, or the stop would fire on the spread alone.',
    'day-trade': 'Turn on same-day trading: opening-range breakouts and VWAP pullbacks on 5-minute bars. The research found no edge — keep it small.',
    'long setups → buy shares': 'When a long setup fires, buy the stock.',
    'long setups → buy a call instead': 'When a long setup fires, buy a short-dated CALL instead of shares.',
    'short setups → buy a put': 'When a short setup fires, buy a PUT (the bot never sells stock short).',
    'opening range': 'Minutes after 9:30 whose high and low form the range a breakout must clear. 15 is typical.',
    'max day trades per day': 'The most day trades in one day, across all stocks.',
    'losses in a row that end the day': 'Day trading stops for the day after this many losers in a row.',
    'risk per day trade': 'Share of your money one day trade may lose at its stop.',
    'minimum relative volume': 'Only trade stocks busier than normal today: 1.2 = 20% more volume than usual by this time.',
    'time stop': 'Close a day trade that has not moved in your favour after this many minutes.',
    'option expiry, max days out': 'Day-trade options expire within this many days (never the same day).',
    'economic calendar guard': 'No new trades around Fed decisions, CPI and jobs reports.',
    'breaking-news guard': 'Pause on war, policy or crisis headlines; skip stocks with fresh company news.',
    'telegram alerts': 'Send every buy, sell, halt and error to your Telegram chat.',
    'include prices and profit in alerts': 'Alerts show size, prices and profit, not just the ticker.',
    'trade real money': 'Switch from the practice account to your real account. Needs live keys and a typed confirmation.',
    'live size': 'With real money, trade at this share of the practice size to start small (25% → 50% → 75% → 100%).',
    // ---------- news chips / sub-views ----------
    'all': 'Every headline.', 'market-moving': 'Only headlines likely to move the whole market.', 'earnings': 'Company results and guidance.',
    'fed & rates': 'Federal Reserve, interest rates and bonds.', 'inflation & jobs': 'CPI, PCE, payrolls and other data releases.', 'geopolitics': 'War, sanctions and diplomacy.',
    'oil & energy': 'Oil, gas and OPEC news.', 'white house & policy': 'Executive orders, tariffs and regulation.', 'crisis': 'Bank failures, crashes and other shocks.',
    'overview': 'Market summary: indexes, breadth and the top-rated stocks.', 'screener': 'Every stock with its rating and score, sortable and filterable.', 'heat map': 'Sectors and stocks coloured by today’s move or score.',
    // ---------- Retirement calculator ----------
    'your age now': 'Your age today; the plan runs from here.', 'retire at age': 'The age you stop working and start drawing on savings.',
    'your yearly income now': 'Your income before tax; used for contributions and the lifestyle you will want to keep.',
    '401(k)': 'Current 401(k) balance (pre-tax: withdrawals are taxed).', 'roth ira': 'Current Roth IRA balance (withdrawals tax-free after 59½).',
    'us portfolio': 'Taxable US brokerage investments.', 'indian portfolio': 'Investments held in India (in rupees, converted with the exchange rate).',
    '529 plan': 'Education savings for the children.', 'custodial account': 'Investments held in the children’s names (UTMA/UGMA).',
    'you add each year': 'New savings added every year until you retire.', 'school for each child': 'Yearly school fees per child.',
    'child 1 age now': 'Used to time school and college costs.', 'child 2 age now': 'Used to time school and college costs.',
    'college per child per year': 'Yearly college cost per child in today’s money.', 'amount left at the end': 'Money you want left at the end of the plan (for heirs or safety).',
    'withdrawal rate': 'Share of savings spent each year in retirement. 4% is the classic sustainable rate.', 'plan to age': 'How long the money must last.',
    'first use of 401(k) and roth': 'The age you begin drawing from retirement accounts (penalty-free from 59½).',
    'us accounts grow': 'Expected yearly return on US investments before retirement.', 'indian portfolio grows': 'Expected yearly return on Indian investments.',
    'money grows after you retire': 'Expected yearly return once retired (usually lower: safer mix).', '529 and custodial grow': 'Expected yearly return on the children’s accounts.',
    'general inflation': 'How fast living costs rise each year.', 'school and college inflation': 'How fast education costs rise (usually faster than general inflation).',
    'tax on 401(k) withdrawals': 'Your expected tax rate on 401(k) money in retirement.', 'years of college': 'Years of college per child.',
    'exchange rate': 'Rupees per US dollar, for converting the Indian side.', 'money grows until you retire': 'Expected yearly return on savings while you are working.',
    'housing (rent)': 'Monthly rent in retirement.', 'maid': 'Monthly household help.', 'cook': 'Monthly cook.', 'driver': 'Monthly driver.', 'nanny or child carer': 'Monthly childcare.',
    'groceries and dining out': 'Monthly food spending.', 'utilities and household': 'Electricity, internet, repairs.', 'healthcare and insurance': 'Insurance premiums and medical costs.',
    'international travel': 'Yearly spend on trips abroad.', 'domestic travel': 'Yearly spend on trips at home.', 'cars and fuel': 'Car costs and fuel.', 'shopping, clubs, entertainment': 'Everything else for enjoyment.',
    'where in bangalore': 'The area sets the typical rent for the home you would live in.', 'bedrooms': 'Home size; rent and costs scale with it.', 'community': 'Gated community or standalone — changes rent and maintenance.',
    // ---------- Rent vs EMI calculator ----------
    'i claim home-loan deductions and hra (old tax regime)': 'Tick if you file under India’s old tax regime: home-loan interest and principal and HRA then cut your tax, which the comparison includes.',
    'cost of house, incl. stamp duty': 'Purchase price plus stamp duty and registration.', 'down payment': 'Cash paid upfront; the rest is the loan.',
    'loan interest rate': 'Yearly home-loan interest rate.', 'loan tenure': 'Years to repay the loan.', 'house price growth per year': 'Expected yearly rise in the home’s value.',
    'yearly rise in running costs': 'How fast maintenance and taxes grow each year.', 'property tax per year': 'Yearly property tax.', 'society maintenance per year': 'Yearly society or HOA charges.',
    'house upkeep per year': 'Repairs and upkeep as a yearly amount.', 'monthly rent': 'Rent for a similar home today.', 'yearly rent increase': 'How much rent rises each year.',
    'deposit, brokerage, upfront costs': 'One-time costs of renting.', 'years you stay': 'How long you will live there — decides which option wins.',
    'return on investments per year': 'What the renter’s saved money earns when invested.', 'tax slab': 'Your income-tax rate, for home-loan and HRA tax benefits.',
    'hra tax saved per year (rent side)': 'Tax saved through House Rent Allowance when renting.', 'down the side': 'What varies along the rows of the grid.', 'across the top': 'What varies along the columns of the grid.', 'grid values': 'What each cell of the grid shows.',
  };
  // short generic words mean different things in a table and in a form: these explanations apply to table headers only
  const TH_ONLY = new Set(['type', 'what', 'qty', 'now', 'status', 'stock', 'price', 'bought', 'side', 'entry', 'why', 'when', 'event', 'rule', 'rules', 'range', 'stop', 'win', 'trades', 'position', 'opened', 'component', 'meaning', 'strategy', 'signal', 'at', 'gap', 'reason']);
  // form labels that share a word with a table header
  const LBL = {
    'type': 'Simple (SMA) weighs every day equally; exponential (EMA) reacts faster to recent prices.',
    'moving average days': 'Adds a moving-average column over this many days to every table and the chart, compared with the latest price.',
    'now': 'The latest price.', 'last trading day': 'The most recent session these figures come from.',
    'ticker': 'The stock symbol (e.g. AAPL; NSE symbols for India, like RELIANCE).', 'market': 'Where the holding trades: USA, India (NSE) or a commodity.',
    'commodity': 'Which metal or commodity, and the unit you hold it in.', 'shares': 'How many shares (or units / grams / ounces) you hold.',
    'avg buy price': 'What you paid per share on average — used for your profit and loss.', 'portfolio name': 'A name for this portfolio, e.g. “Retirement” or “Kids”.',
    'show what i type': 'Shows the passphrase as you type it, to check for typos.',
    'last day': 'Change in value on the last day processed.',
    'target': 'Take-profit for a day trade, as a multiple of the risk (entry minus stop): 2 = aim to make twice what you risk.',
  };
  // dynamic labels
  const PAT = [[/ became$/, 'What the starting amount would be worth at the end of the 5 years.'], [/^20\d\d\*?$/, 'Return in that calendar year (* = part of the year: the 5 years start and end mid-year).'], [/^\d+-day (sma|ema)$/, 'The moving average you chose above (simple or exponential) over this many days, compared with the latest price.'],
    [/^vs \d+d$/, 'How far the price is above (+) or below (−) that moving average.'],
    [/ 20-day vs market$/, 'This sector’s return over the last 20 trading days minus the market index’s. Positive = the sector is leading; negative = lagging. Sectors are shown by their index fund or index symbol.']];
  const norm = s => String(s || '').replace(/[▲▼↑↓⇅]/g, '').replace(/\s+/g, ' ').trim().replace(/[:]$/, '').replace(/\s+\d+$/, '').toLowerCase();
  const lookup = (txt, isTh = true) => { const k = norm(txt), k2 = k.replace(/\s*\(.*\)$/, '').replace(/\s+·.*$/, ''); if (!isTh && (LBL[k] || LBL[k2])) return LBL[k] || LBL[k2]; for (const x of [k, k2]) if (T[x] && (isTh || !TH_ONLY.has(x))) return T[x]; for (const [re, v] of PAT) if (re.test(k)) return v; return null; };

  // ---- styles: a dotted underline on explained terms, and one small card ----
  const css = `
[data-tip]{text-decoration:underline dotted;text-decoration-color:color-mix(in srgb,currentColor 38%,transparent);text-underline-offset:3px;text-decoration-thickness:1px;cursor:help}
label[data-tip]:not([data-tip-whole]){text-decoration:none}label[data-tip]>b:first-of-type,label[data-tip]>span>b:first-of-type,label[data-tip]>.lab,label.check[data-tip]>span,label[data-tip]>span.mut:first-child{text-decoration:underline dotted;text-decoration-color:color-mix(in srgb,currentColor 38%,transparent);text-underline-offset:3px;text-decoration-thickness:1px;cursor:help}
#sd-tip{position:fixed;z-index:9999;max-width:min(320px,calc(100vw - 24px));padding:8px 11px;border-radius:8px;font:500 12.5px/1.45 var(--font,inherit);letter-spacing:0;text-transform:none;text-align:left;white-space:normal;
  background:var(--tip-bg,#0e1526);color:var(--tip-fg,#f4f6fb);box-shadow:0 6px 24px rgba(10,16,32,.22),0 1px 2px rgba(10,16,32,.18);pointer-events:none;opacity:0;transform:translateY(3px);transition:opacity .12s ease,transform .12s ease}
#sd-tip.on{opacity:1;transform:none}
#sd-tip::after{content:"";position:absolute;left:var(--ax,50%);width:8px;height:8px;background:inherit;transform:translateX(-50%) rotate(45deg)}
#sd-tip[data-at="top"]::after{bottom:-4px}#sd-tip[data-at="bottom"]::after{top:-4px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) #sd-tip{--tip-bg:#e7ebf3;--tip-fg:#0b1020}}
:root[data-theme="dark"] #sd-tip{--tip-bg:#e7ebf3;--tip-fg:#0b1020}
@media (prefers-reduced-motion:reduce){#sd-tip{transition:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const tip = document.createElement('div'); tip.id = 'sd-tip'; tip.setAttribute('role', 'tooltip'); tip.setAttribute('aria-hidden', 'true');
  const texts = document.createElement('div'); texts.hidden = true; texts.id = 'sd-tip-texts';
  const ready = () => { document.body.appendChild(tip); document.body.appendChild(texts); scan(document.body); };
  const ids = new Map(); let nId = 0;
  const descId = txt => { if (ids.has(txt)) return ids.get(txt); const id = 'sdt' + (++nId); const sp = document.createElement('span'); sp.id = id; sp.textContent = txt; texts.appendChild(sp); ids.set(txt, id); return id; };

  // ---- find explainable elements ----
  const SEL = 'th, .lv small:first-child, label, .kv > span:first-child, [data-tipkey], button[data-cat], .seg button, .chip, .subtabs button, small';
  // the part of a label that names the field, in order of preference (a <b> beats the span around it)
  const labelPart = el => { for (const q of [':scope > b', ':scope > span > b', ':scope > .lab', ':scope > span:not(.mut):not(.hint)', ':scope > span.mut:first-child']) { const x = el.querySelector(q); if (x) return x; } return null; };
  function textOf(el) {
    if (el.dataset.tipkey) return el.dataset.tipkey;
    if (el.tagName === 'LABEL') { const b = labelPart(el); if (b) return b.textContent; const n = [...el.childNodes].find(x => x.nodeType === 3 && x.textContent.trim()); return n ? n.textContent : ''; }
    return el.textContent;
  }
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    const els = root.matches && root.matches(SEL) ? [root, ...root.querySelectorAll(SEL)] : root.querySelectorAll(SEL);
    for (const el of els) {
      if (el.hasAttribute('data-tip') || el.closest('#sd-tip, #sd-tip-texts')) continue;
      const raw = textOf(el); if (!raw || raw.length > 80) continue;
      const v = lookup(raw, el.tagName === 'TH'); if (!v) continue;
      el.setAttribute('data-tip', v);
      if (el.tagName === 'LABEL' && !labelPart(el)) el.setAttribute('data-tip-whole', '');   // plain-text label: underline the label itself (no DOM changes)
      const d = el.getAttribute('aria-describedby') || ''; el.setAttribute('aria-describedby', (d + ' ' + descId(v)).trim());
    }
  }
  // every added node is queued; one pass per animation frame handles them all (redraws can come in quick bursts)
  const queue = new Set(); let pend = 0;
  new MutationObserver(ms => {
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) queue.add(n);
    if (!pend) pend = requestAnimationFrame(() => { pend = 0; const ns = [...queue]; queue.clear(); for (const n of ns) if (n.isConnected) scan(n); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- show / hide ----
  let cur = null, timer = null, touchHide = null;
  function place(el) {
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, vw = innerWidth, gap = 8;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), vw - tw - 8), top = r.top - th - gap, at = 'top';
    if (top < 6) { top = r.bottom + gap; at = 'bottom'; }
    tip.style.left = left + 'px'; tip.style.top = top + 'px'; tip.dataset.at = at;
    tip.style.setProperty('--ax', Math.min(Math.max(12, r.left + r.width / 2 - left), tw - 12) + 'px');
  }
  function show(el, now) {
    clearTimeout(timer);
    const go = () => { cur = el; tip.textContent = el.getAttribute('data-tip'); tip.classList.add('on'); place(el); };
    if (now) go(); else timer = setTimeout(go, 280);
  }
  function hide() { clearTimeout(timer); cur = null; tip.classList.remove('on'); }
  const target = e => { const el = e.target && e.target.closest && e.target.closest('[data-tip]'); if (!el) return null; if (el.tagName === 'LABEL' && e.target.closest('input, select, textarea, button')) return null; return el; };
  document.addEventListener('pointerover', e => { if (e.pointerType === 'touch') return; const el = target(e); if (el && el !== cur) show(el); else if (!el && cur) hide(); }, true);
  document.addEventListener('pointerout', e => { if (e.pointerType === 'touch') return; const el = target(e); if (el && !el.contains(e.relatedTarget)) hide(); }, true);
  document.addEventListener('pointerdown', e => {                                  // phones and tablets: tap the term to see it, tap anywhere to close
    if (e.pointerType !== 'touch') { hide(); return; }
    const el = target(e); clearTimeout(touchHide);
    if (el && el !== cur) { show(el, true); touchHide = setTimeout(hide, 5000); } else hide();
  }, true);
  document.addEventListener('focusin', e => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && !e.target.matches('input, select, textarea')) show(el, true); });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  addEventListener('scroll', hide, { passive: true, capture: true }); addEventListener('resize', hide);
  if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);
  window.SD_TIPS = { lookup, scan, count: () => Object.keys(T).length };
})();
