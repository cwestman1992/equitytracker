import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const STORAGE_KEY   = "p2p-equity-tracker-v1";
const SETTINGS_KEY  = "p2p-settings-v1";
const BILLS_KEY     = "p2p-bills-v1";
const HOLDINGS_KEY  = "p2p-holdings-v1";

const DEFAULT_SETTINGS = { marginRate: 0.0844, targetYield: 0.23, yieldMode: "manual" };

const parseNum = (s) => { const n = parseFloat(String(s).replace(/,/g, "")); return isNaN(n) ? 0 : n; };
const fmt$ = (v, dec = 2) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtPct = (v, dec = 2) => (v * 100).toFixed(dec) + "%";

// ── STORAGE ───────────────────────────────────────────────────────────────────
const store = {
  async get(key) {
    try { if (window.storage?.get) { const r = await window.storage.get(key); return r?.value ?? null; } } catch {}
    try { return localStorage.getItem(key); } catch { return null; }
  },
  async set(key, value) {
    try { if (window.storage?.set) { await window.storage.set(key, value); return; } } catch {}
    try { localStorage.setItem(key, value); } catch {}
  },
};

// ── DATE HELPERS ──────────────────────────────────────────────────────────────
const parseYM = (dateStr) => { const [yr, mo] = dateStr.split("-").map(Number); return new Date(yr, mo - 1, 1); };
const fmtDate = (dateStr) => parseYM(dateStr).toLocaleDateString("en-US", { month: "short", year: "numeric" });
const fmtTS = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

// ── MATH ──────────────────────────────────────────────────────────────────────
function projectCurve(gross, margin, divs, w2, bills, marginRate, yield_, months, appreciation = 0) {
  let g = gross, m = margin, d = divs; const ma = appreciation / 12;
  const pts = [{ month: 0, equity: (g - m) / g, divs: d, margin: m, gross: g, net: g - m }];
  for (let i = 1; i <= months; i++) {
    const draw = Math.max(0, bills - d);
    g += w2; g *= (1 + ma); m += draw + m * marginRate / 12; m = Math.max(0, m); d = g * yield_ / 12;
    pts.push({ month: i, equity: (g - m) / g, divs: d, margin: m, gross: g, net: g - m });
  }
  return pts;
}
function projectMinEquity(gross, margin, divs, w2, bills, marginRate, yield_, months, appreciation = 0) {
  return Math.min(...projectCurve(gross, margin, divs, w2, bills, marginRate, yield_, months, appreciation).map(p => p.equity));
}
function projectFreedomMonths(gross, margin, divs, w2, bills, marginRate, yield_, appreciation = 0) {
  let g = gross, m = margin, d = divs; const ma = appreciation / 12;
  for (let i = 1; i <= 600; i++) {
    const draw = Math.max(0, bills - d); g += w2; g *= (1 + ma); m += draw + m * marginRate / 12; m = Math.max(0, m); d = g * yield_ / 12;
    if (d >= bills) return i;
  }
  return null;
}
function getFreedomDate(months) {
  if (!months) return null; const d = new Date(); d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function findMaxSafeBill(gross, margin, divs, w2, bills, marginRate, yield_, appreciation = 0) {
  let lo = 0, hi = 15000;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (projectMinEquity(gross, margin, divs, w2 + mid, bills + mid, marginRate, yield_, 3, appreciation) >= 0.55) lo = mid; else hi = mid; }
  return Math.floor(lo / 5) * 5;
}
function getDaysUntilNextLog(entries) {
  if (!entries.length) return null; const [yr, mo] = entries[entries.length - 1].date.split("-").map(Number);
  return Math.ceil((new Date(yr, mo, 1) - new Date()) / 864e5);
}
function criticalDropPct(gross, margin, targetEquity) {
  if (!margin || margin <= 0) return Infinity; const threshold = margin / (1 - targetEquity);
  if (threshold >= gross) return 0; return ((gross - threshold) / gross) * 100;
}
function calcRecoveryMonths(pcg, margin, divs, w2, bills, marginRate, yield_, targetEquity) {
  let g = pcg, m = margin, d = divs;
  for (let i = 1; i <= 120; i++) { const draw = Math.max(0, bills - d); g += w2; m += draw + m * marginRate / 12; m = Math.max(0, m); d = g * yield_ / 12; if ((g - m) / g >= targetEquity) return i; }
  return null;
}
function movingAverage(values, window) {
  return values.map((_, i) => { if (i < window - 1) return null; const s = values.slice(i - window + 1, i + 1); return s.reduce((a, b) => a + b, 0) / window; });
}

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const T = {
  bg: "#FAF9F6", surface: "#FFFFFF", surfaceAlt: "#F7F6F3",
  border: "#E7E5E4", borderLight: "#F0EFED",
  text: "#1C1917", textSub: "#78716C", textMuted: "#A8A29E",
  green: "#15803D", greenMid: "#16A34A", greenBg: "#F0FDF4", greenBorder: "#BBF7D0",
  red: "#DC2626", redBg: "#FEF2F2", redBorder: "#FECACA",
  amber: "#B45309", amberMid: "#D97706", amberBg: "#FFFBEB", amberBorder: "#FDE68A",
  blue: "#1D4ED8", blueMid: "#2563EB", blueBg: "#EFF6FF", blueBorder: "#BFDBFE",
  indigo: "#4338CA", indigoBg: "#EEF2FF", indigoBorder: "#C7D2FE",
  violet: "#6D28D9", violetBg: "#F5F3FF", violetBorder: "#DDD6FE",
  rose: "#BE123C", roseBg: "#FFF1F2", roseBorder: "#FECDD3",
  shadow: "0 1px 3px rgba(28,25,23,0.04), 0 4px 20px rgba(28,25,23,0.07)",
  shadowHover: "0 2px 8px rgba(28,25,23,0.07), 0 12px 32px rgba(28,25,23,0.1)",
  radius: "16px", radiusSm: "10px", radiusXs: "6px",
};

const ASSET_CLASS_COLORS = {
  "Equities":              { color: T.blue,   bg: T.blueBg,   border: T.blueBorder },
  "Fixed Income & Pref":   { color: T.violet, bg: T.violetBg, border: T.violetBorder },
  "Alternatives":          { color: T.amber,  bg: T.amberBg,  border: T.amberBorder },
  "Cash":                  { color: T.textSub,bg: T.surfaceAlt,border: T.border },
};

const CATS = {
  housing:      { label: "Housing",     icon: "🏠", color: T.blue,    bg: T.blueBg,    border: T.blueBorder },
  transport:    { label: "Transport",   icon: "🚗", color: T.amber,   bg: T.amberBg,   border: T.amberBorder },
  insurance:    { label: "Insurance",   icon: "🛡️", color: T.violet,  bg: T.violetBg,  border: T.violetBorder },
  debt:         { label: "Debt",        icon: "💳", color: T.red,     bg: T.redBg,     border: T.redBorder },
  utilities:    { label: "Utilities",   icon: "⚡", color: T.indigo,  bg: T.indigoBg,  border: T.indigoBorder },
  subscriptions:{ label: "Subs",        icon: "📱", color: T.textSub, bg: T.surfaceAlt,border: T.border },
  food:         { label: "Food",        icon: "🛒", color: T.green,   bg: T.greenBg,   border: T.greenBorder },
  other:        { label: "Other",       icon: "📌", color: T.textMuted,bg: T.surfaceAlt,border: T.border },
};

