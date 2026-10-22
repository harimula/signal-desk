# Signal Desk

**Documentation:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (functional, architectural and technical, with diagrams) · [web version](https://hmula-fbin.github.io/signal-desk/docs/) · [architecture slides](docs/architecture.pptx). Updated with every change.

USA + India stock signal board: Top Buy / Buy / Hold / Sell / Top Sell, entry and exit levels,
custom moving-average calculator, drill-down view, and your own tickers. Static page, no build step.
Not financial advice. The page places no orders.

## Publish (GitHub Pages)
Settings → Pages → Build from branch `main`, folder `/ (root)`. The link is
`https://<your-user>.github.io/<repo>/`.

## Live prices
The Refresh button pulls Yahoo Finance data from your browser. If your browser blocks it (CORS),
deploy `worker.js` as a free Cloudflare Worker (dash.cloudflare.com → Workers & Pages → Create →
Hello World → paste `worker.js` → Deploy), then paste the `https://…workers.dev` URL into
"Data source" on the page, or set `DEFAULT_PROXY` near the top of the script in `index.html`.

Your added tickers are stored in your own browser (localStorage).
