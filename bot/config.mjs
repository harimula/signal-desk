// Bot configuration: presets, defaults, validation. The front-end Settings tab writes bot/config.json;
// the bot re-reads it every minute. Secrets (API keys) are NEVER in this file.
export const PRESETS = {
  conservative: { riskPct: 0.25, optRiskPct: 0.25, maxHeat: 1.5, perSector: 1, maxPositions: 4, maxOptions: 1, dayCap: 2, weekCap: 4, streak: 2, stockPct: 8, optPct: 1 },
  balanced:     { riskPct: 0.5,  optRiskPct: 0.5,  maxHeat: 3,   perSector: 2, maxPositions: 6, maxOptions: 4, dayCap: 3, weekCap: 6, streak: 3, stockPct: 10, optPct: 2 },
  aggressive:   { riskPct: 1,    optRiskPct: 1,    maxHeat: 6,   perSector: 3, maxPositions: 8, maxOptions: 6, dayCap: 5, weekCap: 10, streak: 4, stockPct: 12, optPct: 3 },
};
export const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'JPM', 'BAC', 'XOM', 'CVX', 'KO', 'PEP', 'WMT', 'HD', 'DIS', 'INTC', 'CSCO', 'QCOM', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'UBER', 'PLTR', 'SHOP', 'COIN', 'SOFI', 'F'];
export const DEFAULTS = {
  version: 1, mode: 'paper', preset: 'balanced', ...PRESETS.balanced,
  stocks: true, options: true,
  rsiThreshold: 10, maxHold: 10, entryEnd: '11:00', optTakeProfit: 50, optStop: 50, holdFloor: 25, staleMin: 45,
  newsGuard: true, eventGuard: true, alerts: true,
  symbols: DEFAULT_SYMBOLS,
};
// [min, max] for every numeric field — anything outside is clamped, anything unknown is dropped.
export const RANGES = {
  riskPct: [0.05, 3], optRiskPct: [0.05, 3], maxHeat: [0.5, 15], perSector: [1, 10], maxPositions: [1, 20], maxOptions: [0, 10],
  dayCap: [0.5, 20], weekCap: [1, 30], streak: [1, 10], stockPct: [1, 30], optPct: [0.5, 10],
  rsiThreshold: [2, 30], maxHold: [1, 30], optTakeProfit: [10, 300], optStop: [20, 90], holdFloor: [5, 60], staleMin: [5, 240],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
export function normalize(raw) {
  const c = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return c;
  if (raw.preset && PRESETS[raw.preset]) { c.preset = raw.preset; Object.assign(c, PRESETS[raw.preset]); }
  else if (raw.preset === 'custom') c.preset = 'custom';
  for (const k of Object.keys(RANGES)) if (raw[k] != null && isFinite(+raw[k]) && (c.preset === 'custom' || !(k in PRESETS.balanced))) c[k] = clamp(+raw[k], RANGES[k]);
  for (const k of ['stocks', 'options', 'newsGuard', 'eventGuard', 'alerts']) if (typeof raw[k] === 'boolean') c[k] = raw[k];
  c.mode = raw.mode === 'live' && raw.liveConfirm === 'I UNDERSTAND THE RISK' ? 'live' : 'paper';
  if (/^\d{1,2}:\d{2}$/.test(raw.entryEnd || '')) { const [h, m] = raw.entryEnd.split(':').map(Number); if (h * 60 + m >= 600 && h * 60 + m <= 900) c.entryEnd = raw.entryEnd; }
  if (Array.isArray(raw.symbols)) { const s = [...new Set(raw.symbols.map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z.]{1,6}$/.test(x)))]; if (s.length) c.symbols = s.slice(0, 60); }
  if (raw.updatedAt) c.updatedAt = raw.updatedAt;
  return c;
}
export const entryEndMin = c => { const [h, m] = c.entryEnd.split(':').map(Number); return h * 60 + m; };
export const summary = c => `${c.preset} · stocks ${c.stocks ? c.stockPct + '%/position' : 'off'} · options ${c.options ? c.optPct + '%/trade' : 'off'} · risk ${c.riskPct}%/trade, cap ${c.maxHeat}% · ${c.mode.toUpperCase()}`;