// ── SHARED COMPONENTS ─────────────────────────────────────────────────────────
const Card = ({ children, style, className }) => (
  <div className={className} style={{ background: T.surface, borderRadius: T.radius, boxShadow: T.shadow, padding: "24px", ...style }}>{children}</div>
);
const SectionLabel = ({ children, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", color: T.textMuted, textTransform: "uppercase" }}>{children}</div>
    {action}
  </div>
);
const StatTile = ({ label, value, sub, color, serif, size = 22, badge }) => (
  <div style={{ background: T.surfaceAlt, borderRadius: T.radiusSm, padding: "14px 16px", border: `1px solid ${T.borderLight}` }}>
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", color: T.textMuted, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
      {label}{badge && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 20, background: badge === "ACTUAL" ? T.greenBg : T.amberBg, color: badge === "ACTUAL" ? T.green : T.amber, border: `1px solid ${badge === "ACTUAL" ? T.greenBorder : T.amberBorder}` }}>{badge}</span>}
    </div>
    <div style={{ fontSize: size, fontWeight: 700, color: color || T.text, fontFamily: serif ? "'Lora', serif" : "inherit", lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{sub}</div>}
  </div>
);
const Badge = ({ children, color, bg, border }) => (
  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: bg, color, border: `1px solid ${border}`, letterSpacing: "0.5px" }}>{children}</span>
);
const Pill = ({ children, active, onClick, color }) => (
  <button onClick={onClick} style={{ background: active ? (color || T.text) : "transparent", color: active ? "#fff" : T.textMuted, border: `1px solid ${active ? (color || T.text) : T.border}`, borderRadius: 20, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all 0.18s", whiteSpace: "nowrap" }}>{children}</button>
);
const Input = ({ label, value, onChange, placeholder, hint, accent, type = "text" }) => (
  <div>
    <div style={{ fontSize: 11, fontWeight: 600, color: accent ? T.greenMid : T.textMuted, marginBottom: 5, letterSpacing: "0.5px" }}>
      {label}{hint && <span style={{ fontSize: 10, color: T.textMuted, fontWeight: 400, marginLeft: 8 }}>{hint}</span>}
    </div>
    <input type={type} value={value} onChange={onChange} placeholder={placeholder}
      style={{ width: "100%", padding: "10px 13px", background: T.surfaceAlt, border: `1.5px solid ${accent && value ? T.greenMid : T.border}`, borderRadius: T.radiusXs, fontSize: 13, color: T.text, fontFamily: "inherit", outline: "none", transition: "border 0.18s" }}
      onFocus={e => e.target.style.borderColor = T.blueMid}
      onBlur={e => e.target.style.borderColor = accent && value ? T.greenMid : T.border} />
  </div>
);

// ── PDF HELPERS ───────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function extractStatementFromPdf(file) {
  const base64 = await fileToBase64(file);
  const response = await fetch("/api/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 1000,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: `Extract from this E-Trade brokerage statement. Return ONLY valid JSON, no markdown, no explanation.

{
  "gross": <Total Assets number, e.g. 5419.12>,
  "margin": <absolute value of margin loan/debit as positive number, 0 if none, e.g. 1654.71>,
  "dividends": <Total Income and Distributions for the period as a number, 0 if not found, e.g. 77.34>,
  "interest": <Total Interest Charged for the period as a positive number, 0 if none, e.g. 15.25>,
  "date": <statement period month as YYYY-MM, e.g. "2026-02">
}

For gross: look for "Total Assets" in the Balance Sheet section.
For margin: look for "Cash, BDP, MMFs (Debit)" or "Margin Loan" — use the absolute value.
For dividends: look for "Total Income and Distributions" or "Income And Distributions" for the period.
For interest: look for "Total Interest on Margin Loan" or "Interest Charged" total.
If not found, use 0. Return only the JSON.` }
      ]}]
    })
  });
  const data = await response.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

async function extractHoldingsFromPdf(file) {
  const base64 = await fileToBase64(file);
  const response = await fetch("/api/claude-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: `Extract all holdings from this E-Trade brokerage statement. Return ONLY valid JSON, no markdown, no explanation.

{
  "date": "<YYYY-MM from statement period, e.g. 2026-02>",
  "positions": [
    {
      "ticker": "<ticker symbol, e.g. CLM>",
      "name": "<security name, e.g. Cornerstone Strategic Investme>",
      "quantity": <total shares as number including reinvestments, e.g. 53.711>,
      "sharePrice": <share price as number, e.g. 7.80>,
      "totalCost": <total cost basis as number, e.g. 437.00>,
      "marketValue": <market value as number, e.g. 418.95>,
      "unrealizedGL": <unrealized gain/loss as number (negative for loss), e.g. -18.05>,
      "estAnnIncome": <estimated annual income as number, e.g. 78.31>,
      "currentYield": <current yield as a percentage number (not decimal), e.g. 18.69>,
      "assetClass": "<one of: Equities, Fixed Income & Pref, Alternatives, Cash>"
    }
  ],
  "totalAssets": <total assets number>,
  "marginLoan": <margin loan as positive number, 0 if none>,
  "netValue": <total value / net value number>,
  "allocation": {
    "equities": <equities market value>,
    "fixedIncome": <fixed income & preferreds market value>,
    "alternatives": <alternatives market value>,
    "cash": <cash/BDP value, negative if margin debit>
  },
  "totalEstAnnIncome": <total estimated annual income>,
  "totalUnrealizedGL": <total unrealized gain/loss>
}

Include EVERY position listed under Stocks, ETFs & Closed-End Funds sections. For positions with both Purchases and Reinvestments rows, use the Total row quantity and market value. Return only the JSON.` }
      ]}]
    })
  });
  const data = await response.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── MODELER CHART ─────────────────────────────────────────────────────────────
function ModelerChart({ scenarios, months = 36, growthScenarios = [] }) {
  const W = 700, H = 200, pad = { t: 16, r: 64, b: 32, l: 48 };
  const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;
  const allCurves = [...scenarios.map(s => s.curve), ...growthScenarios.map(s => s.curve)];
  const allEqs = allCurves.flatMap(c => (c || []).map(p => p.equity));
  if (!allEqs.length) return null;
  const rawMin = Math.min(...allEqs), rawMax = Math.max(...allEqs);
  const spread = Math.max(rawMax - rawMin, 0.08);
  const eMin = Math.max(0, rawMin - spread * 0.12), eMax = Math.min(1.05, rawMax + spread * 0.12);
  const eSpan = Math.max(eMax - eMin, 0.05);
  const toX = (m) => pad.l + (m / months) * iW;
  const toY = (eq) => pad.t + iH - ((eq - eMin) / eSpan) * iH;
  const COLORS = [T.greenMid, T.blueMid, T.amberMid];
  const GCOLORS = ["#059669", "#1D4ED8", "#92400E"];
  const gridLines = [0.10,0.20,0.30,0.40,0.50,0.55,0.60,0.70,0.80,0.90,1.00].filter(v => v >= eMin - 0.01 && v <= eMax + 0.01);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      <defs>{COLORS.map((c, i) => <linearGradient key={i} id={`mc-a-${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity="0.12" /><stop offset="100%" stopColor={c} stopOpacity="0.01" /></linearGradient>)}</defs>
      {gridLines.map(v => { const y = toY(v); const is60 = v===0.60, is55 = v===0.55, isT = is60||is55; return <g key={v}><line x1={pad.l} x2={pad.l+iW} y1={y} y2={y} stroke={is60?T.greenMid:is55?T.amberMid:T.borderLight} strokeWidth={isT?1.2:1} strokeDasharray={isT?"5,4":"0"} opacity={isT?0.85:1}/><text x={pad.l-8} y={y+4} textAnchor="end" fill={isT?(is60?T.greenMid:T.amberMid):T.textMuted} fontSize="9" fontFamily="Nunito" fontWeight={isT?"700":"400"}>{(v*100).toFixed(0)}%</text>{isT&&<text x={pad.l+iW+6} y={y+4} fill={is60?T.greenMid:T.amberMid} fontSize="8" fontFamily="Nunito" fontWeight="700">{is60?"60%":"55%"}</text>}</g>; })}
      {[0,6,12,18,24,30,36].filter(m=>m<=months).map(m=><text key={m} x={toX(m)} y={pad.t+iH+18} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{m===0?"Now":`${m}mo`}</text>)}
      {scenarios.map((s,si)=>{ if(!s.curve||s.curve.length<2)return null; const path="M"+s.curve.map((p,i)=>`${toX(i)},${toY(p.equity)}`).join(" L"); return <g key={`b${si}`}><path d={path+` L${toX(s.curve.length-1)},${pad.t+iH} L${toX(0)},${pad.t+iH} Z`} fill={`url(#mc-a-${si})`}/><path d={path} fill="none" stroke={COLORS[si]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>{[0,12,24,36].filter(m=>m<s.curve.length).map(m=><circle key={m} cx={toX(m)} cy={toY(s.curve[m].equity)} r="4" fill={COLORS[si]} stroke={T.surface} strokeWidth="2"/>)}</g>; })}
      {growthScenarios.map((s,si)=>{ if(!s.curve||s.curve.length<2)return null; const path="M"+s.curve.map((p,i)=>`${toX(i)},${toY(p.equity)}`).join(" L"); return <g key={`g${si}`}><path d={path} fill="none" stroke={GCOLORS[si]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="7,4"/>{[0,12,24,36].filter(m=>m<s.curve.length).map(m=><circle key={m} cx={toX(m)} cy={toY(s.curve[m].equity)} r="3.5" fill={GCOLORS[si]} stroke={T.surface} strokeWidth="2"/>)}</g>; })}
    </svg>
  );
}

// ── BILL MODELER TAB ──────────────────────────────────────────────────────────
function BillModelerTab({ latest, settings }) {
  const [amounts, setAmounts] = useState(["200","500","1000"]);
  const [labels, setLabels] = useState(["Conservative","Moderate","Aggressive"]);
  const [growthMode, setGrowthMode] = useState(false);
  const [appreciationRateStr, setAppreciationRateStr] = useState("7.0");
  const COLORS = [T.greenMid, T.blueMid, T.amberMid];
  const GCOLORS = ["#059669","#1D4ED8","#92400E"];
  const MONTHS = 36;
  const appreciationRate = parseNum(appreciationRateStr) / 100;
  const maxSafeBase = latest ? findMaxSafeBill(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, 0) : 0;
  const maxSafeGrowth = latest ? findMaxSafeBill(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, appreciationRate) : 0;

  const scenarios = useMemo(() => {
    if (!latest) return [];
    return amounts.map((amtStr, i) => {
      const amt = parseNum(amtStr)||0;
      const curve = projectCurve(latest.gross, latest.margin, latest.effectiveDivs, latest.w2+amt, latest.bills+amt, settings.marginRate, settings.effectiveYield, MONTHS, 0);
      const floorEq = Math.min(...curve.map(p=>p.equity));
      const floorMonth = curve.findIndex(p=>p.equity===floorEq);
      const monthsBelowTrigger = curve.filter(p=>p.equity<0.60).length;
      const freedomMo = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2+amt, latest.bills+amt, settings.marginRate, settings.effectiveYield, 0);
      const curFreedom = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, 0);
      return { amt, label: labels[i], curve, floorEq, floorMonth, monthsBelowTrigger, freedomMo, freedomDate: getFreedomDate(freedomMo), freedomDelta: freedomMo&&curFreedom?freedomMo-curFreedom:null, safe: floorEq>=0.55 };
    });
  }, [amounts, labels, latest, settings]);

  const growthScenarios = useMemo(() => {
    if (!latest||!growthMode) return [];
    return amounts.map((amtStr, i) => {
      const amt = parseNum(amtStr)||0;
      const curve = projectCurve(latest.gross, latest.margin, latest.effectiveDivs, latest.w2+amt, latest.bills+amt, settings.marginRate, settings.effectiveYield, MONTHS, appreciationRate);
      const floorEq = Math.min(...curve.map(p=>p.equity));
      const floorMonth = curve.findIndex(p=>p.equity===floorEq);
      const monthsBelowTrigger = curve.filter(p=>p.equity<0.60).length;
      const freedomMo = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2+amt, latest.bills+amt, settings.marginRate, settings.effectiveYield, appreciationRate);
      const curFreedom = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, appreciationRate);
      return { amt, label: labels[i], curve, floorEq, floorMonth, monthsBelowTrigger, freedomMo, freedomDate: getFreedomDate(freedomMo), freedomDelta: freedomMo&&curFreedom?freedomMo-curFreedom:null, safe: floorEq>=0.55 };
    });
  }, [amounts, labels, latest, settings, growthMode, appreciationRate]);

  if (!latest) return <Card><div style={{textAlign:"center",padding:40,color:T.textMuted}}>Log at least one month to use the Bill Modeler.</div></Card>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div style={{background:T.greenBg,border:`1px solid ${T.greenBorder}`,borderRadius:T.radius,padding:"18px 24px"}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"1.5px",color:T.green,marginBottom:4}}>MAX SAFE BILL — DEPOSITS + DIVIDENDS ONLY</div>
          <div style={{display:"flex",alignItems:"baseline",gap:8}}><div style={{fontSize:36,fontWeight:700,color:T.green,fontFamily:"'Lora', serif"}}>{fmt$(maxSafeBase,0)}</div><div style={{fontSize:13,color:T.textMuted}}>/mo</div></div>
          <div style={{fontSize:11,color:T.textSub,marginTop:4}}>Conservative — no price appreciation assumed</div>
        </div>
        <div style={{background:T.violetBg,border:`1px solid ${T.violetBorder}`,borderRadius:T.radius,padding:"18px 24px"}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"1.5px",color:T.violet,marginBottom:4}}>MAX SAFE BILL — WITH {fmtPct(appreciationRate,0)} MARKET APPRECIATION</div>
          <div style={{display:"flex",alignItems:"baseline",gap:8}}><div style={{fontSize:36,fontWeight:700,color:T.violet,fontFamily:"'Lora', serif"}}>{fmt$(maxSafeGrowth,0)}</div><div style={{fontSize:13,color:T.textMuted}}>/mo</div></div>
          <div style={{fontSize:11,color:T.textSub,marginTop:4}}>{maxSafeGrowth>maxSafeBase?`Market growth adds ${fmt$(maxSafeGrowth-maxSafeBase,0)}/mo headroom`:"Same headroom as baseline"}</div>
        </div>
      </div>
      <Card style={{padding:"16px 24px"}}>
        <SectionLabel>STARTING STATE — FROM LATEST LOG</SectionLabel>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
          {[{l:"Gross",v:fmt$(latest.gross)},{l:"Margin",v:fmt$(latest.margin)},{l:"Equity",v:fmtPct(latest.equity),c:latest.equity>=0.60?T.green:T.amber},{l:"Bills/Mo",v:fmt$(latest.bills)},{l:"Dividends/Mo",v:fmt$(latest.effectiveDivs),c:T.green}].map(({l,v,c})=>(
            <div key={l} style={{textAlign:"center"}}><div style={{fontSize:10,color:T.textMuted,fontWeight:600,letterSpacing:"1px",marginBottom:4}}>{l}</div><div style={{fontSize:14,fontWeight:700,color:c||T.text}}>{v}</div></div>
          ))}
        </div>
      </Card>
      <Card>
        <SectionLabel>CONFIGURE SCENARIOS</SectionLabel>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:20}}>
          {scenarios.map((s,i)=>(
            <div key={i} style={{borderRadius:T.radiusSm,padding:"16px",background:T.surfaceAlt,border:`1.5px solid ${s.safe?T.border:T.redBorder}`}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:COLORS[i]}}/>
                <div style={{fontSize:12,fontWeight:700,color:COLORS[i]}}>Scenario {i+1}</div>
                <Badge color={s.safe?T.green:T.red} bg={s.safe?T.greenBg:T.redBg} border={s.safe?T.greenBorder:T.redBorder}>{s.safe?"SAFE":"UNSAFE"}</Badge>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:T.textMuted,marginBottom:4}}>BILL AMOUNT TO ADD</div>
                  <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{color:T.textMuted}}>$</span><input value={amounts[i]} onChange={e=>setAmounts(a=>{const n=[...a];n[i]=e.target.value;return n;})} style={{flex:1,padding:"8px 10px",background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:16,fontWeight:700,color:COLORS[i],fontFamily:"'Lora', serif",outline:"none"}}/><span style={{color:T.textMuted,fontSize:12}}>/mo</span></div>
                </div>
                <div>
                  <div style={{fontSize:10,fontWeight:600,color:T.textMuted,marginBottom:4}}>LABEL</div>
                  <input value={labels[i]} onChange={e=>setLabels(l=>{const n=[...l];n[i]=e.target.value;return n;})} style={{width:"100%",padding:"7px 10px",background:T.surface,border:`1.5px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:12,color:T.text,fontFamily:"inherit",outline:"none"}}/>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"1.5px",color:T.textMuted}}>36-MONTH EQUITY PROJECTION</div>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <Pill active={!growthMode} onClick={()=>setGrowthMode(false)}>Deposits + Dividends</Pill>
            <Pill active={growthMode} onClick={()=>setGrowthMode(true)} color={T.violet}>+ Market Growth</Pill>
            {growthMode&&<div style={{display:"flex",alignItems:"center",gap:6,background:T.violetBg,border:`1px solid ${T.violetBorder}`,borderRadius:20,padding:"4px 14px"}}><span style={{fontSize:11,color:T.violet,fontWeight:600}}>Appreciation:</span><input value={appreciationRateStr} onChange={e=>setAppreciationRateStr(e.target.value)} style={{width:40,padding:"2px 4px",background:"transparent",border:"none",fontSize:13,fontWeight:700,color:T.violet,fontFamily:"'Lora', serif",outline:"none",textAlign:"right"}}/><span style={{fontSize:11,color:T.violet,fontWeight:600}}>%/yr</span></div>}
          </div>
        </div>
        <div style={{display:"flex",gap:14,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          {scenarios.map((s,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:20,height:2.5,background:COLORS[i],borderRadius:2}}/><span style={{fontSize:11,color:T.textSub,fontWeight:600}}>{s.label}</span></div>))}
          {growthMode&&scenarios.map((_,i)=>(<div key={`g${i}`} style={{display:"flex",alignItems:"center",gap:6}}><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={GCOLORS[i]} strokeWidth="2" strokeDasharray="5,3"/></svg><span style={{fontSize:11,color:T.violet,fontWeight:600}}>{labels[i]}+G</span></div>))}
        </div>
        <ModelerChart scenarios={scenarios} months={MONTHS} growthScenarios={growthMode?growthScenarios:[]}/>
      </Card>
      {growthMode&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
          {scenarios.map((s,i)=>{const gs=growthScenarios[i];if(!gs)return null;const b36=s.curve[36],g36=gs.curve[36];return(
            <Card key={i} style={{background:T.violetBg,border:`1px solid ${T.violetBorder}`,boxShadow:"none"}}>
              <div style={{fontSize:12,fontWeight:700,color:T.violet,marginBottom:14}}>{s.label} — Growth Impact at 36mo</div>
              {[{l:"Portfolio",b:fmt$(b36?.gross||0),g:fmt$(g36?.gross||0)},{l:"Net Value",b:fmt$(b36?.net||0),g:fmt$(g36?.net||0)},{l:"Monthly Divs",b:fmt$(b36?.divs||0),g:fmt$(g36?.divs||0)},{l:"Equity %",b:fmtPct(b36?.equity||0),g:fmtPct(g36?.equity||0)},{l:"Freedom Date",b:s.freedomDate||">50yr",g:gs.freedomDate||">50yr"}].map(({l,b,g})=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${T.violetBorder}`}}>
                  <span style={{fontSize:11,color:T.textMuted}}>{l}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center",fontSize:12}}><span style={{color:T.textSub,fontWeight:600}}>{b}</span><span style={{color:T.textMuted,fontSize:10}}>→</span><span style={{color:T.violet,fontWeight:700}}>{g}</span></div>
                </div>
              ))}
            </Card>
          );})}
        </div>
      )}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
        {scenarios.map((s,i)=>{const gs=growthMode?growthScenarios[i]:null;return(
          <Card key={i} style={{borderTop:`3px solid ${COLORS[i]}`}}>
            <div style={{fontSize:14,fontWeight:700,color:COLORS[i],marginBottom:16,fontFamily:"'Lora', serif"}}>{s.label} — {fmt$(s.amt,0)}/mo</div>
            <div style={{display:"flex",flexDirection:"column"}}>
              {[{l:"Floor Equity",bv:fmtPct(s.floorEq),gv:gs?fmtPct(gs.floorEq):null,bc:s.floorEq>=0.60?T.green:s.floorEq>=0.55?T.amber:T.red,gc:gs?(gs.floorEq>=0.60?T.green:gs.floorEq>=0.55?T.amber:T.red):null,big:true},{l:"Floor at month",bv:String(s.floorMonth),gv:gs?String(gs.floorMonth):null,bc:T.textSub},{l:"Months below 60%",bv:`${s.monthsBelowTrigger}/36`,gv:gs?`${gs.monthsBelowTrigger}/36`:null,bc:s.monthsBelowTrigger>12?T.red:s.monthsBelowTrigger>0?T.amber:T.green},{l:"Freedom Date",bv:s.freedomDate||">50yr",gv:gs?(gs.freedomDate||">50yr"):null,bc:T.indigo,gc:T.violet},{l:"Freedom Δ",bv:s.freedomDelta!==null?(s.freedomDelta>0?`+${s.freedomDelta}mo later`:`${Math.abs(s.freedomDelta)}mo sooner`):"—",gv:null,bc:s.freedomDelta>0?T.amber:T.green},{l:"Divs at mo 36",bv:fmt$(s.curve[36]?.divs||0),gv:gs?fmt$(gs.curve[36]?.divs||0):null,bc:T.green,gc:T.violet},{l:"Portfolio at mo 36",bv:fmt$(s.curve[36]?.gross||0),gv:gs?fmt$(gs.curve[36]?.gross||0):null,bc:T.text,gc:T.violet},{l:"Safe?",bv:s.safe?"Yes ✓":"No — floor < 55%",gv:null,bc:s.safe?T.green:T.red}].map(({l,bv,gv,bc,gc,big})=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${T.borderLight}`}}>
                  <span style={{fontSize:11,color:T.textMuted}}>{l}</span>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:big?15:12,fontWeight:big?700:600,color:bc,fontFamily:big?"'Lora', serif":"inherit"}}>{bv}</span>
                    {growthMode&&gv&&<span style={{display:"contents"}}><span style={{fontSize:10,color:T.textMuted}}>→</span><span style={{fontSize:big?14:11,fontWeight:big?700:600,color:gc||T.violet,fontFamily:big?"'Lora', serif":"inherit"}}>{gv}</span></span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );})}
      </div>
    </div>
  );
}

// ── BILL TRACKER TAB ──────────────────────────────────────────────────────────
function BillTrackerTab({ billItems, setBillItems, saveBills, latest, settings }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name:"", amount:"", category:"other", notes:"" });
  const floated = billItems.filter(b=>b.isFloated);
  const notFloated = billItems.filter(b=>!b.isFloated);
  const totalFloated = floated.reduce((s,b)=>s+b.amount,0);
  const totalAll = billItems.reduce((s,b)=>s+b.amount,0);
  const coveragePct = totalAll>0?totalFloated/totalAll:0;
  const nextCandidate = notFloated.length?[...notFloated].sort((a,b)=>b.amount-a.amount)[0]:null;
  const nextCandidateImpact = nextCandidate&&latest?(()=>{ const amt=nextCandidate.amount; const minEq=projectMinEquity(latest.gross,latest.margin,latest.effectiveDivs,latest.w2+amt,latest.bills+amt,settings.marginRate,settings.effectiveYield,3); return {minEq,safe:minEq>=0.55}; })():null;
  const toggleFloat=(id)=>{ const u=billItems.map(b=>b.id===id?{...b,isFloated:!b.isFloated,dateAdded:!b.isFloated?new Date().toISOString().slice(0,7):null}:b); setBillItems(u); saveBills(u); };
  const deleteBill=(id)=>{ const u=billItems.filter(b=>b.id!==id); setBillItems(u); saveBills(u); };
  const openEdit=(bill)=>{ setEditId(bill.id); setForm({name:bill.name,amount:String(bill.amount),category:bill.category,notes:bill.notes||""}); setShowForm(true); };
  const openAdd=()=>{ setEditId(null); setForm({name:"",amount:"",category:"other",notes:""}); setShowForm(true); };
  const submitForm=()=>{
    if(!form.name||!form.amount)return; const amt=parseNum(form.amount);
    if(editId){const u=billItems.map(b=>b.id===editId?{...b,name:form.name,amount:amt,category:form.category,notes:form.notes}:b); setBillItems(u); saveBills(u);}
    else{const u=[...billItems,{id:Date.now().toString(),name:form.name,amount:amt,category:form.category,isFloated:false,dateAdded:null,notes:form.notes}]; setBillItems(u); saveBills(u);}
    setShowForm(false); setEditId(null);
  };
  const BillRow=({bill})=>{
    const cat=CATS[bill.category]||CATS.other;
    return(
      <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:T.radiusSm,background:bill.isFloated?T.greenBg:T.surface,border:`1px solid ${bill.isFloated?T.greenBorder:T.border}`,marginBottom:8,transition:"all 0.2s"}}>
        <div style={{fontSize:20,flexShrink:0}}>{cat.icon}</div>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}><span style={{fontSize:13,fontWeight:700,color:T.text}}>{bill.name}</span><span style={{fontSize:9,fontWeight:700,padding:"1px 7px",borderRadius:20,background:cat.bg,color:cat.color,border:`1px solid ${cat.border}`}}>{cat.label}</span></div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            <span style={{fontSize:14,fontWeight:800,color:bill.isFloated?T.green:T.text,fontFamily:"'Lora', serif"}}>{fmt$(bill.amount,0)}<span style={{fontSize:11,fontWeight:500,color:T.textMuted}}>/mo</span></span>
            {bill.isFloated&&bill.dateAdded&&<span style={{fontSize:11,color:T.green}}>✓ Routing since {fmtDate(bill.dateAdded)}</span>}
            {bill.notes&&<span style={{fontSize:11,color:T.textMuted,fontStyle:"italic"}}>{bill.notes}</span>}
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
          <button onClick={()=>openEdit(bill)} style={{background:"none",border:`1px solid ${T.border}`,color:T.textMuted,borderRadius:T.radiusXs,padding:"4px 10px",fontSize:11,fontFamily:"inherit",cursor:"pointer"}}>Edit</button>
          <button onClick={()=>toggleFloat(bill.id)} style={{background:bill.isFloated?T.greenBg:T.text,color:bill.isFloated?T.green:"#fff",border:`1px solid ${bill.isFloated?T.greenBorder:T.text}`,borderRadius:T.radiusXs,padding:"6px 14px",fontSize:12,fontWeight:700,fontFamily:"inherit",transition:"all 0.18s",minWidth:110,cursor:"pointer"}}>{bill.isFloated?"✓ Routing":"+ Route It"}</button>
          <button onClick={()=>deleteBill(bill.id)} style={{background:"none",border:`1px solid ${T.border}`,color:T.textMuted,borderRadius:T.radiusXs,padding:"4px 8px",fontSize:11,fontFamily:"inherit",cursor:"pointer"}}>✕</button>
        </div>
      </div>
    );
  };
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20,maxWidth:900}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:14}}>
        {[{l:"Total Bills Tracked",v:fmt$(totalAll,0)+"/mo",sub:`${billItems.length} bills`,c:T.text},{l:"Currently Routing",v:fmt$(totalFloated,0)+"/mo",sub:`${floated.length} of ${billItems.length} bills`,c:T.green},{l:"Still at Bank",v:fmt$(totalAll-totalFloated,0)+"/mo",sub:`${notFloated.length} remaining`,c:T.amber},{l:"Routing Progress",v:fmtPct(coveragePct,0),sub:"of total bills floated",c:coveragePct>=1?T.green:coveragePct>0.5?T.amber:T.red}].map(({l,v,sub,c})=>(
          <Card key={l} style={{padding:"16px 18px"}}><div style={{fontSize:10,fontWeight:700,letterSpacing:"1.2px",color:T.textMuted,marginBottom:8}}>{l}</div><div style={{fontSize:22,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div><div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{sub}</div></Card>
        ))}
      </div>
      {billItems.length>0&&(
        <Card style={{padding:"16px 24px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontSize:11,color:T.textMuted}}>$0</span><span style={{fontSize:12,fontWeight:700,color:T.green}}>{fmt$(totalFloated,0)} routing · {fmt$(totalAll-totalFloated,0)} remaining</span><span style={{fontSize:11,color:T.textMuted}}>{fmt$(totalAll,0)} total</span></div>
          <div style={{height:10,background:T.borderLight,borderRadius:5,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(100,coveragePct*100)}%`,background:`linear-gradient(90deg, ${T.greenMid}, #34D399)`,borderRadius:5,transition:"width 0.5s"}}/></div>
          <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>{floated.map(b=>{const cat=CATS[b.category]||CATS.other;return(<div key={b.id} style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,background:cat.bg,color:cat.color,border:`1px solid ${cat.border}`}}>{cat.icon} {b.name} — {fmt$(b.amount,0)}/mo</div>);})}</div>
        </Card>
      )}
      {nextCandidate&&(
        <div style={{background:nextCandidateImpact?.safe?T.amberBg:T.redBg,border:`1px solid ${nextCandidateImpact?.safe?T.amberBorder:T.redBorder}`,borderRadius:T.radius,padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:"1.5px",color:nextCandidateImpact?.safe?T.amber:T.red,marginBottom:4}}>{(CATS[nextCandidate.category]||CATS.other).icon} HIGHEST-LEVERAGE NEXT BILL</div>
            <div style={{fontSize:18,fontWeight:700,color:T.text,fontFamily:"'Lora', serif"}}>{nextCandidate.name}</div>
            <div style={{fontSize:12,color:T.textSub,marginTop:2}}>{fmt$(nextCandidate.amount,0)}/mo — {nextCandidateImpact?(nextCandidateImpact.safe?`3-month floor: ${fmtPct(nextCandidateImpact.minEq)} ✓ safe when conditions are met`:`3-month floor: ${fmtPct(nextCandidateImpact.minEq)} — below 55%, not yet safe`):"Log a month to see safety analysis"}</div>
          </div>
          <button onClick={()=>toggleFloat(nextCandidate.id)} style={{padding:"10px 20px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:13,fontWeight:700,fontFamily:"inherit",cursor:"pointer"}}>Mark as Routing</button>
        </div>
      )}
      <Card>
        <SectionLabel action={<button onClick={openAdd} style={{padding:"7px 18px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:12,fontWeight:700,fontFamily:"inherit",cursor:"pointer"}}>+ Add Bill</button>}>BILL ROSTER — {billItems.length} BILLS</SectionLabel>
        {billItems.length===0?(
          <div style={{textAlign:"center",padding:40,color:T.textMuted}}><div style={{fontSize:36,marginBottom:12}}>📋</div><div style={{fontSize:14,fontWeight:600,color:T.textSub,marginBottom:8}}>No bills tracked yet</div><div style={{fontSize:12,maxWidth:380,margin:"0 auto",lineHeight:1.7}}>Add every recurring bill — mortgage, car, insurance, utilities. Whether routing or not yet.</div><button onClick={openAdd} style={{marginTop:16,padding:"10px 24px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:13,fontWeight:700,fontFamily:"inherit",cursor:"pointer"}}>Add Your First Bill</button></div>
        ):(
          <div>
            {floated.length>0&&<div style={{marginBottom:20}}><div style={{fontSize:11,fontWeight:700,color:T.green,letterSpacing:"1.5px",marginBottom:10}}>✓ ROUTING — {fmt$(totalFloated,0)}/mo</div>{floated.map(b=><BillRow key={b.id} bill={b}/>)}</div>}
            {notFloated.length>0&&<div><div style={{fontSize:11,fontWeight:700,color:T.textMuted,letterSpacing:"1.5px",marginBottom:10}}>○ STILL AT BANK — {fmt$(totalAll-totalFloated,0)}/mo</div>{[...notFloated].sort((a,b)=>b.amount-a.amount).map(b=><BillRow key={b.id} bill={b}/>)}</div>}
          </div>
        )}
      </Card>
      {showForm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(28,25,23,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:16,backdropFilter:"blur(4px)"}} onClick={()=>setShowForm(false)}>
          <div style={{background:T.surface,borderRadius:T.radius,boxShadow:T.shadowHover,padding:28,width:400,maxWidth:"100%"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:18,fontWeight:700,color:T.text,fontFamily:"'Lora', serif",marginBottom:20}}>{editId?"Edit Bill":"Add New Bill"}</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <Input label="BILL NAME" value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Car Insurance"/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <Input label="MONTHLY AMOUNT ($)" value={form.amount} onChange={e=>setForm(f=>({...f,amount:e.target.value}))} placeholder="e.g. 238"/>
                <div><div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:5}}>CATEGORY</div><select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))} style={{width:"100%",padding:"10px 13px",background:T.surfaceAlt,border:`1.5px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,color:T.text,fontFamily:"inherit",outline:"none"}}>{Object.entries(CATS).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}</select></div>
              </div>
              <Input label="NOTES" hint="optional" value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="e.g. Auto-renews July"/>
            </div>
            <div style={{display:"flex",gap:10,marginTop:20}}>
              <button onClick={submitForm} style={{flex:1,padding:"11px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:13,fontWeight:700,fontFamily:"inherit",cursor:"pointer"}}>{editId?"Save Changes":"Add Bill"}</button>
              <button onClick={()=>setShowForm(false)} style={{padding:"11px 16px",background:"transparent",color:T.textSub,border:`1px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── HOLDINGS TAB ──────────────────────────────────────────────────────────────
function HoldingsTab({ holdingSnapshots, setHoldingSnapshots, saveHoldings }) {
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null); // null | "success" | "error"
  const [sortBy, setSortBy] = useState("marketValue");
  const [sortDir, setSortDir] = useState("desc");
  const [filterClass, setFilterClass] = useState("All");
  const fileInputRef = useRef(null);

  const latest = holdingSnapshots.length ? holdingSnapshots[holdingSnapshots.length - 1] : null;

  const handleFile = async (file) => {
    if (!file || file.type !== "application/pdf") { setUploadStatus("error"); return; }
    setUploading(true); setUploadStatus(null);
    try {
      const data = await extractHoldingsFromPdf(file);
      if (data.positions && data.positions.length > 0) {
        const snapshot = { ...data, id: Date.now(), uploadedAt: Date.now() };
        const updated = [...holdingSnapshots, snapshot];
        setHoldingSnapshots(updated);
        saveHoldings(updated);
        setUploadStatus("success");
      } else { setUploadStatus("error"); }
    } catch { setUploadStatus("error"); }
    setUploading(false);
  };

  const deleteSnapshot = (id) => {
    const updated = holdingSnapshots.filter(s => s.id !== id);
    setHoldingSnapshots(updated); saveHoldings(updated);
  };

  // Sort & filter positions
  const positions = useMemo(() => {
    if (!latest?.positions) return [];
    let pts = filterClass === "All" ? latest.positions : latest.positions.filter(p => p.assetClass === filterClass);
    return [...pts].sort((a, b) => {
      const aVal = a[sortBy] || 0, bVal = b[sortBy] || 0;
      return sortDir === "desc" ? bVal - aVal : aVal - bVal;
    });
  }, [latest, sortBy, sortDir, filterClass]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(col); setSortDir("desc"); }
  };

  // Blended yield from holdings
  const holdingsBlendedYield = useMemo(() => {
    if (!latest?.positions) return null;
    const totalMV = latest.positions.reduce((s, p) => s + (p.marketValue || 0), 0);
    const totalEAI = latest.positions.reduce((s, p) => s + (p.estAnnIncome || 0), 0);
    return totalMV > 0 ? totalEAI / totalMV : null;
  }, [latest]);

  // Asset class totals for allocation bar
  const allocationData = useMemo(() => {
    if (!latest?.allocation) return [];
    const alloc = latest.allocation;
    const total = Math.abs(alloc.equities || 0) + Math.abs(alloc.fixedIncome || 0) + Math.abs(alloc.alternatives || 0);
    return [
      { label: "Equities", value: alloc.equities || 0, pct: total ? (alloc.equities || 0) / total : 0 },
      { label: "Fixed Income & Pref", value: alloc.fixedIncome || 0, pct: total ? (alloc.fixedIncome || 0) / total : 0 },
      { label: "Alternatives", value: alloc.alternatives || 0, pct: total ? (alloc.alternatives || 0) / total : 0 },
    ].filter(d => d.value > 0);
  }, [latest]);

  const assetClasses = ["All", ...Array.from(new Set((latest?.positions || []).map(p => p.assetClass).filter(Boolean)))];

  const SortHeader = ({ col, children }) => (
    <th onClick={() => toggleSort(col)} style={{ padding: "8px 12px", textAlign: "right", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: sortBy === col ? T.text : T.textMuted, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {children} {sortBy === col ? (sortDir === "desc" ? "↓" : "↑") : ""}
    </th>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Upload area */}
      <Card>
        <SectionLabel>UPLOAD PORTFOLIO SNAPSHOT</SectionLabel>
        <input type="file" accept="application/pdf" ref={fileInputRef} style={{ display: "none" }} onChange={e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
        <div className="pdf-drop" onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}>
          {uploading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "8px 0" }}>
              <div style={{ width: 18, height: 18, border: `2px solid ${T.border}`, borderTopColor: T.blueMid, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <span style={{ fontSize: 12, color: T.textSub }}>Reading your portfolio statement…</span>
            </div>
          ) : uploadStatus === "success" ? (
            <div style={{ fontSize: 12, color: T.green, fontWeight: 600 }}>✓ Portfolio snapshot saved — {latest?.positions?.length} positions extracted</div>
          ) : uploadStatus === "error" ? (
            <div style={{ fontSize: 12, color: T.red }}>Couldn't extract holdings. Try a different PDF or check it's an E-Trade statement.</div>
          ) : (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 4 }}>📊 Upload E-Trade Statement PDF</div>
              <div style={{ fontSize: 11, color: T.textMuted }}>Click or drag & drop — Claude AI extracts all positions, yields, and allocation data instantly</div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>Upload anytime — weekly after paycheck deploys, or whenever you add new positions</div>
            </div>
          )}
        </div>
        {holdingSnapshots.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", color: T.textMuted, marginBottom: 8 }}>SNAPSHOT HISTORY</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {[...holdingSnapshots].reverse().slice(0, 5).map(s => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: s.id === latest?.id ? T.greenBg : T.surfaceAlt, border: `1px solid ${s.id === latest?.id ? T.greenBorder : T.border}`, borderRadius: T.radiusSm }}>
                  <div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{fmtTS(s.uploadedAt)}</span>
                    {s.id === latest?.id && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 20, background: T.greenBg, color: T.green, border: `1px solid ${T.greenBorder}`, marginLeft: 8 }}>LATEST</span>}
                    <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>{s.positions?.length} positions · Net {fmt$(s.netValue || 0)} · {s.positions ? fmtPct((s.totalEstAnnIncome || 0) / ((s.totalAssets || 1) - (s.marginLoan || 0)), 1) + " yield" : ""}</div>
                  </div>
                  <button onClick={() => deleteSnapshot(s.id)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: T.radiusXs, padding: "3px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {!latest ? (
        <Card><div style={{ textAlign: "center", padding: 48, color: T.textMuted }}><div style={{ fontSize: 32, marginBottom: 12 }}>📊</div><div style={{ fontSize: 14, fontWeight: 600, color: T.textSub, marginBottom: 8 }}>No holdings snapshots yet</div><div style={{ fontSize: 12, lineHeight: 1.7 }}>Upload your E-Trade statement above to see your full portfolio breakdown, position-level yields, and asset allocation.</div></div></Card>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {/* Key metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 14 }}>
            {[
              { l: "TOTAL ASSETS", v: fmt$(latest.totalAssets || 0), c: T.text },
              { l: "MARGIN LOAN", v: fmt$(latest.marginLoan || 0), c: T.red },
              { l: "NET VALUE", v: fmt$(latest.netValue || 0), c: T.green },
              { l: "BLENDED YIELD", v: holdingsBlendedYield ? fmtPct(holdingsBlendedYield, 1) : "—", c: T.indigo, badge: "ACTUAL" },
              { l: "EST. ANNUAL INCOME", v: fmt$(latest.totalEstAnnIncome || 0, 0), c: T.green },
            ].map(({ l, v, c, badge }) => (
              <Card key={l} style={{ padding: "14px 16px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", color: T.textMuted, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                  {l}{badge && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 20, background: T.greenBg, color: T.green, border: `1px solid ${T.greenBorder}` }}>{badge}</span>}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</div>
              </Card>
            ))}
          </div>

          {/* Unrealized G/L + allocation */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Card>
              <SectionLabel>UNREALIZED GAIN / LOSS</SectionLabel>
              <div style={{ fontSize: 40, fontWeight: 700, color: (latest.totalUnrealizedGL || 0) >= 0 ? T.green : T.red, fontFamily: "'Lora', serif" }}>
                {(latest.totalUnrealizedGL || 0) >= 0 ? "+" : ""}{fmt$(latest.totalUnrealizedGL || 0)}
              </div>
              <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>total unrealized across all positions</div>
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                {["Equities", "Fixed Income & Pref", "Alternatives"].map(cls => {
                  const pts = (latest.positions || []).filter(p => p.assetClass === cls);
                  const gl = pts.reduce((s, p) => s + (p.unrealizedGL || 0), 0);
                  const mv = pts.reduce((s, p) => s + (p.marketValue || 0), 0);
                  if (!pts.length) return null;
                  const clr = ASSET_CLASS_COLORS[cls] || { color: T.textMuted, bg: T.surfaceAlt, border: T.border };
                  return (
                    <div key={cls} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: clr.bg, borderRadius: T.radiusXs, border: `1px solid ${clr.border}` }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: clr.color }}>{cls}</span>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: gl >= 0 ? T.green : T.red, fontFamily: "'Lora', serif" }}>{gl >= 0 ? "+" : ""}{fmt$(gl)}</div>
                        <div style={{ fontSize: 10, color: T.textMuted }}>{fmt$(mv)} market value</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card>
              <SectionLabel>ASSET ALLOCATION</SectionLabel>
              {allocationData.length > 0 && (
                <div>
                  {/* Stacked bar */}
                  <div style={{ height: 16, borderRadius: 8, overflow: "hidden", display: "flex", marginBottom: 20 }}>
                    {allocationData.map(d => {
                      const clr = ASSET_CLASS_COLORS[d.label] || { color: T.textMuted };
                      return <div key={d.label} style={{ width: `${d.pct * 100}%`, background: clr.color, opacity: 0.75, transition: "width 0.4s" }} title={`${d.label}: ${fmt$(d.value)}`} />;
                    })}
                  </div>
                  {allocationData.map(d => {
                    const clr = ASSET_CLASS_COLORS[d.label] || { color: T.textMuted, bg: T.surfaceAlt, border: T.border };
                    const pts = (latest.positions || []).filter(p => p.assetClass === d.label);
                    const totalEAI = pts.reduce((s, p) => s + (p.estAnnIncome || 0), 0);
                    return (
                      <div key={d.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.borderLight}` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: clr.color, opacity: 0.75 }} />
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{d.label}</div>
                            <div style={{ fontSize: 10, color: T.textMuted }}>{pts.length} positions · {fmt$(totalEAI, 0)}/yr income</div>
                          </div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: "'Lora', serif" }}>{fmt$(d.value)}</div>
                          <div style={{ fontSize: 10, color: T.textMuted }}>{fmtPct(d.pct, 0)} of equity positions</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>

          {/* Positions table */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", color: T.textMuted }}>{positions.length} POSITIONS {filterClass !== "All" ? `— ${filterClass.toUpperCase()}` : ""}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {assetClasses.map(cls => (
                  <button key={cls} onClick={() => setFilterClass(cls)} style={{ padding: "4px 12px", background: filterClass === cls ? T.text : T.surfaceAlt, color: filterClass === cls ? "#fff" : T.textSub, border: `1px solid ${filterClass === cls ? T.text : T.border}`, borderRadius: 20, fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", transition: "all 0.15s" }}>{cls}</button>
                ))}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${T.border}` }}>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: T.textMuted }}>TICKER</th>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: T.textMuted }}>NAME</th>
                    <SortHeader col="quantity">SHARES</SortHeader>
                    <SortHeader col="sharePrice">PRICE</SortHeader>
                    <SortHeader col="marketValue">MARKET VALUE</SortHeader>
                    <SortHeader col="totalCost">COST BASIS</SortHeader>
                    <SortHeader col="unrealizedGL">UNREAL. G/L</SortHeader>
                    <SortHeader col="estAnnIncome">EST ANN INC</SortHeader>
                    <SortHeader col="currentYield">YIELD %</SortHeader>
                    <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: T.textMuted }}>CLASS</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const clr = ASSET_CLASS_COLORS[p.assetClass] || { color: T.textMuted, bg: T.surfaceAlt, border: T.border };
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.borderLight}` }}
                        onMouseEnter={ev => ev.currentTarget.style.background = T.surfaceAlt}
                        onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
                        <td style={{ padding: "11px 12px", fontWeight: 800, color: T.text, fontFamily: "'Lora', serif" }}>{p.ticker}</td>
                        <td style={{ padding: "11px 12px", color: T.textSub, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", color: T.textSub }}>{p.quantity?.toFixed(3)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", color: T.textSub }}>{fmt$(p.sharePrice || 0)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: T.text, fontFamily: "'Lora', serif" }}>{fmt$(p.marketValue || 0)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", color: T.textSub }}>{fmt$(p.totalCost || 0)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: (p.unrealizedGL || 0) >= 0 ? T.green : T.red, fontFamily: "'Lora', serif" }}>{(p.unrealizedGL || 0) >= 0 ? "+" : ""}{fmt$(p.unrealizedGL || 0)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", color: T.green }}>{fmt$(p.estAnnIncome || 0)}</td>
                        <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: (p.currentYield || 0) > 20 ? T.green : T.indigo }}>{(p.currentYield || 0).toFixed(2)}%</td>
                        <td style={{ padding: "11px 12px" }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: clr.bg, color: clr.color, border: `1px solid ${clr.border}`, whiteSpace: "nowrap" }}>{p.assetClass}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${T.border}`, background: T.surfaceAlt }}>
                    <td colSpan={4} style={{ padding: "11px 12px", fontWeight: 700, color: T.text }}>TOTAL ({positions.length} positions)</td>
                    <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 800, color: T.text, fontFamily: "'Lora', serif" }}>{fmt$(positions.reduce((s, p) => s + (p.marketValue || 0), 0))}</td>
                    <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: T.textSub }}>{fmt$(positions.reduce((s, p) => s + (p.totalCost || 0), 0))}</td>
                    <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 800, color: positions.reduce((s, p) => s + (p.unrealizedGL || 0), 0) >= 0 ? T.green : T.red, fontFamily: "'Lora', serif" }}>
                      {positions.reduce((s, p) => s + (p.unrealizedGL || 0), 0) >= 0 ? "+" : ""}{fmt$(positions.reduce((s, p) => s + (p.unrealizedGL || 0), 0))}
                    </td>
                    <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: T.green }}>{fmt$(positions.reduce((s, p) => s + (p.estAnnIncome || 0), 0))}</td>
                    <td style={{ padding: "11px 12px", textAlign: "right", fontWeight: 700, color: T.indigo }}>
                      {positions.reduce((s, p) => s + (p.marketValue || 0), 0) > 0 ? fmtPct(positions.reduce((s, p) => s + (p.estAnnIncome || 0), 0) / positions.reduce((s, p) => s + (p.marketValue || 0), 0), 1) : "—"}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── DIVIDENDS TAB ─────────────────────────────────────────────────────────────
function DividendsTab({ computed }) {
  const [maWindow, setMaWindow] = useState(3);
  if (computed.length === 0) return <Card><div style={{textAlign:"center",padding:48,color:T.textMuted}}><div style={{fontSize:32,marginBottom:12}}>📈</div><div style={{fontSize:14,fontWeight:600,color:T.textSub}}>No data yet</div></div></Card>;
  const divValues = computed.map(e=>e.effectiveDivs);
  const maValues = movingAverage(divValues, maWindow);
  const momDollar = computed.map((e,i)=>i===0?null:e.effectiveDivs-computed[i-1].effectiveDivs);
  const momPct = computed.map((e,i)=>i===0?null:computed[i-1].effectiveDivs>0?(e.effectiveDivs-computed[i-1].effectiveDivs)/computed[i-1].effectiveDivs:null);
  let cum=0; const cumValues = computed.map(e=>{cum+=e.effectiveDivs;return cum;});
  const latest=computed[computed.length-1]; const latestMoM$=momDollar[computed.length-1]; const latestMoMPct=momPct[computed.length-1]; const latestMA=maValues[computed.length-1]; const totalCum=cumValues[computed.length-1]; const allTimeHigh=Math.max(...divValues);
  const cagrMonths=computed.length-1; const cagr=cagrMonths>=2&&divValues[0]>0?Math.pow(divValues[divValues.length-1]/divValues[0],12/cagrMonths)-1:null;
  const W=800,H=200,pad={t:16,r:24,b:36,l:56}; const iW=W-pad.l-pad.r,iH=H-pad.t-pad.b; const maxDiv=Math.max(...divValues)*1.15||100;
  const toX=(i)=>pad.l+(i/Math.max(computed.length-1,1))*iW; const toY=(v)=>pad.t+iH-(v/maxDiv)*iH; const barW=Math.max(4,Math.min(36,iW/computed.length-4));
  const maPath=maValues.map((v,i)=>v!==null?`${toX(i)},${toY(v)}`:null).filter(Boolean); const maLine=maPath.length>1?"M"+maPath.join(" L"):null;
  const yGridVals=(()=>{const step=maxDiv<=50?10:maxDiv<=200?25:maxDiv<=500?50:maxDiv<=1000?100:200;const vals=[];for(let v=0;v<=maxDiv;v+=step)vals.push(v);return vals;})();
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:14}}>
        {[{l:"LATEST MONTH",v:fmt$(latest.effectiveDivs),sub:fmtDate(latest.date),c:T.green,badge:latest.actualDivs!==null?"ACTUAL":"EST"},{l:"MoM CHANGE ($)",v:latestMoM$!==null?(latestMoM$>=0?"+":"")+fmt$(latestMoM$):"—",sub:"vs prior month",c:latestMoM$!==null?(latestMoM$>=0?T.green:T.red):T.textMuted},{l:"MoM CHANGE (%)",v:latestMoMPct!==null?(latestMoMPct>=0?"+":"")+fmtPct(latestMoMPct,1):"—",sub:"vs prior month",c:latestMoMPct!==null?(latestMoMPct>=0?T.green:T.red):T.textMuted},{l:`${maWindow}-MONTH MA`,v:latestMA!==null?fmt$(latestMA):"—",sub:`${maWindow}-month moving avg`,c:T.indigo},{l:"CUMULATIVE TOTAL",v:fmt$(totalCum),sub:`across ${computed.length} months`,c:T.text}].map(({l,v,sub,c,badge})=>(
          <Card key={l} style={{padding:"16px 18px"}}>
            <div style={{fontSize:10,fontWeight:700,letterSpacing:"1.2px",color:T.textMuted,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>{l}{badge&&<span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:20,background:badge==="ACTUAL"?T.greenBg:T.amberBg,color:badge==="ACTUAL"?T.green:T.amber,border:`1px solid ${badge==="ACTUAL"?T.greenBorder:T.amberBorder}`}}>{badge}</span>}</div>
            <div style={{fontSize:22,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div>
            <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{sub}</div>
          </Card>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:14}}>
        {[{l:"ALL-TIME HIGH MONTH",v:fmt$(allTimeHigh),c:T.green},{l:"ANNUALIZED RUN RATE",v:fmt$(latest.effectiveDivs*12),c:T.green},{l:"ANNUALIZED GROWTH",v:cagr!==null?fmtPct(cagr,1)+"/yr":"—",c:cagr!==null&&cagr>0?T.green:T.amber},{l:"AVG MONTHLY",v:fmt$(totalCum/computed.length),c:T.textSub}].map(({l,v,c})=>(
          <Card key={l} style={{padding:"14px 18px"}}><div style={{fontSize:10,fontWeight:700,letterSpacing:"1.2px",color:T.textMuted,marginBottom:6}}>{l}</div><div style={{fontSize:18,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div></Card>
        ))}
      </div>
      <Card>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:12}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:"1.5px",color:T.textMuted}}>DIVIDEND INCOME — MONTH BY MONTH</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:11,color:T.textMuted}}>Moving avg:</span>{[3,6,12].map(w=><Pill key={w} active={maWindow===w} onClick={()=>setMaWindow(w)} color={T.indigo}>{w}mo</Pill>)}</div>
        </div>
        <div style={{display:"flex",gap:20,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:12,height:12,borderRadius:3,background:T.greenMid,opacity:0.9}}/><span style={{fontSize:11,color:T.textSub}}>Actual dividends</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:12,height:12,borderRadius:3,background:T.amberMid,opacity:0.6}}/><span style={{fontSize:11,color:T.textSub}}>Estimated</span></div>
          {maLine&&<div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width:20,height:2.5,background:T.indigo,borderRadius:1}}/><span style={{fontSize:11,color:T.textSub}}>{maWindow}-month MA</span></div>}
        </div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible"}}>
          {yGridVals.map(v=>{const y=toY(v);if(y<pad.t-5||y>pad.t+iH+5)return null;return<g key={v}><line x1={pad.l} x2={pad.l+iW} y1={y} y2={y} stroke={T.borderLight} strokeWidth="1"/><text x={pad.l-8} y={y+4} textAnchor="end" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{fmt$(v,0)}</text></g>;})}
          {computed.map((e,i)=>{const x=toX(i);const barH=Math.max(1,(e.effectiveDivs/maxDiv)*iH);const barY=pad.t+iH-barH;const isActual=e.actualDivs!==null;const isLatest=i===computed.length-1;return(<g key={i}><rect x={x-barW/2} y={barY} width={barW} height={barH} fill={isActual?T.greenMid:T.amberMid} opacity={isLatest?1:isActual?0.8:0.5} rx="3"/>{isLatest&&<rect x={x-barW/2} y={barY} width={barW} height={barH} fill="none" stroke={isActual?T.green:T.amber} strokeWidth="2" rx="3"/>}</g>);})}
          {maLine&&<path d={maLine} fill="none" stroke={T.indigo} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>}
          {maValues.map((v,i)=>v!==null?<circle key={i} cx={toX(i)} cy={toY(v)} r="3.5" fill={T.indigo} stroke={T.surface} strokeWidth="2"/>:null)}
          {computed.map((e,i)=>{if(computed.length>10&&i%2!==0)return null;return<text key={i} x={toX(i)} y={pad.t+iH+20} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{fmtDate(e.date)}</text>;})}
        </svg>
      </Card>
      {computed.length>=3&&(
        <Card>
          <SectionLabel>MONTH-OVER-MONTH CHANGE ($)</SectionLabel>
          <svg width="100%" viewBox={`0 0 ${W} 120`} style={{overflow:"visible"}}>
            {(()=>{const momData=momDollar.slice(1);const maxAbs=Math.max(...momData.map(v=>Math.abs(v||0)),10)*1.2;const cH=120,cPad={t:10,r:24,b:28,l:56};const ciW=W-cPad.l-cPad.r,ciH=cH-cPad.t-cPad.b;const midY=cPad.t+ciH/2;const toXm=(i)=>cPad.l+((i+0.5)/momData.length)*ciW;const toYm=(v)=>midY-(v/maxAbs)*(ciH/2);const bW=Math.max(4,Math.min(28,ciW/momData.length-4));return(<g><line x1={cPad.l} x2={cPad.l+ciW} y1={midY} y2={midY} stroke={T.border} strokeWidth="1"/>{momData.map((v,i)=>{if(v===null)return null;const x=toXm(i);const isPos=v>=0;const barH=Math.max(1,(Math.abs(v)/maxAbs)*(ciH/2));return(<g key={i}><rect x={x-bW/2} y={isPos?midY-barH:midY} width={bW} height={barH} fill={isPos?T.greenMid:T.red} opacity="0.75" rx="2"/>{Math.abs(v)>maxAbs*0.1&&<text x={x} y={isPos?midY-barH-4:midY+barH+12} textAnchor="middle" fill={isPos?T.green:T.red} fontSize="8" fontFamily="Nunito" fontWeight="700">{isPos?"+":""}{fmt$(v,0)}</text>}<text x={x} y={cH-4} textAnchor="middle" fill={T.textMuted} fontSize="8" fontFamily="Nunito">{fmtDate(computed[i+1].date)}</text></g>);})}<text x={cPad.l-8} y={midY+4} textAnchor="end" fill={T.textMuted} fontSize="9" fontFamily="Nunito">$0</text></g>);})()}
          </svg>
        </Card>
      )}
      <Card>
        <SectionLabel>CUMULATIVE DIVIDENDS RECEIVED</SectionLabel>
        <svg width="100%" viewBox={`0 0 ${W} 140`} style={{overflow:"visible"}}>
          {(()=>{const cH=140,cPad={t:12,r:24,b:28,l:56};const ciW=W-cPad.l-cPad.r,ciH=cH-cPad.t-cPad.b;const maxCum=cumValues[cumValues.length-1]*1.1||100;const toXc=(i)=>cPad.l+(i/Math.max(computed.length-1,1))*ciW;const toYc=(v)=>cPad.t+ciH-(v/maxCum)*ciH;const path="M"+cumValues.map((v,i)=>`${toXc(i)},${toYc(v)}`).join(" L");const area=path+` L${toXc(computed.length-1)},${cPad.t+ciH} L${toXc(0)},${cPad.t+ciH} Z`;const ySteps=[0,0.25,0.5,0.75,1.0].map(f=>maxCum*f);return(<g><defs><linearGradient id="cum-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.greenMid} stopOpacity="0.2"/><stop offset="100%" stopColor={T.greenMid} stopOpacity="0.01"/></linearGradient></defs>{ySteps.map(v=>{const y=toYc(v);return<g key={v}><line x1={cPad.l} x2={cPad.l+ciW} y1={y} y2={y} stroke={T.borderLight} strokeWidth="1"/><text x={cPad.l-8} y={y+4} textAnchor="end" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{fmt$(v,0)}</text></g>;})} <path d={area} fill="url(#cum-grad)"/><path d={path} fill="none" stroke={T.greenMid} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>{cumValues.map((v,i)=><circle key={i} cx={toXc(i)} cy={toYc(v)} r="3.5" fill={computed[i].actualDivs!==null?T.greenMid:T.amberMid} stroke={T.surface} strokeWidth="2"/>)}{computed.map((e,i)=>{if(computed.length>10&&i%2!==0)return null;return<text key={i} x={toXc(i)} y={cPad.t+ciH+16} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{fmtDate(e.date)}</text>;})}</g>);})()}
        </svg>
      </Card>
      <Card>
        <SectionLabel>COMPLETE DIVIDEND HISTORY</SectionLabel>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{borderBottom:`2px solid ${T.border}`}}>{["Month","Dividends","Type","MoM ($)","MoM (%)","${maWindow}-Mo Avg","Cumulative","Annual Rate"].map(h=><th key={h} style={{padding:"8px 14px",textAlign:"left",fontSize:10,fontWeight:700,letterSpacing:"1px",color:T.textMuted}}>{h}</th>)}</tr></thead>
            <tbody>
              {[...computed].reverse().map((e,revIdx)=>{const i=computed.length-1-revIdx;const mom$=momDollar[i];const momP=momPct[i];const ma=maValues[i];return(
                <tr key={i} style={{borderBottom:`1px solid ${T.borderLight}`}} onMouseEnter={ev=>ev.currentTarget.style.background=T.surfaceAlt} onMouseLeave={ev=>ev.currentTarget.style.background="transparent"}>
                  <td style={{padding:"11px 14px",color:T.textSub,fontWeight:600}}>{fmtDate(e.date)}</td>
                  <td style={{padding:"11px 14px",fontWeight:700,color:T.green,fontFamily:"'Lora', serif",fontSize:14}}>{fmt$(e.effectiveDivs)}</td>
                  <td style={{padding:"11px 14px"}}><span style={{fontSize:9,fontWeight:700,padding:"2px 7px",borderRadius:20,background:e.actualDivs!==null?T.greenBg:T.amberBg,color:e.actualDivs!==null?T.green:T.amber,border:`1px solid ${e.actualDivs!==null?T.greenBorder:T.amberBorder}`}}>{e.actualDivs!==null?"ACTUAL":"EST"}</span></td>
                  <td style={{padding:"11px 14px",fontWeight:600,color:mom$!==null?(mom$>=0?T.green:T.red):T.textMuted}}>{mom$!==null?(mom$>=0?"+":"")+fmt$(mom$):"—"}</td>
                  <td style={{padding:"11px 14px",fontWeight:600,color:momP!==null?(momP>=0?T.green:T.red):T.textMuted}}>{momP!==null?(momP>=0?"+":"")+fmtPct(momP,1):"—"}</td>
                  <td style={{padding:"11px 14px",color:T.indigo,fontWeight:600}}>{ma!==null?fmt$(ma):"—"}</td>
                  <td style={{padding:"11px 14px",color:T.textSub}}>{fmt$(cumValues[i])}</td>
                  <td style={{padding:"11px 14px",color:T.green}}>{fmt$(e.effectiveDivs*12)}</td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── STRESS TEST ───────────────────────────────────────────────────────────────
function RecoveryChart({ postCrashGross, margin, divs, w2, bills, marginRate, yield_, precrashEquity }) {
  const W=600,H=160,pad={t:16,r:24,b:28,l:48};const iW=W-pad.l-pad.r,iH=H-pad.t-pad.b;
  const months=36;const curve=projectCurve(postCrashGross,margin,divs,w2,bills,marginRate,yield_,months,0);
  const recoveryMonth=curve.findIndex((p,i)=>i>0&&p.equity>=precrashEquity);
  const allEqs=curve.map(p=>p.equity).concat([precrashEquity,0.50]);const rawMin=Math.min(...allEqs),rawMax=Math.max(...allEqs);const sp=Math.max(rawMax-rawMin,0.1);const eMin=Math.max(0,rawMin-sp*0.1),eMax=Math.min(1.05,rawMax+sp*0.1);const eSpan=Math.max(eMax-eMin,0.05);
  const toX=(m)=>pad.l+(m/months)*iW;const toY=(eq)=>pad.t+iH-((eq-eMin)/eSpan)*iH;
  const path="M"+curve.map((p,i)=>`${toX(i)},${toY(p.equity)}`).join(" L");
  const GRIDS=[0.10,0.20,0.30,0.40,0.50,0.55,0.60,0.70,0.80,0.90,1.00].filter(v=>v>=eMin-0.01&&v<=eMax+0.01);
  return(
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{overflow:"visible"}}>
      <defs><linearGradient id="recGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.blueMid} stopOpacity="0.15"/><stop offset="100%" stopColor={T.blueMid} stopOpacity="0.01"/></linearGradient></defs>
      {GRIDS.map(v=>{const y=toY(v);const is60=v===0.60,is55=v===0.55;return<g key={v}><line x1={pad.l} x2={pad.l+iW} y1={y} y2={y} stroke={is60?T.greenMid:is55?T.amberMid:T.borderLight} strokeWidth={1} strokeDasharray={(is60||is55)?"5,4":"0"} opacity={(is60||is55)?0.8:1}/><text x={pad.l-6} y={y+4} textAnchor="end" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{(v*100).toFixed(0)}%</text></g>;})}
      {precrashEquity>=eMin&&precrashEquity<=eMax&&(<g><line x1={pad.l} x2={pad.l+iW} y1={toY(precrashEquity)} y2={toY(precrashEquity)} stroke={T.indigo} strokeWidth={1.5} strokeDasharray="8,4" opacity={0.7}/><text x={pad.l+iW+5} y={toY(precrashEquity)+4} fill={T.indigo} fontSize="8" fontFamily="Nunito" fontWeight="700">Pre-crash</text></g>)}
      {[0,6,12,18,24,30,36].map(m=><text key={m} x={toX(m)} y={pad.t+iH+16} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{m===0?"Crash":`+${m}mo`}</text>)}
      <path d={path+` L${toX(months)},${pad.t+iH} L${toX(0)},${pad.t+iH} Z`} fill="url(#recGrad)"/>
      <path d={path} fill="none" stroke={T.blueMid} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      {recoveryMonth>0&&recoveryMonth<=months&&(<g><line x1={toX(recoveryMonth)} x2={toX(recoveryMonth)} y1={pad.t} y2={pad.t+iH} stroke={T.indigo} strokeWidth={1.5} strokeDasharray="4,3" opacity={0.6}/><circle cx={toX(recoveryMonth)} cy={toY(curve[recoveryMonth].equity)} r="5" fill={T.indigo} stroke={T.surface} strokeWidth="2"/><text x={toX(recoveryMonth)} y={pad.t-3} textAnchor="middle" fill={T.indigo} fontSize="9" fontFamily="Nunito" fontWeight="700">Recovered +{recoveryMonth}mo</text></g>)}
      {[0,12,24,36].filter(m=>m<curve.length).map(m=><circle key={m} cx={toX(m)} cy={toY(curve[m].equity)} r="3.5" fill={curve[m].equity>=0.60?T.greenMid:curve[m].equity>=0.55?T.amberMid:T.red} stroke={T.surface} strokeWidth="2"/>)}
    </svg>
  );
}

function StressTestTab({ latest, settings }) {
  const [drawdown, setDrawdown] = useState(25);
  const [nextBillAmt, setNextBillAmt] = useState("200");
  if (!latest) return <Card><div style={{textAlign:"center",padding:48,color:T.textMuted}}>Log at least one month to run stress tests.</div></Card>;
  const {gross,margin,effectiveDivs:divs,w2,bills,equity:precrashEquity}=latest;
  const {marginRate,effectiveYield:yield_}=settings;
  const d=drawdown/100; const postCrashGross=gross*(1-d); const postCrashEquity=margin>0?(postCrashGross-margin)/postCrashGross:1.0;
  const postCrashDivs=postCrashGross*yield_/12; const dollarLoss=gross-postCrashGross;
  const recoveryMonths=calcRecoveryMonths(postCrashGross,margin,postCrashDivs,w2,bills,marginRate,yield_,precrashEquity);
  const drop60=criticalDropPct(gross,margin,0.60); const drop55=criticalDropPct(gross,margin,0.55); const dropCall25=criticalDropPct(gross,margin,0.25); const noMargin=!margin||margin<=0;
  const eqStatus=(eq)=>{if(eq>=0.60)return{label:"Above trigger",color:T.green,bg:T.greenBg,border:T.greenBorder};if(eq>=0.55)return{label:"Caution zone",color:T.amber,bg:T.amberBg,border:T.amberBorder};if(eq>=0.25)return{label:"Below floor",color:T.red,bg:T.redBg,border:T.redBorder};return{label:"Margin call risk",color:T.rose,bg:T.roseBg,border:T.roseBorder};};
  const status=eqStatus(postCrashEquity);
  const CushionBar=({label,dropPct,color,bg,border})=>{const isInf=!isFinite(dropPct)||noMargin;const pct=isInf?100:Math.min(100,Math.max(0,dropPct));return(<div style={{marginBottom:18}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div style={{fontSize:12,fontWeight:600,color:T.text}}>{label}</div><div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:20,fontWeight:800,color,fontFamily:"'Lora', serif"}}>{isInf?"∞":`−${pct.toFixed(1)}%`}</span>{!isInf&&<span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:20,background:bg,color,border:`1px solid ${border}`}}>{pct>40?"Very Safe":pct>20?"Healthy":pct>10?"Watch":"Tight"}</span>}</div></div><div style={{height:8,background:T.borderLight,borderRadius:4,overflow:"hidden",position:"relative"}}><div style={{position:"absolute",inset:0,width:`${pct}%`,background:color,borderRadius:4,opacity:0.55,transition:"width 0.4s"}}/>{!isInf&&drawdown>0&&drawdown<100&&<div style={{position:"absolute",top:0,bottom:0,left:`${Math.min(drawdown,99)}%`,width:2,background:T.text,opacity:0.35}}/>}</div><div style={{fontSize:10,color:T.textMuted,marginTop:4}}>{isInf?"No margin — cannot reach this threshold through price drops alone":`Portfolio can absorb a ${pct.toFixed(1)}% drop before this line is crossed`}</div></div>);};
  const SCENARIOS=[5,10,15,20,25,30,40,50,60];
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <Card style={{background:T.text}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"1.5px",color:"rgba(255,255,255,0.4)",marginBottom:12}}>CURRENT POSITION</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {[{l:"Equity",v:fmtPct(precrashEquity),c:precrashEquity>=0.60?"#6EE7B7":"#FCD34D"},{l:"Gross",v:fmt$(gross),c:"#fff"},{l:"Margin",v:fmt$(margin),c:margin>0?"#FCA5A5":"#6EE7B7"},{l:"Net Value",v:fmt$(gross-margin),c:"#fff"}].map(({l,v,c})=>(<div key={l}><div style={{fontSize:10,color:"rgba(255,255,255,0.4)",marginBottom:4}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div></div>))}
          </div>
        </Card>
        <Card style={{background:status.bg,border:`1px solid ${status.border}`}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:"1.5px",color:status.color,marginBottom:12}}>AFTER −{drawdown}% CRASH</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {[{l:"Equity",v:fmtPct(postCrashEquity),c:status.color},{l:"Gross",v:fmt$(postCrashGross),c:T.text},{l:"Dollar Loss",v:"−"+fmt$(dollarLoss),c:T.red},{l:"Net Value",v:fmt$(postCrashGross-margin),c:T.text}].map(({l,v,c})=>(<div key={l}><div style={{fontSize:10,color:T.textMuted,marginBottom:4}}>{l}</div><div style={{fontSize:16,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div></div>))}
          </div>
          <div style={{marginTop:14,display:"flex",gap:8,flexWrap:"wrap"}}>
            <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:20,background:"rgba(0,0,0,0.07)",color:status.color}}>{status.label}</span>
            {recoveryMonths!==null?<span style={{fontSize:11,fontWeight:600,color:T.indigo,padding:"3px 10px",borderRadius:20,background:T.indigoBg,border:`1px solid ${T.indigoBorder}`}}>Recovery: ~{recoveryMonths} months</span>:<span style={{fontSize:11,fontWeight:600,color:T.red,padding:"3px 10px",borderRadius:20,background:T.redBg,border:`1px solid ${T.redBorder}`}}>Recovery: &gt;10 years</span>}
          </div>
        </Card>
      </div>
      <Card>
        <SectionLabel>CRASH SIMULATOR</SectionLabel>
        <style>{`.crash-slider{-webkit-appearance:none;height:6px;border-radius:3px;outline:none;cursor:pointer}.crash-slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:${T.red};border:3px solid #fff;box-shadow:0 2px 6px rgba(220,38,38,0.4);cursor:pointer}.crash-slider::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:${T.red};border:none;cursor:pointer}`}</style>
        <div style={{marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:12,color:T.textSub}}>Drag to simulate a market drawdown</span><div style={{fontSize:32,fontWeight:800,color:T.red,fontFamily:"'Lora', serif"}}>−{drawdown}%</div></div>
        <input type="range" min="1" max="70" value={drawdown} onChange={e=>setDrawdown(Number(e.target.value))} className="crash-slider" style={{width:"100%",marginBottom:10,background:`linear-gradient(90deg,${T.red} 0%,${T.red} ${(drawdown/70)*100}%,${T.borderLight} ${(drawdown/70)*100}%,${T.borderLight} 100%)`}}/>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textMuted,marginBottom:16}}><span>−1%</span><span>−15% correction</span><span>−30% bear</span><span>−50% crash</span><span>−70% crisis</span></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[{l:"Correction",v:10},{l:"Bear Market",v:25},{l:"2008 Crisis",v:38},{l:"Dot-Com",v:50},{l:"Worst Case",v:60}].map(({l,v})=>(<button key={v} onClick={()=>setDrawdown(v)} style={{padding:"5px 12px",background:drawdown===v?T.red:T.surfaceAlt,color:drawdown===v?"#fff":T.textSub,border:`1px solid ${drawdown===v?T.red:T.border}`,borderRadius:20,fontSize:11,fontWeight:600,fontFamily:"inherit",transition:"all 0.18s",cursor:"pointer"}}>{l} ({v}%)</button>))}
        </div>
      </Card>
      <Card><SectionLabel>SAFETY CUSHION</SectionLabel><div style={{fontSize:12,color:T.textSub,marginBottom:20,lineHeight:1.6}}>How much the market can drop before each critical line is crossed.</div><CushionBar label="Before hitting 60% trigger" dropPct={drop60} color={T.green} bg={T.greenBg} border={T.greenBorder}/><CushionBar label="Before hitting 55% hard floor" dropPct={drop55} color={T.amber} bg={T.amberBg} border={T.amberBorder}/><CushionBar label="Before margin call (25% maintenance)" dropPct={dropCall25} color={T.rose} bg={T.roseBg} border={T.roseBorder}/></Card>
      <Card><SectionLabel>RECOVERY TRAJECTORY — AFTER −{drawdown}% CRASH</SectionLabel><div style={{fontSize:12,color:T.textSub,marginBottom:14}}>Indigo dashed = pre-crash equity ({fmtPct(precrashEquity)}). {recoveryMonths!==null?`Full recovery in ~${recoveryMonths} months.`:"Full recovery >10 years at current pace."}</div><RecoveryChart postCrashGross={postCrashGross} margin={margin} divs={postCrashDivs} w2={w2} bills={bills} marginRate={marginRate} yield_={yield_} precrashEquity={precrashEquity}/></Card>
      <Card>
        <SectionLabel>FULL SCENARIO GRID — CLICK TO SIMULATE</SectionLabel>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead><tr style={{borderBottom:`2px solid ${T.border}`}}>{["Drop","Post-Crash Equity","Net Value","Divs/Mo","Status","Recovery"].map(h=><th key={h} style={{padding:"8px 14px",textAlign:"left",fontSize:10,fontWeight:700,letterSpacing:"1px",color:T.textMuted}}>{h}</th>)}</tr></thead>
            <tbody>
              {SCENARIOS.map(pct=>{const dFrac=pct/100;const pcg=gross*(1-dFrac);const pce=margin>0?(pcg-margin)/pcg:1.0;const pcd=pcg*yield_/12;const rec=calcRecoveryMonths(pcg,margin,pcd,w2,bills,marginRate,yield_,precrashEquity);const st=eqStatus(pce);const isActive=pct===drawdown;return(<tr key={pct} onClick={()=>setDrawdown(pct)} style={{borderBottom:`1px solid ${T.borderLight}`,background:isActive?T.surfaceAlt:"transparent",cursor:"pointer"}} onMouseEnter={ev=>{if(!isActive)ev.currentTarget.style.background=T.surfaceAlt;}} onMouseLeave={ev=>{if(!isActive)ev.currentTarget.style.background="transparent";}}><td style={{padding:"11px 14px",fontWeight:700,color:pct>=40?T.red:pct>=20?T.amber:T.text,fontFamily:"'Lora', serif",fontSize:14}}>−{pct}%</td><td style={{padding:"11px 14px",fontWeight:700,color:st.color,fontSize:14,fontFamily:"'Lora', serif"}}>{fmtPct(pce)}</td><td style={{padding:"11px 14px",color:T.textSub}}>{fmt$(pcg-margin)}</td><td style={{padding:"11px 14px",color:T.green}}>{fmt$(pcd)}</td><td style={{padding:"11px 14px"}}><span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:20,background:st.bg,color:st.color,border:`1px solid ${st.border}`}}>{st.label}</span></td><td style={{padding:"11px 14px",color:T.indigo,fontWeight:600}}>{rec!==null?`${rec} months`:<span style={{color:T.red}}>&gt;10 years</span>}</td></tr>);})}
            </tbody>
          </table>
        </div>
      </Card>
      <Card style={{background:T.indigoBg,border:`1px solid ${T.indigoBorder}`,boxShadow:"none"}}>
        <SectionLabel>WHAT IF YOU ADD A BILL, THEN THE MARKET CRASHES?</SectionLabel>
        <div style={{display:"flex",gap:14,alignItems:"center",marginBottom:16,flexWrap:"wrap"}}><span style={{fontSize:12,color:T.textSub}}>Simulate adding</span><div style={{display:"flex",alignItems:"center",gap:6}}><span style={{color:T.textMuted}}>$</span><input value={nextBillAmt} onChange={e=>setNextBillAmt(e.target.value)} style={{width:80,padding:"7px 10px",background:T.surface,border:`1px solid ${T.indigoBorder}`,borderRadius:T.radiusXs,fontSize:14,fontWeight:700,color:T.indigo,fontFamily:"'Lora', serif",outline:"none",textAlign:"right"}}/><span style={{color:T.textMuted}}>/mo</span></div><span style={{fontSize:12,color:T.textSub}}>then absorbing a −{drawdown}% crash</span></div>
        {(()=>{const billAmt=parseNum(nextBillAmt)||0;if(!billAmt)return null;const pcg2=gross*(1-d);const pce2=margin>0?(pcg2-margin)/pcg2:1.0;const rec2=calcRecoveryMonths(pcg2,margin,pcg2*yield_/12,w2+billAmt,bills+billAmt,marginRate,yield_,precrashEquity);const st2=eqStatus(pce2);return(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>{[{l:"Crash equity (no new bill)",v:fmtPct(postCrashEquity),c:status.color},{l:`Crash equity (with +${fmt$(billAmt,0)}/mo)`,v:fmtPct(pce2),c:st2.color},{l:"Recovery (with new bill)",v:rec2!==null?`${rec2} months`:">10 years",c:T.indigo}].map(({l,v,c})=>(<div key={l} style={{background:T.surface,borderRadius:T.radiusSm,padding:"14px 16px",border:`1px solid ${T.indigoBorder}`}}><div style={{fontSize:11,color:T.textMuted,marginBottom:6,lineHeight:1.4}}>{l}</div><div style={{fontSize:20,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</div></div>))}</div>);})()}
      </Card>
    </div>
  );
}

// ── SETTINGS TAB ──────────────────────────────────────────────────────────────
function SettingsTab({ settings, setSettings, derivedYield, hasActualData, holdingsYield, hasHoldings }) {
  const [local, setLocal] = useState({ ...settings, marginRateStr: (settings.marginRate*100).toFixed(2), targetYieldStr: (settings.targetYield*100).toFixed(1) });
  const apply = () => { const mr=parseNum(local.marginRateStr)/100; const ty=parseNum(local.targetYieldStr)/100; if(mr>0&&mr<1&&ty>0&&ty<2)setSettings(s=>({...s,marginRate:mr,targetYield:ty,yieldMode:local.yieldMode})); };
  const yieldModes = [
    { id: "manual", label: "Manual Override", desc: "You set the yield percentage" },
    { id: "auto", label: "Auto — from Dividends", desc: "Derived from your actual dividend logs" },
    { id: "holdings", label: "Auto — from Holdings", desc: "Calculated from position-level Est. Annual Income" },
  ];
  return(
    <div style={{maxWidth:700,display:"flex",flexDirection:"column",gap:20}}>
      <Card>
        <SectionLabel>MARGIN INTEREST RATE</SectionLabel>
        <div style={{display:"flex",gap:20,alignItems:"flex-end",flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:200}}>
            <Input label="Your current E-Trade margin rate" hint="(annual %)" value={local.marginRateStr} onChange={e=>setLocal(l=>({...l,marginRateStr:e.target.value}))} placeholder="e.g. 8.44"/>
            <div style={{marginTop:8,fontSize:11,color:T.textMuted,lineHeight:1.6}}>Default is 8.44% (negotiated). Call E-Trade for the active trader rate — worth <strong style={{color:T.text}}>$55K+ over 10 years</strong>.</div>
          </div>
          <div style={{background:T.surfaceAlt,border:`1px solid ${T.border}`,borderRadius:T.radiusSm,padding:"14px 18px",minWidth:160,textAlign:"center"}}>
            <div style={{fontSize:10,color:T.textMuted,fontWeight:600,letterSpacing:"1px",marginBottom:6}}>CURRENT SETTING</div>
            <div style={{fontSize:32,fontWeight:700,color:T.red,fontFamily:"'Lora', serif"}}>{(settings.marginRate*100).toFixed(2)}%</div>
          </div>
        </div>
      </Card>
      <Card>
        <SectionLabel>PORTFOLIO YIELD SOURCE</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
          {yieldModes.map(m=>(
            <div key={m.id} onClick={()=>setLocal(l=>({...l,yieldMode:m.id}))} style={{display:"flex",alignItems:"center",gap:14,padding:"14px 16px",borderRadius:T.radiusSm,border:`2px solid ${local.yieldMode===m.id?T.text:T.border}`,background:local.yieldMode===m.id?T.surfaceAlt:T.surface,cursor:"pointer",transition:"all 0.18s"}}>
              <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${local.yieldMode===m.id?T.text:T.border}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {local.yieldMode===m.id&&<div style={{width:8,height:8,borderRadius:"50%",background:T.text}}/>}
              </div>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>{m.label}</div>
                <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>{m.desc}</div>
              </div>
              {m.id==="auto"&&hasActualData&&<div style={{fontSize:14,fontWeight:700,color:T.green,fontFamily:"'Lora', serif"}}>{fmtPct(derivedYield,1)}</div>}
              {m.id==="holdings"&&hasHoldings&&<div style={{fontSize:14,fontWeight:700,color:T.indigo,fontFamily:"'Lora', serif"}}>{holdingsYield?fmtPct(holdingsYield,1):"—"}</div>}
              {m.id==="holdings"&&!hasHoldings&&<div style={{fontSize:11,color:T.textMuted}}>Upload holdings first</div>}
            </div>
          ))}
        </div>
        {local.yieldMode==="manual"&&(
          <div>
            <Input label="Manual yield %" hint="(annual %)" value={local.targetYieldStr} onChange={e=>setLocal(l=>({...l,targetYieldStr:e.target.value}))} placeholder="e.g. 23.0"/>
            <div style={{marginTop:10,fontSize:11,color:T.textMuted,lineHeight:1.7}}><strong style={{color:T.text}}>Lower (15–18%):</strong> stable NAV, conservative. <strong style={{color:T.text}}>Higher (30–40%):</strong> faster dividends, more NAV erosion risk.</div>
          </div>
        )}
        {local.yieldMode==="holdings"&&!hasHoldings&&(
          <div style={{padding:"12px 14px",background:T.amberBg,border:`1px solid ${T.amberBorder}`,borderRadius:T.radiusSm,fontSize:12,color:T.amber}}>Upload a portfolio snapshot in the Holdings tab first. Until then, the manual yield is used as fallback.</div>
        )}
        {local.yieldMode==="holdings"&&hasHoldings&&holdingsYield&&(
          <div style={{padding:"12px 14px",background:T.indigoBg,border:`1px solid ${T.indigoBorder}`,borderRadius:T.radiusSm,fontSize:12,color:T.indigo,lineHeight:1.7}}>
            <strong>Position-level yield active.</strong> Calculated as Total Est. Annual Income ÷ Total Market Value from your latest holdings snapshot. Updates automatically whenever you upload a new snapshot.
          </div>
        )}
        <div style={{marginTop:16,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
          {[{label:"Conservative",yield_:0.15,note:"Stable NAV"},{label:"Current Active",yield_:settings.effectiveYield,note:"What projections use"},{label:"Aggressive",yield_:0.35,note:"NAV erosion risk"}].map(({label,yield_,note})=>(
            <div key={label} onClick={()=>{if(local.yieldMode==="manual")setLocal(l=>({...l,targetYieldStr:(yield_*100).toFixed(1)}));}} style={{background:T.surfaceAlt,border:`1px solid ${T.border}`,borderRadius:T.radiusSm,padding:"14px",cursor:local.yieldMode==="manual"?"pointer":"default"}}>
              <div style={{fontSize:10,color:T.textMuted,fontWeight:600,marginBottom:4}}>{label}</div>
              <div style={{fontSize:22,fontWeight:700,color:T.text,fontFamily:"'Lora', serif"}}>{fmtPct(yield_,0)}</div>
              <div style={{fontSize:10,color:T.textMuted,marginTop:4}}>{note}</div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{display:"flex",gap:12,alignItems:"center"}}>
        <button onClick={apply} style={{padding:"11px 28px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>Save Settings</button>
        <button onClick={()=>{setLocal({...DEFAULT_SETTINGS,marginRateStr:"8.44",targetYieldStr:"23.0"});setSettings(DEFAULT_SETTINGS);}} style={{padding:"11px 20px",background:"transparent",color:T.textSub,border:`1px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Reset to Defaults</button>
      </div>
    </div>
  );
}

// ── HELP PAGE ─────────────────────────────────────────────────────────────────
function HelpPage() {
  const Term=({term,color=T.text,children})=>(<div style={{marginBottom:10,padding:"12px 16px",background:T.surfaceAlt,border:`1px solid ${T.borderLight}`,borderRadius:T.radiusSm}}><div style={{fontSize:12,fontWeight:700,color,marginBottom:4}}>{term}</div><div style={{fontSize:12,color:T.textSub,lineHeight:1.75}}>{children}</div></div>);
  const Step=({n,children})=>(<div style={{display:"flex",gap:14,marginBottom:12}}><div style={{width:26,height:26,borderRadius:"50%",background:T.text,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",flexShrink:0,fontWeight:700}}>{n}</div><div style={{fontSize:12,color:T.textSub,lineHeight:1.75,paddingTop:4}}>{children}</div></div>);
  const Note=({icon,children,color=T.textSub,bg=T.surfaceAlt,border=T.border})=>(<div style={{background:bg,border:`1px solid ${border}`,borderRadius:T.radiusSm,padding:"12px 16px",marginBottom:12,display:"flex",gap:10}}><span style={{flexShrink:0}}>{icon}</span><div style={{fontSize:12,color,lineHeight:1.75}}>{children}</div></div>);
  return(
    <div style={{maxWidth:960,display:"grid",gridTemplateColumns:"1fr 1fr",gap:28}}>
      <div>
        <Card style={{marginBottom:20}}>
          <SectionLabel>HOW TO USE THIS TRACKER</SectionLabel>
          <Note icon="📅" color={T.amber} bg={T.amberBg} border={T.amberBorder}>Log once per month on the <strong>1st of each month</strong>.</Note>
          <Step n={1}><strong>Option A — PDF Upload:</strong> Click "+ Log Month" → upload your E-Trade statement PDF → Claude AI auto-fills Gross, Margin, Dividends, Interest, and Month.</Step>
          <Step n={2}><strong>Option B — Manual:</strong> Enter Gross Portfolio (Total Assets), Margin Balance, W2 Deposit, Bills Floated, Actual Dividends, and Actual Interest from your statement.</Step>
          <Step n={3}>Separately, upload to the <strong>Holdings tab</strong> anytime you want to snapshot your positions — after each paycheck deploy, or when you add new positions. This gives you position-level yield data and asset allocation tracking.</Step>
          <Step n={4}>When all 3 green conditions fire — act the same day. Toggle the bill in Bill Tracker, update your deposit.</Step>
          <Note icon="✏️" color={T.blue} bg={T.blueBg} border={T.blueBorder}>Made a mistake? Use the <strong>Edit</strong> button on any History entry to correct it.</Note>
          <Note icon="📊" color={T.indigo} bg={T.indigoBg} border={T.indigoBorder}>In Settings, choose your yield source: Manual, Auto from dividends, or Auto from holdings (most accurate).</Note>
        </Card>
        <Card>
          <SectionLabel>THE THREE CONDITIONS</SectionLabel>
          <Term term="Condition 1 — Equity ≥ 60%" color={T.green}>Equity = <strong>(Gross − Margin) ÷ Gross</strong>. Must be at or above 60%.</Term>
          <Term term="Condition 2 — Rising 2+ Consecutive Months" color={T.amber}>Equity must increase for at least 2 months in a row. Streak resets on any dip.</Term>
          <Term term="Condition 3 — 3-Month Forward Floor ≥ 55%" color={T.blue}>Simulates the next 3 months with the new bill added. Every projected month must stay ≥ 55%.</Term>
        </Card>
      </div>
      <div>
        <Card style={{marginBottom:20}}>
          <SectionLabel>TERM DEFINITIONS</SectionLabel>
          <Term term="Gross Portfolio Value (Total Assets)">Total market value of all positions before subtracting margin. In your E-Trade statement: Balance Sheet → Total Assets.</Term>
          <Term term="Margin Balance">Your margin loan — Cash, BDP, MMFs (Debit) on the Balance Sheet. Always a positive number in the app.</Term>
          <Term term="Actual Interest">What E-Trade actually charged in margin interest. Found in the Margin Loan Interest Schedule — Total Interest on Margin Loan. More accurate than the estimate.</Term>
          <Term term="Equity %" color={T.green}><strong>(Gross − Margin) ÷ Gross.</strong> The single most important number. Keep above 60% to add bills, 55% always.</Term>
          <Term term="Net Margin Draw" color={T.red}><strong>Bills − Dividends.</strong> Monthly amount added to margin. Goal: $0.</Term>
          <Term term="Blended Yield (Holdings)" color={T.indigo}>Calculated from your actual positions: Total Est. Annual Income ÷ Total Market Value. More accurate than a flat 23% assumption as your portfolio grows and evolves.</Term>
          <Term term="Holdings Snapshot">A full point-in-time capture of your portfolio — every position, market value, gain/loss, and yield. Stored separately from monthly logs. Upload as often as you like.</Term>
        </Card>
        <Card>
          <SectionLabel>KEY NUMBERS</SectionLabel>
          {[{l:"Trigger equity",v:"60%",c:T.green},{l:"Hard floor",v:"55%",c:T.amber},{l:"Rising streak",v:"2 months",c:T.text},{l:"Forward check",v:"3 months",c:T.blue},{l:"Target yield",v:"23%",c:T.green},{l:"Negotiated rate",v:"8.44%",c:T.red},{l:"E-Trade maintenance",v:"25%",c:T.rose}].map(({l,v,c})=>(<div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${T.borderLight}`}}><span style={{fontSize:12,color:T.text}}>{l}</span><span style={{fontSize:15,fontWeight:700,color:c,fontFamily:"'Lora', serif"}}>{v}</span></div>))}
          <div style={{marginTop:16}}><SectionLabel>WHERE TO FIND YOUR NUMBERS</SectionLabel>
            {[{l:"Gross (Total Assets)",w:"Balance Sheet → Total Assets"},{l:"Margin Loan",w:"Balance Sheet → Cash, BDP, MMFs (Debit)"},{l:"Actual Dividends",w:"Income and Distribution Summary → Total Income"},{l:"Actual Interest",w:"Margin Loan Interest Schedule → Total Interest"},{l:"Your Margin Rate",w:"Margin Loan Interest Schedule → Interest Rate %"}].map(({l,w})=>(<div key={l} style={{padding:"9px 12px",background:T.surfaceAlt,borderRadius:T.radiusXs,marginBottom:6}}><div style={{fontSize:11,fontWeight:600,color:T.text}}>{l}</div><div style={{fontSize:11,color:T.textMuted,marginTop:2}}>→ {w}</div></div>))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── QUICK CHECK ───────────────────────────────────────────────────────────────
function QuickCheckModal({ onClose, latest, settings }) {
  const [qGross,setQGross]=useState(""); const [qMargin,setQMargin]=useState(""); const [result,setResult]=useState(null);
  const eqColor=(eq)=>eq>=0.60?T.green:eq>=0.55?T.amber:T.red;
  const check=()=>{const g=parseNum(qGross),m=parseNum(qMargin);if(!g)return;const equity=(g-m)/g;const divs=g*settings.effectiveYield/12;setResult({equity,divs,change:latest?equity-latest.equity:null});};
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(28,25,23,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:16,backdropFilter:"blur(4px)"}} onClick={onClose}>
      <div style={{background:T.surface,borderRadius:T.radius,boxShadow:T.shadowHover,padding:28,width:380,maxWidth:"100%"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:4,fontFamily:"'Lora', serif"}}>Quick Check</div>
        <div style={{fontSize:12,color:T.textMuted,marginBottom:20}}>Snapshot equity without saving a log entry</div>
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:16}}>
          <Input label="GROSS PORTFOLIO ($)" value={qGross} onChange={e=>setQGross(e.target.value)} placeholder="e.g. 5,419.12"/>
          <Input label="MARGIN BALANCE ($)" value={qMargin} onChange={e=>setQMargin(e.target.value)} placeholder="e.g. 1,654.71"/>
        </div>
        <button onClick={check} style={{width:"100%",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,padding:"11px",fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:result?16:0}}>Calculate</button>
        {result&&(<div style={{background:T.surfaceAlt,borderRadius:T.radiusSm,padding:16,border:`1px solid ${T.border}`}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:12}}>
            <div><div style={{fontSize:10,color:T.textMuted,fontWeight:600,marginBottom:4}}>CURRENT EQUITY</div><div style={{fontSize:32,fontWeight:700,color:eqColor(result.equity),fontFamily:"'Lora', serif"}}>{fmtPct(result.equity)}</div>{result.change!==null&&<div style={{fontSize:11,color:result.change>=0?T.green:T.red,marginTop:4}}>{result.change>=0?"▲ +":"▼ "}{fmtPct(result.change,1)} vs last log</div>}</div>
            <div><div style={{fontSize:10,color:T.textMuted,fontWeight:600,marginBottom:4}}>STATUS</div><div style={{fontSize:13,fontWeight:700,color:eqColor(result.equity),marginTop:8}}>{result.equity>=0.60?"✓ Above trigger":result.equity>=0.55?"⚠ Caution zone":"✗ Below floor"}</div><div style={{fontSize:11,color:T.textMuted,marginTop:6}}>Est. {fmt$(result.divs)}/mo divs</div></div>
          </div>
          <div style={{fontSize:11,color:T.textMuted,padding:"8px 12px",background:T.surface,borderRadius:T.radiusXs}}>Snapshot only — not saved. Log officially on the 1st.</div>
        </div>)}
        <button onClick={onClose} style={{width:"100%",background:"transparent",color:T.textMuted,border:`1px solid ${T.border}`,borderRadius:T.radiusXs,padding:"10px",fontFamily:"inherit",fontSize:13,cursor:"pointer",marginTop:12}}>Close</button>
      </div>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [entries, setEntries] = useState([]);
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [billItems, setBillItems] = useState([]);
  const [holdingSnapshots, setHoldingSnapshots] = useState([]);
  const [form, setForm] = useState({ gross:"", margin:"", w2:"871", bills:"801", actualDivs:"", actualInterest:"", date:new Date().toISOString().slice(0,7) });
  const [nextBill, setNextBill] = useState("200");
  const [showAdd, setShowAdd] = useState(false);
  const [editIdx, setEditIdx] = useState(null);
  const [showQC, setShowQC] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try { const v=await store.get(STORAGE_KEY); if(v)setEntries(JSON.parse(v)); } catch {}
      try { const v=await store.get(SETTINGS_KEY); if(v)setSettingsState(prev=>({...prev,...JSON.parse(v)})); } catch {}
      try { const v=await store.get(BILLS_KEY); if(v)setBillItems(JSON.parse(v)); } catch {}
      try { const v=await store.get(HOLDINGS_KEY); if(v)setHoldingSnapshots(JSON.parse(v)); } catch {}
    };
    load();
  }, []);

  const saveEntries = useCallback(async (data) => { try { await store.set(STORAGE_KEY, JSON.stringify(data)); } catch {} }, []);
  const setSettings = useCallback(async (updater) => { setSettingsState(prev => { const next=typeof updater==="function"?updater(prev):updater; store.set(SETTINGS_KEY,JSON.stringify(next)).catch(()=>{}); return next; }); }, []);
  const saveBills = useCallback(async (data) => { try { await store.set(BILLS_KEY, JSON.stringify(data)); } catch {} }, []);
  const saveHoldings = useCallback(async (data) => { try { await store.set(HOLDINGS_KEY, JSON.stringify(data)); } catch {} }, []);

  // Yield calculations
  const derivedYield = useMemo(() => {
    const w=entries.filter(e=>e.actualDivs!=null&&e.actualDivs!==""&&e.gross>0);
    if(!w.length)return DEFAULT_SETTINGS.targetYield;
    const avg=w.reduce((sum,e)=>sum+(parseNum(e.actualDivs)*12)/e.gross,0)/w.length;
    return avg>0?avg:DEFAULT_SETTINGS.targetYield;
  }, [entries]);

  const latestHoldings = holdingSnapshots.length ? holdingSnapshots[holdingSnapshots.length - 1] : null;
  const holdingsYield = useMemo(() => {
    if (!latestHoldings?.positions) return null;
    const totalMV = latestHoldings.positions.reduce((s,p)=>s+(p.marketValue||0),0);
    const totalEAI = latestHoldings.positions.reduce((s,p)=>s+(p.estAnnIncome||0),0);
    return totalMV>0?totalEAI/totalMV:null;
  }, [latestHoldings]);

  const effectiveYield = useMemo(() => {
    if (settings.yieldMode === "auto" && entries.some(e=>e.actualDivs!=null&&e.actualDivs!=="")) return derivedYield;
    if (settings.yieldMode === "holdings" && holdingsYield) return holdingsYield;
    return settings.targetYield;
  }, [settings, derivedYield, holdingsYield, entries]);

  const fullSettings = { ...settings, effectiveYield };
  const floatedBillsTotal = useMemo(()=>billItems.filter(b=>b.isFloated).reduce((s,b)=>s+b.amount,0),[billItems]);

  const computed = useMemo(() => entries.map((e, i) => {
    const equity=(e.gross-e.margin)/e.gross;
    const prev=i>0?entries[i-1]:null;
    const prevEquity=prev?(prev.gross-prev.margin)/prev.gross:null;
    const rising=prevEquity!==null?equity>prevEquity:null;
    const estimatedDivs=e.gross*effectiveYield/12;
    const actualDivs=e.actualDivs!=null&&e.actualDivs!==""?parseNum(e.actualDivs):null;
    const effectiveDivs=actualDivs!==null?actualDivs:estimatedDivs;
    const prevEff=prev?(prev.actualDivs!=null&&prev.actualDivs!==""?parseNum(prev.actualDivs):prev.gross*effectiveYield/12):null;
    const divGrowth=prevEff!==null?effectiveDivs-prevEff:null;
    const coverage=effectiveDivs/e.bills;
    const netDraw=Math.max(0,e.bills-effectiveDivs);
    const estimatedInterest=e.margin*settings.marginRate/12;
    const actualInterest=e.actualInterest!=null&&e.actualInterest!==""?parseNum(e.actualInterest):null;
    const effectiveInterest=actualInterest!==null?actualInterest:estimatedInterest;
    const actualYield=actualDivs!==null?(actualDivs*12)/e.gross:effectiveYield;
    const equityMomentum=prevEquity!==null?equity-prevEquity:null;
    // True net draw includes interest
    const trueNetDraw=Math.max(0,e.bills+effectiveInterest-effectiveDivs);
    return {...e,equity,prevEquity,rising,estimatedDivs,actualDivs,effectiveDivs,divGrowth,coverage,netDraw,estimatedInterest,actualInterest,effectiveInterest,actualYield,equityMomentum,trueNetDraw};
  }), [entries, effectiveYield, settings.marginRate]);

  const latest=computed[computed.length-1];
  const nextBillAmt=parseNum(nextBill)||200;
  let risingStreak=0; for(let i=computed.length-1;i>=1;i--){if(computed[i].rising)risingStreak++;else break;}
  const cond1=latest?latest.equity>=0.60:false;
  const cond2=risingStreak>=2;
  const cond3=latest?projectMinEquity(latest.gross,latest.margin,latest.effectiveDivs,latest.w2+nextBillAmt,latest.bills+nextBillAmt,settings.marginRate,effectiveYield,3)>=0.55:false;
  const allGreen=cond1&&cond2&&cond3;
  const freedomMonths=latest?projectFreedomMonths(latest.gross,latest.margin,latest.effectiveDivs,latest.w2,latest.bills,settings.marginRate,effectiveYield):null;
  const freedomDate=getFreedomDate(freedomMonths);
  const daysUntilLog=getDaysUntilNextLog(entries);
  const totalDivsReceived=computed.reduce((s,e)=>s+e.effectiveDivs,0);
  const recentMom=computed.slice(-3).map(e=>e.equityMomentum).filter(v=>v!==null);
  const equityMomAvg=recentMom.length?recentMom.reduce((a,b)=>a+b,0)/recentMom.length:null;
  const monthsToTrigger=equityMomAvg>0&&latest&&!cond1?Math.ceil((0.60-latest.equity)/equityMomAvg):null;
  const eqColor=(eq)=>eq>=0.60?T.green:eq>=0.55?T.amber:T.red;

  const openAdd=()=>{setEditIdx(null);setForm({gross:"",margin:"",w2:latest?String(latest.w2):"871",bills:latest?String(latest.bills):"801",actualDivs:"",actualInterest:"",date:new Date().toISOString().slice(0,7)});setPdfStatus(null);setSaveError(null);setShowAdd(true);};
  const openEdit=(idx)=>{const e=entries[idx];setEditIdx(idx);setForm({gross:String(e.gross),margin:String(e.margin),w2:String(e.w2),bills:String(e.bills),actualDivs:e.actualDivs!=null?String(e.actualDivs):"",actualInterest:e.actualInterest!=null?String(e.actualInterest):"",date:e.date});setPdfStatus(null);setSaveError(null);setShowAdd(true);};

  const handleSave=async()=>{
    setSaveError(null);
    const g=parseNum(form.gross),m=parseNum(form.margin),w=parseNum(form.w2),b=parseNum(form.bills);
    if(!form.gross.trim()){setSaveError("Gross Portfolio is required.");return;}
    if(g<=0){setSaveError("Gross Portfolio must be greater than 0.");return;}
    if(!form.w2.trim()||w<=0){setSaveError("W2 Deposit is required.");return;}
    if(!form.bills.trim()||b<=0){setSaveError("Bills Floated is required.");return;}
    try{
      const actualDivs=form.actualDivs.trim()!==""?parseNum(form.actualDivs):null;
      const actualInterest=form.actualInterest.trim()!==""?parseNum(form.actualInterest):null;
      const entry={date:form.date,gross:g,margin:m,w2:w,bills:b,actualDivs,actualInterest};
      let newEntries;
      if(editIdx!==null){newEntries=entries.map((e,i)=>i===editIdx?entry:e);}
      else{newEntries=[...entries,entry].sort((a,b2)=>a.date.localeCompare(b2.date));}
      setEntries(newEntries);setShowAdd(false);setForm(f=>({...f,gross:"",margin:"",actualDivs:"",actualInterest:""}));
      setPulse(true);setTimeout(()=>setPulse(false),800);
      saveEntries(newEntries).catch(()=>{});
    }catch{setSaveError("Something went wrong. Please try again.");}
  };

  const handleDelete=async(idx)=>{const n=entries.filter((_,i)=>i!==idx);setEntries(n);await saveEntries(n);};

  const handlePdfFile=async(file)=>{
    if(!file||file.type!=="application/pdf"){setPdfStatus("error: not a PDF");return;}
    setPdfLoading(true);setPdfStatus(null);
    try{
      const extracted=await extractStatementFromPdf(file);
      if(extracted.gross>0){
        setForm(f=>({...f,gross:String(extracted.gross),margin:String(extracted.margin||0),actualDivs:extracted.dividends>0?String(extracted.dividends):f.actualDivs,actualInterest:extracted.interest>0?String(extracted.interest):f.actualInterest,date:extracted.date||f.date}));
        setPdfStatus("success");
      }else{setPdfStatus("error: gross was 0 — check PDF");}
    }catch(err){setPdfStatus("error: " + (err?.message || String(err)));}
    setPdfLoading(false);
  };

  // Chart
  const chartH=180,chartW=640,cPad={t:16,r:24,b:30,l:48};
  const ciW=chartW-cPad.l-cPad.r,ciH=chartH-cPad.t-cPad.b;
  const allEqs=computed.map(e=>e.equity);
  const rawEqMin=computed.length?Math.min(...allEqs):0.5,rawEqMax=computed.length?Math.max(...allEqs):1.0;
  const eqPadAmt=Math.max((rawEqMax-rawEqMin)*0.12,0.04);
  const eqMin=Math.max(0,rawEqMin-eqPadAmt),eqMax=Math.min(1.05,rawEqMax+eqPadAmt);
  const eqSpan=Math.max(eqMax-eqMin,0.05);
  const toX=(i)=>cPad.l+(i/Math.max(computed.length-1,1))*ciW;
  const toY=(eq)=>cPad.t+ciH-((eq-eqMin)/eqSpan)*ciH;
  const linePath=computed.length>1?"M"+computed.map((e,i)=>`${toX(i)},${toY(e.equity)}`).join(" L"):null;
  const areaPath=linePath?linePath+` L${toX(computed.length-1)},${cPad.t+ciH} L${toX(0)},${cPad.t+ciH} Z`:null;

  const TABS=[["dashboard","Overview"],["modeler","Bill Modeler"],["bills","Bill Tracker"],["holdings","Holdings"],["dividends","Dividends"],["stress","Stress Test"],["metrics","Metrics"],["log","History"],["settings","Settings"],["help","Help"]];

  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:"'Nunito', 'Helvetica Neue', Arial, sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&family=Nunito:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:6px;} ::-webkit-scrollbar-track{background:${T.bg};} ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
        input:focus{outline:none;} button{cursor:pointer;}
        .pulse{animation:pa 0.5s ease-out;} @keyframes pa{0%{transform:scale(1)}50%{transform:scale(1.008)}100%{transform:scale(1)}}
        .trigger-glow{animation:glow 2.5s ease-in-out infinite alternate;} @keyframes glow{from{box-shadow:0 4px 20px rgba(21,128,61,0.15)}to{box-shadow:0 8px 40px rgba(21,128,61,0.3)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .crash-slider{-webkit-appearance:none;height:6px;border-radius:3px;outline:none;cursor:pointer;}
        .crash-slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:${T.red};border:3px solid #fff;box-shadow:0 2px 6px rgba(220,38,38,0.4);cursor:pointer;}
        .crash-slider::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:${T.red};border:none;cursor:pointer;}
        .pdf-drop{border:2px dashed ${T.border};border-radius:${T.radiusSm};padding:18px;text-align:center;cursor:pointer;transition:all 0.18s;}
        .pdf-drop:hover{border-color:${T.blueMid};background:${T.blueBg};}
      `}</style>

      {/* Top bar */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"0 32px",position:"sticky",top:0,zIndex:40}}>
        <div style={{maxWidth:1280,margin:"0 auto",display:"flex",justifyContent:"space-between",alignItems:"center",height:64}}>
          <div style={{display:"flex",alignItems:"baseline",gap:12}}>
            <div style={{fontSize:18,fontWeight:800,color:T.text,fontFamily:"'Lora', serif"}}>P2P Equity Tracker</div>
            <div style={{fontSize:11,color:T.textMuted}}>Paycheck to Portfolio</div>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center"}}>
            {daysUntilLog!==null&&(<div style={{padding:"5px 14px",borderRadius:20,fontSize:11,fontWeight:600,background:daysUntilLog<=3?T.redBg:daysUntilLog<=7?T.amberBg:T.surfaceAlt,color:daysUntilLog<=3?T.red:daysUntilLog<=7?T.amber:T.textMuted,border:`1px solid ${daysUntilLog<=3?T.redBorder:daysUntilLog<=7?T.amberBorder:T.border}`}}>{daysUntilLog>0?`Log in ${daysUntilLog}d`:daysUntilLog===0?"Log due today":"Log overdue"}</div>)}
            {floatedBillsTotal>0&&<div style={{padding:"5px 14px",borderRadius:20,fontSize:11,fontWeight:600,background:T.greenBg,color:T.green,border:`1px solid ${T.greenBorder}`}}>{fmt$(floatedBillsTotal,0)}/mo routing</div>}
            {latestHoldings&&<div style={{padding:"5px 14px",borderRadius:20,fontSize:11,fontWeight:600,background:T.indigoBg,color:T.indigo,border:`1px solid ${T.indigoBorder}`}}>Holdings: {fmtTS(latestHoldings.uploadedAt).split(",")[0]}</div>}
            <button onClick={()=>setShowQC(true)} style={{padding:"8px 16px",background:T.blueBg,color:T.blue,border:`1px solid ${T.blueBorder}`,borderRadius:8,fontSize:12,fontWeight:700,fontFamily:"inherit"}}>Quick Check</button>
            <button onClick={openAdd} style={{padding:"8px 20px",background:T.text,color:"#fff",border:"none",borderRadius:8,fontSize:12,fontWeight:700,fontFamily:"inherit"}}>+ Log Month</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,overflowX:"auto"}}>
        <div style={{maxWidth:1280,margin:"0 auto",padding:"0 32px",display:"flex",gap:0,minWidth:"max-content"}}>
          {TABS.map(([id,label])=>(
            <button key={id} onClick={()=>setActiveTab(id)} style={{padding:"14px 16px",background:"transparent",border:"none",borderBottom:`2.5px solid ${activeTab===id?T.text:"transparent"}`,color:activeTab===id?T.text:T.textMuted,fontFamily:"inherit",fontSize:13,fontWeight:activeTab===id?700:500,transition:"all 0.18s",whiteSpace:"nowrap"}}>
              {id==="bills"&&billItems.length>0&&<span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:10,background:T.greenBg,color:T.green,border:`1px solid ${T.greenBorder}`,marginRight:5}}>{billItems.filter(b=>b.isFloated).length}/{billItems.length}</span>}
              {id==="holdings"&&holdingSnapshots.length>0&&<span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:10,background:T.indigoBg,color:T.indigo,border:`1px solid ${T.indigoBorder}`,marginRight:5}}>{holdingSnapshots.length}</span>}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{maxWidth:1280,margin:"0 auto",padding:"32px"}}>

        {activeTab==="dashboard"&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:24}}>
            <div style={{display:"flex",flexDirection:"column",gap:20}}>
              {computed.length>=2&&(allGreen?(
                <div className="trigger-glow" style={{background:T.greenBg,border:`1.5px solid ${T.greenBorder}`,borderRadius:T.radius,padding:"20px 28px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div><div style={{fontSize:20,fontWeight:800,color:T.green,fontFamily:"'Lora', serif"}}>Add your next bill now</div><div style={{fontSize:12,color:T.textSub,marginTop:4}}>All 3 conditions met — redirect +${nextBillAmt.toLocaleString()}/mo immediately</div></div>
                  <div style={{fontSize:36}}>🟢</div>
                </div>
              ):(
                <div style={{background:T.amberBg,border:`1px solid ${T.amberBorder}`,borderRadius:T.radius,padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div><div style={{fontSize:15,fontWeight:700,color:T.amber}}>Holding — {[cond1,cond2,cond3].filter(Boolean).length} of 3 conditions met</div><div style={{fontSize:12,color:T.textSub,marginTop:3}}>Log monthly to track progress</div></div>
                  <div style={{fontSize:20,fontWeight:800,color:T.amber,fontFamily:"'Lora', serif"}}>{[cond1,cond2,cond3].filter(Boolean).length}/3</div>
                </div>
              ))}
              {latest&&(
                <Card style={{background:T.text}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:24}}>
                    {[{l:"FREEDOM DATE",v:freedomDate||"—",sub:freedomMonths?`${freedomMonths} months away`:""},{l:"NET DRAW (w/ interest)",v:fmt$(latest.trueNetDraw),sub:"bills + interest − dividends",c:latest.trueNetDraw>0?"#FCA5A5":"#6EE7B7"},{l:"ANNUAL RUN RATE",v:fmt$(latest.effectiveDivs*12),sub:latest.actualDivs!==null?"from actual data":"estimated",c:"#6EE7B7"},{l:"ALL-TIME DIVS",v:fmt$(totalDivsReceived),sub:`${entries.length} months`,c:"#fff"}].map(({l,v,sub,c})=>(
                      <div key={l}><div style={{fontSize:10,fontWeight:700,letterSpacing:"1.2px",color:"rgba(255,255,255,0.45)",marginBottom:8}}>{l}</div><div style={{fontSize:18,fontWeight:700,color:c||"#fff",fontFamily:"'Lora', serif",lineHeight:1.2}}>{v}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.4)",marginTop:4}}>{sub}</div></div>
                    ))}
                  </div>
                  <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid rgba(255,255,255,0.1)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>0%</span><span style={{fontSize:11,color:"#6EE7B7",fontWeight:600}}>{fmtPct(latest.coverage,1)} of bills covered by dividends</span><span style={{fontSize:11,color:"rgba(255,255,255,0.4)"}}>100% = freedom</span></div>
                    <div style={{height:6,background:"rgba(255,255,255,0.1)",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.min(100,latest.coverage*100)}%`,background:"linear-gradient(90deg, #6EE7B7, #34D399)",borderRadius:3,transition:"width 0.5s"}}/></div>
                  </div>
                </Card>
              )}
              <Card>
                <SectionLabel>EQUITY % OVER TIME</SectionLabel>
                {computed.length<2?(<div style={{height:chartH,display:"flex",alignItems:"center",justifyContent:"center",color:T.textMuted}}>Log at least 2 months to see the chart</div>):(
                  <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} style={{overflow:"visible"}}>
                    <defs><linearGradient id="main-ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.blueMid} stopOpacity="0.12"/><stop offset="100%" stopColor={T.blueMid} stopOpacity="0.01"/></linearGradient></defs>
                    {[0.10,0.20,0.30,0.40,0.50,0.55,0.60,0.70,0.80,0.90,1.00].map(v=>{if(v<eqMin-0.01||v>eqMax+0.01)return null;const y=toY(v);const is60=v===0.60,is55=v===0.55;return<g key={v}><line x1={cPad.l} x2={cPad.l+ciW} y1={y} y2={y} stroke={is60?T.greenMid:is55?T.amberMid:T.borderLight} strokeWidth={1} strokeDasharray={(is60||is55)?"6,4":"0"} opacity={(is60||is55)?0.75:1}/><text x={cPad.l-8} y={y+4} textAnchor="end" fill={(is60||is55)?(is60?T.greenMid:T.amberMid):T.textMuted} fontSize="10" fontFamily="Nunito" fontWeight={(is60||is55)?"700":"400"}>{(v*100).toFixed(0)}%</text></g>;})}
                    {areaPath&&<path d={areaPath} fill="url(#main-ag)"/>}
                    {linePath&&<path d={linePath} fill="none" stroke={T.blueMid} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>}
                    {computed.map((e,i)=><circle key={i} cx={toX(i)} cy={toY(e.equity)} r="4.5" fill={eqColor(e.equity)} stroke={T.surface} strokeWidth="2.5"/>)}
                    {computed.map((e,i)=>{if(computed.length>8&&i%2!==0)return null;return<text key={i} x={toX(i)} y={cPad.t+ciH+18} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{fmtDate(e.date)}</text>;})}
                  </svg>
                )}
              </Card>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <Card>
                <SectionLabel>BILL ADDITION CONDITIONS</SectionLabel>
                <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:8,fontSize:12,color:T.textSub}}>Next bill:<input value={nextBill} onChange={e=>setNextBill(e.target.value)} style={{width:76,padding:"6px 10px",background:T.surfaceAlt,border:`1px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,fontWeight:700,color:T.text,fontFamily:"inherit",outline:"none",textAlign:"right"}}/><span>/mo</span></div>
                {[{pass:cond1,hd:computed.length>0,label:"Equity ≥ 60%",sub:latest?`Currently ${fmtPct(latest.equity)}`:"No data yet"},{pass:cond2,hd:computed.length>1,label:"Rising 2+ months",sub:risingStreak>=2?"Confirmed uptrend ✓":`${risingStreak} of 2 consecutive months`,badge:risingStreak>0?`↑ ${risingStreak}mo`:null},{pass:cond3,hd:computed.length>0,label:"3-month floor ≥ 55%",sub:latest?`Projected min: ${fmtPct(projectMinEquity(latest.gross,latest.margin,latest.effectiveDivs,latest.w2+nextBillAmt,latest.bills+nextBillAmt,settings.marginRate,effectiveYield,3))}`:"No data yet"}].map(({pass,hd,label,sub,badge})=>(
                  <div key={label} style={{display:"flex",gap:12,padding:"12px 14px",borderRadius:T.radiusSm,marginBottom:8,background:!hd?T.surfaceAlt:pass?T.greenBg:T.redBg,border:`1px solid ${!hd?T.border:pass?T.greenBorder:T.redBorder}`}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:!hd?T.textMuted:pass?T.greenMid:T.red,marginTop:4,flexShrink:0,boxShadow:pass?`0 0 8px ${T.greenMid}55`:"none"}}/>
                    <div style={{flex:1}}><div style={{fontSize:12,fontWeight:700,color:T.text,display:"flex",alignItems:"center",gap:8}}>{label}{badge&&<span style={{fontSize:10,fontWeight:700,padding:"1px 8px",borderRadius:20,background:T.amberBg,color:T.amber,border:`1px solid ${T.amberBorder}`}}>{badge}</span>}</div><div style={{fontSize:11,color:T.textSub,marginTop:2}}>{sub}</div></div>
                  </div>
                ))}
                {monthsToTrigger!==null&&monthsToTrigger>0&&!cond1&&(<div style={{padding:"10px 14px",background:T.blueBg,border:`1px solid ${T.blueBorder}`,borderRadius:T.radiusSm,fontSize:11,color:T.blue,fontWeight:600}}>📈 At current pace — trigger in ~{monthsToTrigger} month{monthsToTrigger!==1?"s":""}</div>)}
              </Card>
              {latest&&(
                <Card>
                  <SectionLabel>LATEST SNAPSHOT</SectionLabel>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[{l:"GROSS",v:fmt$(latest.gross),c:T.text},{l:"NET VALUE",v:fmt$(latest.gross-latest.margin),c:T.text},{l:"MARGIN DEBT",v:fmt$(latest.margin),c:T.red},{l:"EQUITY",v:fmtPct(latest.equity),c:eqColor(latest.equity)},{l:"DIVS / MO",v:fmt$(latest.effectiveDivs),c:T.green,badge:latest.actualDivs!==null?"ACTUAL":"EST"},{l:"COVERAGE",v:fmtPct(latest.coverage,1),c:latest.coverage>=1?T.green:T.amber},{l:"INTEREST / MO",v:fmt$(latest.effectiveInterest),c:T.red,badge:latest.actualInterest!==null?"ACTUAL":"EST"},{l:"NET DRAW",v:fmt$(latest.trueNetDraw),c:latest.trueNetDraw>0?T.red:T.green}].map(({l,v,c,badge})=><StatTile key={l} label={l} value={v} color={c} size={14} badge={badge} serif/>)}
                  </div>
                </Card>
              )}
              <Card style={{background:T.surfaceAlt}}>
                <SectionLabel>QUICK REFERENCE</SectionLabel>
                <div style={{fontSize:12,color:T.textSub,lineHeight:2}}>
                  {[["Trigger","60% equity",T.green],["Hard floor","55% equity",T.amber],["Streak","2 rising months",T.text],["Log cadence","1st of month",T.text]].map(([l,v,c])=>(<div key={l} style={{display:"flex",justifyContent:"space-between"}}><span style={{color:T.textMuted}}>{l}</span><span style={{fontWeight:700,color:c}}>{v}</span></div>))}
                  <div style={{marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                    <button onClick={()=>setActiveTab("holdings")} style={{background:"none",border:"none",color:T.indigo,fontSize:11,fontWeight:600,fontFamily:"inherit",padding:0,cursor:"pointer",display:"block",marginBottom:4}}>📊 View Holdings</button>
                    <button onClick={()=>setActiveTab("stress")} style={{background:"none",border:"none",color:T.rose,fontSize:11,fontWeight:600,fontFamily:"inherit",padding:0,cursor:"pointer",display:"block",marginBottom:4}}>🛡️ Run Stress Test</button>
                    <button onClick={()=>setActiveTab("help")} style={{background:"none",border:"none",color:T.blue,fontSize:11,fontWeight:600,fontFamily:"inherit",padding:0,cursor:"pointer"}}>→ Full instructions</button>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeTab==="modeler"&&<BillModelerTab latest={latest} settings={fullSettings}/>}
        {activeTab==="bills"&&<BillTrackerTab billItems={billItems} setBillItems={setBillItems} saveBills={saveBills} latest={latest} settings={fullSettings}/>}
        {activeTab==="holdings"&&<HoldingsTab holdingSnapshots={holdingSnapshots} setHoldingSnapshots={setHoldingSnapshots} saveHoldings={saveHoldings}/>}
        {activeTab==="dividends"&&<DividendsTab computed={computed}/>}
        {activeTab==="stress"&&<StressTestTab latest={latest} settings={fullSettings}/>}

        {activeTab==="metrics"&&(
          <div>{!latest?<Card><div style={{textAlign:"center",padding:48,color:T.textMuted}}>Log your first month to see metrics.</div></Card>:(
            <div style={{display:"flex",flexDirection:"column",gap:20}}>
              <Card>
                <SectionLabel>DIVIDEND SNOWBALL</SectionLabel>
                <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.min(computed.length,6)},1fr)`,gap:12}}>
                  {computed.slice(-6).map((e,i)=>(
                    <div key={i} style={{textAlign:"center",padding:"16px 12px",background:T.surfaceAlt,borderRadius:T.radiusSm,border:`1px solid ${T.borderLight}`}}>
                      <div style={{fontSize:11,color:T.textMuted,fontWeight:600,marginBottom:8,display:"flex",justifyContent:"center",gap:6,alignItems:"center"}}>{fmtDate(e.date)}<span style={{fontSize:9,fontWeight:700,padding:"1px 5px",borderRadius:20,background:e.actualDivs!==null?T.greenBg:T.amberBg,color:e.actualDivs!==null?T.green:T.amber,border:`1px solid ${e.actualDivs!==null?T.greenBorder:T.amberBorder}`}}>{e.actualDivs!==null?"ACTUAL":"EST"}</span></div>
                      <div style={{fontSize:18,fontWeight:700,color:T.green,fontFamily:"'Lora', serif"}}>{fmt$(e.effectiveDivs)}</div>
                      <div style={{fontSize:10,color:T.textMuted}}>per month</div>
                      {e.divGrowth!==null&&<div style={{fontSize:12,fontWeight:700,color:e.divGrowth>=0?T.green:T.red,marginTop:8}}>{e.divGrowth>=0?"+":""}{fmt$(e.divGrowth)}/mo</div>}
                      <div style={{fontSize:10,color:T.textMuted,marginTop:4}}>{fmt$(e.effectiveDivs*12)}/yr</div>
                    </div>
                  ))}
                </div>
              </Card>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:20}}>
                {[
                  {title:"PORTFOLIO YIELD",main:fmtPct(latest.actualYield,1),mainColor:latest.actualYield>=0.20?T.green:T.amber,sub:"blended annual yield",rows:[{l:"Target",v:fmtPct(effectiveYield,1),c:T.textSub},{l:"Actual",v:fmtPct(latest.actualYield,1),c:latest.actualYield>=effectiveYield*0.95?T.green:T.amber},{l:"Holdings yield",v:holdingsYield?fmtPct(holdingsYield,1):"—",c:T.indigo}]},
                  {title:"MARGIN EFFICIENCY",main:(effectiveYield/settings.marginRate).toFixed(2)+"x",mainColor:T.indigo,sub:"yield ÷ margin rate",rows:[{l:"Yield",v:fmtPct(effectiveYield,1),c:T.green},{l:"Rate",v:fmtPct(settings.marginRate,2),c:T.red},{l:"Net spread",v:"+"+fmtPct(effectiveYield-settings.marginRate,1),c:T.green}]},
                  {title:"EQUITY MOMENTUM",main:equityMomAvg!==null?(equityMomAvg>0?"+":"")+fmtPct(equityMomAvg,1)+"/mo":"—",mainColor:equityMomAvg!==null?(equityMomAvg>0?T.green:T.red):T.textMuted,sub:"3-month average",rows:[{l:"Status",v:cond1?"Above trigger ✓":monthsToTrigger?`~${monthsToTrigger}mo to trigger`:"Below trigger",c:cond1?T.green:T.amber}]},
                  {title:"MONTHLY INTEREST",main:fmt$(latest.effectiveInterest),mainColor:T.red,sub:latest.actualInterest!==null?"actual from statement":`est. at ${fmtPct(settings.marginRate,2)}`,rows:[{l:"Estimated",v:fmt$(latest.estimatedInterest),c:T.textSub},{l:"Actual",v:latest.actualInterest!==null?fmt$(latest.actualInterest):"Not logged",c:latest.actualInterest!==null?T.red:T.textMuted},{l:"Annual cost",v:fmt$(latest.effectiveInterest*12),c:T.red}]},
                  {title:"TRUE NET DRAW",main:fmt$(latest.trueNetDraw),mainColor:latest.trueNetDraw>0?T.red:T.green,sub:"bills + interest − dividends",rows:[{l:"Bills",v:"-"+fmt$(latest.bills),c:T.red},{l:"Interest",v:"-"+fmt$(latest.effectiveInterest),c:T.red},{l:"Dividends",v:"+"+fmt$(latest.effectiveDivs),c:T.green}]},
                  {title:"MILESTONES",main:fmt$(totalDivsReceived),mainColor:T.green,sub:"all-time dividends",rows:[{l:"Freedom Date",v:freedomDate||"—",c:T.indigo},{l:"Bills covered",v:fmtPct(latest.coverage,1),c:latest.coverage>=1?T.green:T.amber}]},
                ].map(({title,main,mainColor,sub,rows})=>(
                  <Card key={title}>
                    <SectionLabel>{title}</SectionLabel>
                    <div style={{fontSize:40,fontWeight:700,color:mainColor,fontFamily:"'Lora', serif",lineHeight:1}}>{main}</div>
                    <div style={{fontSize:11,color:T.textMuted,marginTop:4,marginBottom:14}}>{sub}</div>
                    {rows.map(({l,v,c})=>(<div key={l} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"6px 0",borderBottom:`1px solid ${T.borderLight}`}}><span style={{color:T.textMuted}}>{l}</span><span style={{fontWeight:700,color:c}}>{v}</span></div>))}
                  </Card>
                ))}
              </div>
            </div>
          )}</div>
        )}

        {activeTab==="log"&&(
          <Card className={pulse?"pulse":""}>
            <SectionLabel action={<button onClick={openAdd} style={{padding:"7px 18px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:12,fontWeight:700,fontFamily:"inherit"}}>+ Log Month</button>}>MONTHLY LOG — {entries.length} ENTRIES</SectionLabel>
            {computed.length===0?(<div style={{textAlign:"center",padding:48,color:T.textMuted}}>No entries yet.</div>):(
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr style={{borderBottom:`2px solid ${T.border}`}}>{["Date","Gross","Margin","Net","Equity","Divs/Mo","Div Type","Interest","Int Type","Net Draw","Coverage",""].map(h=><th key={h} style={{padding:"8px 10px",textAlign:"left",fontSize:10,fontWeight:700,letterSpacing:"1px",color:T.textMuted}}>{h}</th>)}</tr></thead>
                  <tbody>
                    {computed.map((e,i)=>(
                      <tr key={i} style={{borderBottom:`1px solid ${T.borderLight}`}} onMouseEnter={ev=>ev.currentTarget.style.background=T.surfaceAlt} onMouseLeave={ev=>ev.currentTarget.style.background="transparent"}>
                        <td style={{padding:"11px 10px",color:T.textSub,fontWeight:600,whiteSpace:"nowrap"}}>{fmtDate(e.date)}</td>
                        <td style={{padding:"11px 10px"}}>{fmt$(e.gross)}</td>
                        <td style={{padding:"11px 10px"}}>{fmt$(e.margin)}</td>
                        <td style={{padding:"11px 10px",fontWeight:600}}>{fmt$(e.gross-e.margin)}</td>
                        <td style={{padding:"11px 10px"}}><span style={{fontWeight:700,color:eqColor(e.equity)}}>{fmtPct(e.equity)}</span>{e.rising!==null&&<span style={{marginLeft:6,fontSize:10,fontWeight:700,color:e.rising?T.green:T.red}}>{e.rising?"▲":"▼"}</span>}</td>
                        <td style={{padding:"11px 10px",color:T.green,fontWeight:600}}>{fmt$(e.effectiveDivs)}{e.divGrowth!==null&&<span style={{fontSize:10,color:e.divGrowth>=0?T.green:T.red,marginLeft:4}}>{e.divGrowth>=0?"+":""}{fmt$(e.divGrowth)}</span>}</td>
                        <td style={{padding:"11px 10px"}}><span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:20,background:e.actualDivs!==null?T.greenBg:T.amberBg,color:e.actualDivs!==null?T.green:T.amber,border:`1px solid ${e.actualDivs!==null?T.greenBorder:T.amberBorder}`}}>{e.actualDivs!==null?"ACT":"EST"}</span></td>
                        <td style={{padding:"11px 10px",color:T.red,fontWeight:600}}>{fmt$(e.effectiveInterest)}</td>
                        <td style={{padding:"11px 10px"}}><span style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:20,background:e.actualInterest!==null?T.greenBg:T.amberBg,color:e.actualInterest!==null?T.green:T.amber,border:`1px solid ${e.actualInterest!==null?T.greenBorder:T.amberBorder}`}}>{e.actualInterest!==null?"ACT":"EST"}</span></td>
                        <td style={{padding:"11px 10px",color:e.trueNetDraw>0?T.red:T.green,fontWeight:600}}>{fmt$(e.trueNetDraw)}</td>
                        <td style={{padding:"11px 10px",color:e.coverage>=1?T.green:T.textSub}}>{fmtPct(e.coverage,1)}</td>
                        <td style={{padding:"11px 10px"}}><div style={{display:"flex",gap:6}}><button onClick={()=>openEdit(i)} style={{background:"none",border:`1px solid ${T.border}`,color:T.blue,borderRadius:T.radiusXs,padding:"3px 10px",fontSize:11,fontFamily:"inherit",cursor:"pointer"}}>Edit</button><button onClick={()=>handleDelete(i)} style={{background:"none",border:`1px solid ${T.border}`,color:T.textMuted,borderRadius:T.radiusXs,padding:"3px 10px",fontSize:11,fontFamily:"inherit",cursor:"pointer"}}>✕</button></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {activeTab==="settings"&&<SettingsTab settings={fullSettings} setSettings={setSettings} derivedYield={derivedYield} hasActualData={entries.some(e=>e.actualDivs!=null&&e.actualDivs!=="")} holdingsYield={holdingsYield} hasHoldings={holdingSnapshots.length>0}/>}
        {activeTab==="help"&&<HelpPage/>}
      </div>

      {/* Log / Edit Modal */}
      {showAdd&&(
        <div style={{position:"fixed",inset:0,background:"rgba(28,25,23,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:16,backdropFilter:"blur(4px)"}} onClick={()=>setShowAdd(false)}>
          <div style={{background:T.surface,borderRadius:T.radius,boxShadow:T.shadowHover,padding:32,width:480,maxWidth:"100%",maxHeight:"92vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:20,fontWeight:700,color:T.text,fontFamily:"'Lora', serif",marginBottom:4}}>{editIdx!==null?`Edit Entry — ${fmtDate(entries[editIdx].date)}`:"Log This Month"}</div>
            <div style={{fontSize:12,color:T.textMuted,marginBottom:20}}>{editIdx!==null?"Update any fields and save.":"Log on the 1st of each month for accurate streak tracking."}</div>

            {/* PDF upload — new entries only */}
            {editIdx===null&&(
              <div style={{marginBottom:20}}>
                <div style={{fontSize:11,fontWeight:700,color:T.textMuted,letterSpacing:"1px",marginBottom:8}}>AUTO-FILL FROM PDF</div>
                <input type="file" accept="application/pdf" ref={fileInputRef} style={{display:"none"}} onChange={e=>{if(e.target.files[0])handlePdfFile(e.target.files[0]);e.target.value="";}}/>
                <div className="pdf-drop" onClick={()=>fileInputRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files[0])handlePdfFile(e.dataTransfer.files[0]);}}>
                  {pdfLoading?(<div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"4px 0"}}><div style={{width:18,height:18,border:`2px solid ${T.border}`,borderTopColor:T.blueMid,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/><span style={{fontSize:12,color:T.textSub}}>Reading your statement…</span></div>):pdfStatus==="success"?(<div style={{fontSize:12,color:T.green,fontWeight:600}}>✓ Statement read — Gross, Margin, Dividends, Interest, and Month auto-filled. Verify before saving.</div>):pdfStatus&&pdfStatus.startsWith("error")?(<div style={{fontSize:12,color:T.red}}>⚠ {pdfStatus}</div>):(<div><div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>📄 Upload E-Trade Statement PDF</div><div style={{fontSize:11,color:T.textMuted}}>Extracts Gross, Margin, Dividends, Interest, and Month automatically</div></div>)}
                </div>
              </div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:14,marginBottom:16}}>
              <Input label="MONTH" type="month" value={form.date} onChange={e=>{setSaveError(null);setForm(f=>({...f,date:e.target.value}));}}/>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <Input label="GROSS PORTFOLIO / TOTAL ASSETS ($)" value={form.gross} onChange={e=>{setSaveError(null);setForm(f=>({...f,gross:e.target.value}));}} placeholder="e.g. 5,419.12"/>
                <Input label="MARGIN BALANCE ($)" value={form.margin} onChange={e=>{setSaveError(null);setForm(f=>({...f,margin:e.target.value}));}} placeholder="e.g. 1,654.71"/>
                <Input label="W2 DEPOSIT / MO ($)" value={form.w2} onChange={e=>{setSaveError(null);setForm(f=>({...f,w2:e.target.value}));}} placeholder="e.g. 871"/>
                <div>
                  <div style={{fontSize:11,fontWeight:600,color:T.textMuted,marginBottom:5}}>BILLS FLOATED / MO ($)</div>
                  <input value={form.bills} onChange={e=>{setSaveError(null);setForm(f=>({...f,bills:e.target.value}));}} placeholder="e.g. 801" style={{width:"100%",padding:"10px 13px",background:T.surfaceAlt,border:`1.5px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,color:T.text,fontFamily:"inherit",outline:"none"}}/>
                  {floatedBillsTotal>0&&editIdx===null&&(<div style={{marginTop:4,fontSize:10,color:T.green,cursor:"pointer"}} onClick={()=>setForm(f=>({...f,bills:String(floatedBillsTotal)}))}>↑ Use Bill Tracker total: {fmt$(floatedBillsTotal,0)}/mo</div>)}
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <Input label="ACTUAL DIVIDENDS RECEIVED ($)" hint="optional" value={form.actualDivs} onChange={e=>{setSaveError(null);setForm(f=>({...f,actualDivs:e.target.value}));}} placeholder="e.g. 77.34" accent/>
                <Input label="ACTUAL MARGIN INTEREST ($)" hint="optional" value={form.actualInterest} onChange={e=>{setSaveError(null);setForm(f=>({...f,actualInterest:e.target.value}));}} placeholder="e.g. 15.25"/>
              </div>
            </div>
            <div style={{background:T.surfaceAlt,border:`1px solid ${T.border}`,borderRadius:T.radiusSm,padding:"12px 14px",marginBottom:20,fontSize:11,color:T.textMuted,lineHeight:1.7}}>
              <strong style={{color:T.text}}>Gross = Total Assets</strong> (Balance Sheet) &nbsp;·&nbsp; <strong style={{color:T.green}}>Dividends</strong> = Income and Distribution Summary &nbsp;·&nbsp; <strong style={{color:T.red}}>Interest</strong> = Margin Loan Interest Schedule → Total
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={handleSave} style={{flex:1,padding:"12px",background:T.text,color:"#fff",border:"none",borderRadius:T.radiusXs,fontSize:13,fontWeight:700,fontFamily:"inherit",cursor:"pointer"}}>{editIdx!==null?"Save Changes":"Save Entry"}</button>
              <button onClick={()=>setShowAdd(false)} style={{padding:"12px 20px",background:"transparent",color:T.textSub,border:`1px solid ${T.border}`,borderRadius:T.radiusXs,fontSize:13,fontFamily:"inherit",cursor:"pointer"}}>Cancel</button>
            </div>
            {saveError&&(<div style={{marginTop:10,padding:"10px 14px",background:T.redBg,border:`1px solid ${T.redBorder}`,borderRadius:T.radiusXs,fontSize:12,color:T.red,fontWeight:600}}>⚠ {saveError}</div>)}
          </div>
        </div>
      )}

      {showQC&&<QuickCheckModal onClose={()=>setShowQC(false)} latest={latest} settings={fullSettings}/>}
    </div>
  );
}
