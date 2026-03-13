import { useState, useEffect, useCallback, useMemo } from "react";

const STORAGE_KEY = "p2p-equity-tracker-v1";
const SETTINGS_KEY = "p2p-settings-v1";
const BILLS_KEY = "p2p-bills-v1";

const DEFAULT_SETTINGS = { marginRate: 0.0844, targetYield: 0.23, yieldMode: "manual" };

const parseNum = (s) => { const n = parseFloat(String(s).replace(/,/g, "")); return isNaN(n) ? 0 : n; };
const fmt$ = (v, dec = 2) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtPct = (v, dec = 2) => (v * 100).toFixed(dec) + "%";

// ─── MATH ────────────────────────────────────────────────────────────────────

function projectCurve(gross, margin, divs, w2, bills, marginRate, yield_, months, annualAppreciation = 0) {
  let g = gross, m = margin, d = divs;
  const ma = annualAppreciation / 12;
  const pts = [{ month: 0, equity: (g - m) / g, divs: d, margin: m, gross: g, net: g - m }];
  for (let i = 1; i <= months; i++) {
    const draw = Math.max(0, bills - d);
    g += w2; g *= (1 + ma);
    m += draw + m * marginRate / 12; m = Math.max(0, m);
    d = g * yield_ / 12;
    pts.push({ month: i, equity: (g - m) / g, divs: d, margin: m, gross: g, net: g - m });
  }
  return pts;
}

function projectMinEquity(gross, margin, divs, w2, bills, marginRate, yield_, months, appreciation = 0) {
  return Math.min(...projectCurve(gross, margin, divs, w2, bills, marginRate, yield_, months, appreciation).map(p => p.equity));
}

function projectFreedomMonths(gross, margin, divs, w2, bills, marginRate, yield_, appreciation = 0) {
  let g = gross, m = margin, d = divs;
  const ma = appreciation / 12;
  for (let i = 1; i <= 600; i++) {
    const draw = Math.max(0, bills - d);
    g += w2; g *= (1 + ma);
    m += draw + m * marginRate / 12; m = Math.max(0, m);
    d = g * yield_ / 12;
    if (d >= bills) return i;
  }
  return null;
}

function getFreedomDate(monthsFromNow) {
  if (!monthsFromNow) return null;
  const d = new Date(); d.setMonth(d.getMonth() + monthsFromNow);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function findMaxSafeBill(gross, margin, divs, w2, bills, marginRate, yield_, appreciation = 0) {
  let lo = 0, hi = 15000;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    if (projectMinEquity(gross, margin, divs, w2 + mid, bills + mid, marginRate, yield_, 3, appreciation) >= 0.55) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / 5) * 5;
}

function getDaysUntilNextLog(entries) {
  if (!entries.length) return null;
  const [yr, mo] = entries[entries.length - 1].date.split("-").map(Number);
  return Math.ceil((new Date(yr, mo, 1) - new Date()) / 864e5);
}

function criticalDropPct(gross, margin, targetEquity) {
  if (!margin || margin <= 0) return Infinity;
  const threshold = margin / (1 - targetEquity);
  if (threshold >= gross) return 0;
  return ((gross - threshold) / gross) * 100;
}

function calcRecoveryMonths(postCrashGross, margin, divs, w2, bills, marginRate, yield_, targetEquity) {
  let g = postCrashGross, m = margin, d = divs;
  for (let i = 1; i <= 120; i++) {
    const draw = Math.max(0, bills - d);
    g += w2; m += draw + m * marginRate / 12; m = Math.max(0, m);
    d = g * yield_ / 12;
    if ((g - m) / g >= targetEquity) return i;
  }
  return null;
}

// ─── DESIGN TOKENS ───────────────────────────────────────────────────────────

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

// ─── SHARED COMPONENTS ───────────────────────────────────────────────────────

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

// ─── MODELER CHART — fully dynamic Y axis, no clipping ────────────────────────

function ModelerChart({ scenarios, months = 36, growthScenarios = [] }) {
  const W = 700, H = 200, pad = { t: 16, r: 64, b: 32, l: 48 };
  const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;

  const allCurves = [...scenarios.map(s => s.curve), ...growthScenarios.map(s => s.curve)];
  const allEqs = allCurves.flatMap(c => (c || []).map(p => p.equity));
  if (!allEqs.length) return null;

  // Fully fluid — no hardcoded floor/ceiling, just fit the data
  const rawMin = Math.min(...allEqs);
  const rawMax = Math.max(...allEqs);
  const spread = Math.max(rawMax - rawMin, 0.08);
  const eMin = Math.max(0, rawMin - spread * 0.12);
  const eMax = Math.min(1.05, rawMax + spread * 0.12);
  const eSpan = Math.max(eMax - eMin, 0.05);

  const toX = (m) => pad.l + (m / months) * iW;
  const toY = (eq) => pad.t + iH - ((eq - eMin) / eSpan) * iH;

  const COLORS = [T.greenMid, T.blueMid, T.amberMid];
  const GCOLORS = ["#059669", "#1D4ED8", "#92400E"];

  // Smart grid: pick clean 10% intervals that fall within range
  const ALL_GRIDS = [0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95,1.00];
  const gridLines = ALL_GRIDS.filter(v => v >= eMin - 0.01 && v <= eMax + 0.01);
  const xTicks = [0, 6, 12, 18, 24, 30, 36].filter(m => m <= months);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      <defs>
        {COLORS.map((c, i) => (
          <linearGradient key={i} id={`mc-area-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={c} stopOpacity="0.12" />
            <stop offset="100%" stopColor={c} stopOpacity="0.01" />
          </linearGradient>
        ))}
      </defs>
      {/* Grid lines */}
      {gridLines.map(v => {
        const y = toY(v);
        const is60 = v === 0.60, is55 = v === 0.55;
        const isThreshold = is60 || is55;
        return <g key={v}>
          <line x1={pad.l} x2={pad.l + iW} y1={y} y2={y}
            stroke={is60 ? T.greenMid : is55 ? T.amberMid : T.borderLight}
            strokeWidth={isThreshold ? 1.2 : 1}
            strokeDasharray={isThreshold ? "5,4" : "0"}
            opacity={isThreshold ? 0.85 : 1} />
          <text x={pad.l - 8} y={y + 4} textAnchor="end" fill={isThreshold ? (is60 ? T.greenMid : T.amberMid) : T.textMuted} fontSize="9" fontFamily="Nunito" fontWeight={isThreshold ? "700" : "400"}>{(v * 100).toFixed(0)}%</text>
          {isThreshold && <text x={pad.l + iW + 6} y={y + 4} fill={is60 ? T.greenMid : T.amberMid} fontSize="8" fontFamily="Nunito" fontWeight="700">{is60 ? "60%" : "55%"}</text>}
        </g>;
      })}
      {/* X axis labels */}
      {xTicks.map(m => (
        <text key={m} x={toX(m)} y={pad.t + iH + 18} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">
          {m === 0 ? "Now" : `${m}mo`}
        </text>
      ))}
      {/* Base scenario curves */}
      {scenarios.map((s, si) => {
        if (!s.curve || s.curve.length < 2) return null;
        const path = "M" + s.curve.map((p, i) => `${toX(i)},${toY(p.equity)}`).join(" L");
        const areaPath = path + ` L${toX(s.curve.length - 1)},${pad.t + iH} L${toX(0)},${pad.t + iH} Z`;
        return <g key={`b${si}`}>
          <path d={areaPath} fill={`url(#mc-area-${si})`} />
          <path d={path} fill="none" stroke={COLORS[si]} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {[0, 12, 24, 36].filter(m => m < s.curve.length).map(m => (
            <circle key={m} cx={toX(m)} cy={toY(s.curve[m].equity)} r="4" fill={COLORS[si]} stroke={T.surface} strokeWidth="2" />
          ))}
        </g>;
      })}
      {/* Growth overlay curves (dashed) */}
      {growthScenarios.map((s, si) => {
        if (!s.curve || s.curve.length < 2) return null;
        const path = "M" + s.curve.map((p, i) => `${toX(i)},${toY(p.equity)}`).join(" L");
        return <g key={`g${si}`}>
          <path d={path} fill="none" stroke={GCOLORS[si]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="7,4" />
          {[0, 12, 24, 36].filter(m => m < s.curve.length).map(m => (
            <circle key={m} cx={toX(m)} cy={toY(s.curve[m].equity)} r="3.5" fill={GCOLORS[si]} stroke={T.surface} strokeWidth="2" />
          ))}
        </g>;
      })}
    </svg>
  );
}

// ─── BILL MODELER TAB ─────────────────────────────────────────────────────────

function BillModelerTab({ latest, settings }) {
  const [amounts, setAmounts] = useState(["200", "500", "1000"]);
  const [labels, setLabels] = useState(["Conservative", "Moderate", "Aggressive"]);
  const [growthMode, setGrowthMode] = useState(false);
  const [appreciationRateStr, setAppreciationRateStr] = useState("7.0");
  const COLORS = [T.greenMid, T.blueMid, T.amberMid];
  const GCOLORS = ["#059669", "#1D4ED8", "#92400E"];
  const MONTHS = 36;
  const appreciationRate = parseNum(appreciationRateStr) / 100;

  const maxSafeBase = latest ? findMaxSafeBill(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, 0) : 0;
  const maxSafeGrowth = latest ? findMaxSafeBill(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, appreciationRate) : 0;

  const scenarios = useMemo(() => {
    if (!latest) return [];
    return amounts.map((amtStr, i) => {
      const amt = parseNum(amtStr) || 0;
      const curve = projectCurve(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + amt, latest.bills + amt, settings.marginRate, settings.effectiveYield, MONTHS, 0);
      const floorEq = Math.min(...curve.map(p => p.equity));
      const floorMonth = curve.findIndex(p => p.equity === floorEq);
      const monthsBelowTrigger = curve.filter(p => p.equity < 0.60).length;
      const freedomMo = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + amt, latest.bills + amt, settings.marginRate, settings.effectiveYield, 0);
      const currentFreedom = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, 0);
      return { amt, label: labels[i], curve, floorEq, floorMonth, monthsBelowTrigger, freedomMo, freedomDate: getFreedomDate(freedomMo), freedomDelta: freedomMo && currentFreedom ? freedomMo - currentFreedom : null, safe: floorEq >= 0.55, color: COLORS[i] };
    });
  }, [amounts, labels, latest, settings]);

  const growthScenarios = useMemo(() => {
    if (!latest || !growthMode) return [];
    return amounts.map((amtStr, i) => {
      const amt = parseNum(amtStr) || 0;
      const curve = projectCurve(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + amt, latest.bills + amt, settings.marginRate, settings.effectiveYield, MONTHS, appreciationRate);
      const floorEq = Math.min(...curve.map(p => p.equity));
      const floorMonth = curve.findIndex(p => p.equity === floorEq);
      const monthsBelowTrigger = curve.filter(p => p.equity < 0.60).length;
      const freedomMo = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + amt, latest.bills + amt, settings.marginRate, settings.effectiveYield, appreciationRate);
      const currentFreedom = projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, settings.effectiveYield, appreciationRate);
      return { amt, label: labels[i], curve, floorEq, floorMonth, monthsBelowTrigger, freedomMo, freedomDate: getFreedomDate(freedomMo), freedomDelta: freedomMo && currentFreedom ? freedomMo - currentFreedom : null, safe: floorEq >= 0.55 };
    });
  }, [amounts, labels, latest, settings, growthMode, appreciationRate]);

  if (!latest) return <Card><div style={{ textAlign: "center", padding: 40, color: T.textMuted }}>Log at least one month to use the Bill Modeler.</div></Card>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Dual max safe banners */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: T.greenBg, border: `1px solid ${T.greenBorder}`, borderRadius: T.radius, padding: "18px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.5px", color: T.green, marginBottom: 4 }}>MAX SAFE BILL — DEPOSITS + DIVIDENDS ONLY</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: T.green, fontFamily: "'Lora', serif" }}>{fmt$(maxSafeBase, 0)}</div>
            <div style={{ fontSize: 13, color: T.textMuted }}>/mo</div>
          </div>
          <div style={{ fontSize: 11, color: T.textSub, marginTop: 4 }}>Conservative baseline — no price appreciation assumed</div>
        </div>
        <div style={{ background: T.violetBg, border: `1px solid ${T.violetBorder}`, borderRadius: T.radius, padding: "18px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.5px", color: T.violet, marginBottom: 4 }}>MAX SAFE BILL — WITH {fmtPct(appreciationRate, 0)} MARKET APPRECIATION</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: T.violet, fontFamily: "'Lora', serif" }}>{fmt$(maxSafeGrowth, 0)}</div>
            <div style={{ fontSize: 13, color: T.textMuted }}>/mo</div>
          </div>
          <div style={{ fontSize: 11, color: T.textSub, marginTop: 4 }}>
            {maxSafeGrowth > maxSafeBase ? `Market growth adds ${fmt$(maxSafeGrowth - maxSafeBase, 0)}/mo of additional headroom` : "Same headroom as baseline at current equity"}
          </div>
        </div>
      </div>

      {/* Starting state */}
      <Card style={{ padding: "16px 24px" }}>
        <SectionLabel>STARTING STATE — FROM LATEST LOG</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {[{ l: "Gross", v: fmt$(latest.gross) }, { l: "Margin", v: fmt$(latest.margin) }, { l: "Equity", v: fmtPct(latest.equity), c: latest.equity >= 0.60 ? T.green : T.amber }, { l: "Bills/Mo", v: fmt$(latest.bills) }, { l: "Dividends/Mo", v: fmt$(latest.effectiveDivs), c: T.green }].map(({ l, v, c }) => (
            <div key={l} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, letterSpacing: "1px", marginBottom: 4 }}>{l}</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: c || T.text }}>{v}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Scenario inputs */}
      <Card>
        <SectionLabel>CONFIGURE SCENARIOS</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
          {scenarios.map((s, i) => (
            <div key={i} style={{ borderRadius: T.radiusSm, padding: "16px", background: T.surfaceAlt, border: `1.5px solid ${s.safe ? T.border : T.redBorder}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i] }} />
                <div style={{ fontSize: 12, fontWeight: 700, color: COLORS[i] }}>Scenario {i + 1}</div>
                <Badge color={s.safe ? T.green : T.red} bg={s.safe ? T.greenBg : T.redBg} border={s.safe ? T.greenBorder : T.redBorder}>{s.safe ? "SAFE" : "UNSAFE"}</Badge>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>BILL AMOUNT TO ADD</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: T.textMuted }}>$</span>
                    <input value={amounts[i]} onChange={e => setAmounts(a => { const n = [...a]; n[i] = e.target.value; return n; })} placeholder="e.g. 500"
                      style={{ flex: 1, padding: "8px 10px", background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 16, fontWeight: 700, color: COLORS[i], fontFamily: "'Lora', serif", outline: "none" }} />
                    <span style={{ color: T.textMuted, fontSize: 12 }}>/mo</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, marginBottom: 4 }}>LABEL</div>
                  <input value={labels[i]} onChange={e => setLabels(l => { const n = [...l]; n[i] = e.target.value; return n; })} placeholder="Label"
                    style={{ width: "100%", padding: "7px 10px", background: T.surface, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 12, color: T.text, fontFamily: "inherit", outline: "none" }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Chart */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", color: T.textMuted }}>36-MONTH EQUITY PROJECTION</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Pill active={!growthMode} onClick={() => setGrowthMode(false)}>Deposits + Dividends</Pill>
            <Pill active={growthMode} onClick={() => setGrowthMode(true)} color={T.violet}>+ Market Growth</Pill>
            {growthMode && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.violetBg, border: `1px solid ${T.violetBorder}`, borderRadius: 20, padding: "4px 14px" }}>
                <span style={{ fontSize: 11, color: T.violet, fontWeight: 600 }}>Appreciation:</span>
                <input value={appreciationRateStr} onChange={e => setAppreciationRateStr(e.target.value)}
                  style={{ width: 40, padding: "2px 4px", background: "transparent", border: "none", fontSize: 13, fontWeight: 700, color: T.violet, fontFamily: "'Lora', serif", outline: "none", textAlign: "right" }} />
                <span style={{ fontSize: 11, color: T.violet, fontWeight: 600 }}>%/yr</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
          {scenarios.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 20, height: 2.5, background: COLORS[i], borderRadius: 2 }} />
              <span style={{ fontSize: 11, color: T.textSub, fontWeight: 600 }}>{s.label}</span>
            </div>
          ))}
          {growthMode && scenarios.map((_, i) => (
            <div key={`g${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={GCOLORS[i]} strokeWidth="2" strokeDasharray="5,3" /></svg>
              <span style={{ fontSize: 11, color: T.violet, fontWeight: 600 }}>{labels[i]}+G</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke={T.greenMid} strokeWidth="1.5" strokeDasharray="4,3" /></svg>
            <span style={{ fontSize: 11, color: T.textMuted }}>60%</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke={T.amberMid} strokeWidth="1.5" strokeDasharray="4,3" /></svg>
            <span style={{ fontSize: 11, color: T.textMuted }}>55%</span>
          </div>
        </div>
        <ModelerChart scenarios={scenarios} months={MONTHS} growthScenarios={growthMode ? growthScenarios : []} />
        {growthMode && (
          <div style={{ marginTop: 14, padding: "12px 16px", background: T.violetBg, border: `1px solid ${T.violetBorder}`, borderRadius: T.radiusSm, fontSize: 12, color: T.violet, lineHeight: 1.7 }}>
            <strong>Solid lines</strong> = deposits + dividend compounding only. <strong>Dashed lines</strong> = same with {fmtPct(appreciationRate, 0)}/yr price appreciation on top. The gap between each pair is pure market tailwind.
          </div>
        )}
      </Card>

      {/* Growth impact cards */}
      {growthMode && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {scenarios.map((s, i) => {
            const gs = growthScenarios[i]; if (!gs) return null;
            const b36 = s.curve[36], g36 = gs.curve[36];
            return (
              <Card key={i} style={{ background: T.violetBg, border: `1px solid ${T.violetBorder}`, boxShadow: "none" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.violet, marginBottom: 14 }}>{s.label} — Growth Impact at 36mo</div>
                {[{ l: "Portfolio", b: fmt$(b36?.gross || 0), g: fmt$(g36?.gross || 0) }, { l: "Net Value", b: fmt$(b36?.net || 0), g: fmt$(g36?.net || 0) }, { l: "Monthly Divs", b: fmt$(b36?.divs || 0), g: fmt$(g36?.divs || 0) }, { l: "Equity %", b: fmtPct(b36?.equity || 0), g: fmtPct(g36?.equity || 0) }, { l: "Freedom Date", b: s.freedomDate || ">50yr", g: gs.freedomDate || ">50yr" }].map(({ l, b, g }) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${T.violetBorder}` }}>
                    <span style={{ fontSize: 11, color: T.textMuted }}>{l}</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                      <span style={{ color: T.textSub, fontWeight: 600 }}>{b}</span>
                      <span style={{ color: T.textMuted, fontSize: 10 }}>→</span>
                      <span style={{ color: T.violet, fontWeight: 700 }}>{g}</span>
                    </div>
                  </div>
                ))}
              </Card>
            );
          })}
        </div>
      )}

      {/* Per-scenario detail cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
        {scenarios.map((s, i) => {
          const gs = growthMode ? growthScenarios[i] : null;
          return (
            <Card key={i} style={{ borderTop: `3px solid ${COLORS[i]}` }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS[i], marginBottom: 16, fontFamily: "'Lora', serif" }}>{s.label} — {fmt$(s.amt, 0)}/mo</div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {[
                  { l: "Floor Equity", bv: fmtPct(s.floorEq), gv: gs ? fmtPct(gs.floorEq) : null, bc: s.floorEq >= 0.60 ? T.green : s.floorEq >= 0.55 ? T.amber : T.red, gc: gs ? (gs.floorEq >= 0.60 ? T.green : gs.floorEq >= 0.55 ? T.amber : T.red) : null, big: true },
                  { l: "Floor at month", bv: String(s.floorMonth), gv: gs ? String(gs.floorMonth) : null, bc: T.textSub },
                  { l: "Months below 60%", bv: `${s.monthsBelowTrigger}/36`, gv: gs ? `${gs.monthsBelowTrigger}/36` : null, bc: s.monthsBelowTrigger > 12 ? T.red : s.monthsBelowTrigger > 0 ? T.amber : T.green },
                  { l: "Freedom Date", bv: s.freedomDate || ">50yr", gv: gs ? (gs.freedomDate || ">50yr") : null, bc: T.indigo, gc: T.violet },
                  { l: "Freedom Δ vs now", bv: s.freedomDelta !== null ? (s.freedomDelta > 0 ? `+${s.freedomDelta}mo later` : `${Math.abs(s.freedomDelta)}mo sooner`) : "—", gv: null, bc: s.freedomDelta > 0 ? T.amber : T.green },
                  { l: "Divs at mo 36", bv: fmt$(s.curve[36]?.divs || 0), gv: gs ? fmt$(gs.curve[36]?.divs || 0) : null, bc: T.green, gc: T.violet },
                  { l: "Portfolio at mo 36", bv: fmt$(s.curve[36]?.gross || 0), gv: gs ? fmt$(gs.curve[36]?.gross || 0) : null, bc: T.text, gc: T.violet },
                  { l: "Safe to add?", bv: s.safe ? "Yes ✓" : "No — floor < 55%", gv: null, bc: s.safe ? T.green : T.red },
                ].map(({ l, bv, gv, bc, gc, big }) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${T.borderLight}` }}>
                    <span style={{ fontSize: 11, color: T.textMuted }}>{l}</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: big ? 15 : 12, fontWeight: big ? 700 : 600, color: bc, fontFamily: big ? "'Lora', serif" : "inherit" }}>{bv}</span>
                      {growthMode && gv && (
                        <><span style={{ fontSize: 10, color: T.textMuted }}>→</span>
                          <span style={{ fontSize: big ? 14 : 11, fontWeight: big ? 700 : 600, color: gc || T.violet, fontFamily: big ? "'Lora', serif" : "inherit" }}>{gv}</span></>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── BILL TRACKER TAB ─────────────────────────────────────────────────────────

function BillTrackerTab({ billItems, setBillItems, saveBills, latest, settings }) {
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name: "", amount: "", category: "other", notes: "" });

  const floated = billItems.filter(b => b.isFloated);
  const notFloated = billItems.filter(b => !b.isFloated);
  const totalFloated = floated.reduce((s, b) => s + b.amount, 0);
  const totalAll = billItems.reduce((s, b) => s + b.amount, 0);
  const coveragePct = totalAll > 0 ? totalFloated / totalAll : 0;
  const nextCandidate = notFloated.length ? [...notFloated].sort((a, b) => b.amount - a.amount)[0] : null;

  const nextCandidateImpact = nextCandidate && latest ? (() => {
    const amt = nextCandidate.amount;
    const minEq = projectMinEquity(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + amt, latest.bills + amt, settings.marginRate, settings.effectiveYield, 3);
    return { minEq, safe: minEq >= 0.55 };
  })() : null;

  const toggleFloat = (id) => {
    const updated = billItems.map(b => b.id === id ? { ...b, isFloated: !b.isFloated, dateAdded: !b.isFloated ? new Date().toISOString().slice(0, 7) : null } : b);
    setBillItems(updated); saveBills(updated);
  };
  const deleteBill = (id) => { const u = billItems.filter(b => b.id !== id); setBillItems(u); saveBills(u); };
  const openEdit = (bill) => { setEditId(bill.id); setForm({ name: bill.name, amount: String(bill.amount), category: bill.category, notes: bill.notes || "" }); setShowForm(true); };
  const openAdd = () => { setEditId(null); setForm({ name: "", amount: "", category: "other", notes: "" }); setShowForm(true); };
  const submitForm = () => {
    if (!form.name || !form.amount) return;
    const amt = parseNum(form.amount);
    if (editId) {
      const u = billItems.map(b => b.id === editId ? { ...b, name: form.name, amount: amt, category: form.category, notes: form.notes } : b);
      setBillItems(u); saveBills(u);
    } else {
      const u = [...billItems, { id: Date.now().toString(), name: form.name, amount: amt, category: form.category, isFloated: false, dateAdded: null, notes: form.notes }];
      setBillItems(u); saveBills(u);
    }
    setShowForm(false); setEditId(null);
  };

  const BillRow = ({ bill }) => {
    const cat = CATS[bill.category] || CATS.other;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", borderRadius: T.radiusSm, background: bill.isFloated ? T.greenBg : T.surface, border: `1px solid ${bill.isFloated ? T.greenBorder : T.border}`, marginBottom: 8, transition: "all 0.2s" }}>
        <div style={{ fontSize: 20, flexShrink: 0 }}>{cat.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{bill.name}</span>
            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: cat.bg, color: cat.color, border: `1px solid ${cat.border}` }}>{cat.label}</span>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: bill.isFloated ? T.green : T.text, fontFamily: "'Lora', serif" }}>{fmt$(bill.amount, 0)}<span style={{ fontSize: 11, fontWeight: 500, color: T.textMuted }}>/mo</span></span>
            {bill.isFloated && bill.dateAdded && <span style={{ fontSize: 11, color: T.green }}>✓ Routing since {new Date(bill.dateAdded + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span>}
            {bill.notes && <span style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>{bill.notes}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button onClick={() => openEdit(bill)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: T.radiusXs, padding: "4px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>Edit</button>
          <button onClick={() => toggleFloat(bill.id)} style={{ background: bill.isFloated ? T.greenBg : T.text, color: bill.isFloated ? T.green : "#fff", border: `1px solid ${bill.isFloated ? T.greenBorder : T.text}`, borderRadius: T.radiusXs, padding: "6px 14px", fontSize: 12, fontWeight: 700, fontFamily: "inherit", transition: "all 0.18s", minWidth: 110, cursor: "pointer" }}>
            {bill.isFloated ? "✓ Routing" : "+ Route It"}
          </button>
          <button onClick={() => deleteBill(bill.id)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: T.radiusXs, padding: "4px 8px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>✕</button>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
      {/* Hero stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
        {[
          { l: "Total Bills Tracked", v: fmt$(totalAll, 0) + "/mo", sub: `${billItems.length} bills`, c: T.text },
          { l: "Currently Routing", v: fmt$(totalFloated, 0) + "/mo", sub: `${floated.length} of ${billItems.length} bills`, c: T.green },
          { l: "Still at Bank", v: fmt$(totalAll - totalFloated, 0) + "/mo", sub: `${notFloated.length} bills remaining`, c: T.amber },
          { l: "Routing Progress", v: fmtPct(coveragePct, 0), sub: "of total bills floated", c: coveragePct >= 1 ? T.green : coveragePct > 0.5 ? T.amber : T.red },
        ].map(({ l, v, sub, c }) => (
          <Card key={l} style={{ padding: "16px 18px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", color: T.textMuted, marginBottom: 8 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>{sub}</div>
          </Card>
        ))}
      </div>

      {/* Progress bar with bill chips */}
      {billItems.length > 0 && (
        <Card style={{ padding: "16px 24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: T.textMuted }}>$0</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.green }}>{fmt$(totalFloated, 0)} routing · {fmt$(totalAll - totalFloated, 0)} remaining</span>
            <span style={{ fontSize: 11, color: T.textMuted }}>{fmt$(totalAll, 0)} total</span>
          </div>
          <div style={{ height: 10, background: T.borderLight, borderRadius: 5, overflow: "hidden", position: "relative" }}>
            <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, coveragePct * 100)}%`, background: `linear-gradient(90deg, ${T.greenMid}, #34D399)`, borderRadius: 5, transition: "width 0.5s" }} />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            {floated.map(b => {
              const cat = CATS[b.category] || CATS.other;
              return (
                <div key={b.id} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: cat.bg, color: cat.color, border: `1px solid ${cat.border}` }}>
                  {cat.icon} {b.name} — {fmt$(b.amount, 0)}/mo
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Next candidate callout */}
      {nextCandidate && (
        <div style={{ background: nextCandidateImpact?.safe ? T.amberBg : T.redBg, border: `1px solid ${nextCandidateImpact?.safe ? T.amberBorder : T.redBorder}`, borderRadius: T.radius, padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", color: nextCandidateImpact?.safe ? T.amber : T.red, marginBottom: 4 }}>
              {(CATS[nextCandidate.category] || CATS.other).icon} HIGHEST-LEVERAGE NEXT BILL TO ADD
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: "'Lora', serif" }}>{nextCandidate.name}</div>
            <div style={{ fontSize: 12, color: T.textSub, marginTop: 2 }}>
              {fmt$(nextCandidate.amount, 0)}/mo — {nextCandidateImpact
                ? (nextCandidateImpact.safe
                  ? `3-month projected floor: ${fmtPct(nextCandidateImpact.minEq)} ✓ safe when conditions are met`
                  : `3-month projected floor: ${fmtPct(nextCandidateImpact.minEq)} — below 55% floor, not yet safe`)
                : "Log a month first to see safety analysis"}
            </div>
          </div>
          <button onClick={() => toggleFloat(nextCandidate.id)} style={{ padding: "10px 20px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>
            Mark as Routing
          </button>
        </div>
      )}

      {/* Bill list */}
      <Card>
        <SectionLabel action={<button onClick={openAdd} style={{ padding: "7px 18px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 12, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>+ Add Bill</button>}>
          BILL ROSTER — {billItems.length} BILLS TRACKED
        </SectionLabel>

        {billItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: T.textMuted }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.textSub, marginBottom: 8 }}>No bills tracked yet</div>
            <div style={{ fontSize: 12, color: T.textMuted, maxWidth: 380, margin: "0 auto", lineHeight: 1.7 }}>Add every recurring bill — mortgage, car payment, insurance, subscriptions, everything. Whether it's routing through the brokerage or not yet, track it all here.</div>
            <button onClick={openAdd} style={{ marginTop: 16, padding: "10px 24px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>Add Your First Bill</button>
          </div>
        ) : (
          <div>
            {floated.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.green, letterSpacing: "1.5px", marginBottom: 10 }}>
                  ✓ ROUTING THROUGH BROKERAGE <span style={{ fontWeight: 400, color: T.textMuted }}>— {fmt$(totalFloated, 0)}/mo</span>
                </div>
                {floated.map(b => <BillRow key={b.id} bill={b} />)}
              </div>
            )}
            {notFloated.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, letterSpacing: "1.5px", marginBottom: 10 }}>
                  ○ STILL AT BANK <span style={{ fontWeight: 400 }}>— {fmt$(totalAll - totalFloated, 0)}/mo remaining</span>
                </div>
                {[...notFloated].sort((a, b) => b.amount - a.amount).map(b => <BillRow key={b.id} bill={b} />)}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* How it works */}
      <Card style={{ background: T.surfaceAlt, boxShadow: "none", border: `1px solid ${T.border}` }}>
        <SectionLabel>HOW THE BILL TRACKER WORKS WITH THE SYSTEM</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, fontSize: 12, color: T.textSub, lineHeight: 1.8 }}>
          <div><strong style={{ color: T.text }}>1. Track everything.</strong> Add every recurring bill regardless of whether it's routing yet. This becomes your master list — no more tracking it in your head.</div>
          <div><strong style={{ color: T.text }}>2. Mark as routing.</strong> When the 3 conditions fire and you redirect a bill, toggle it here. Date is logged automatically. The floated total feeds your log form suggestion.</div>
          <div><strong style={{ color: T.text }}>3. The system self-directs.</strong> The "Next Bill" callout auto-selects the highest-value unrouted bill and shows a live 3-month safety projection for it.</div>
        </div>
      </Card>

      {/* Add/Edit modal */}
      {showForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16, backdropFilter: "blur(4px)" }} onClick={() => setShowForm(false)}>
          <div style={{ background: T.surface, borderRadius: T.radius, boxShadow: T.shadowHover, padding: 28, width: 400, maxWidth: "100%" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: "'Lora', serif", marginBottom: 20 }}>{editId ? "Edit Bill" : "Add New Bill"}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Input label="BILL NAME" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Car Insurance" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label="MONTHLY AMOUNT ($)" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="e.g. 238" />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 5 }}>CATEGORY</div>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ width: "100%", padding: "10px 13px", background: T.surfaceAlt, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, color: T.text, fontFamily: "inherit", outline: "none" }}>
                    {Object.entries(CATS).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
                  </select>
                </div>
              </div>
              <Input label="NOTES" hint="optional" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Auto-renews July" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={submitForm} style={{ flex: 1, padding: "11px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>{editId ? "Save Changes" : "Add Bill"}</button>
              <button onClick={() => setShowForm(false)} style={{ padding: "11px 16px", background: "transparent", color: T.textSub, border: `1px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── STRESS TEST — RECOVERY CHART ─────────────────────────────────────────────

function RecoveryChart({ postCrashGross, margin, divs, w2, bills, marginRate, yield_, precrashEquity }) {
  const W = 600, H = 160, pad = { t: 16, r: 24, b: 28, l: 48 };
  const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;
  const months = 36;
  const curve = projectCurve(postCrashGross, margin, divs, w2, bills, marginRate, yield_, months, 0);
  const recoveryMonth = curve.findIndex((p, i) => i > 0 && p.equity >= precrashEquity);

  const allEqs = curve.map(p => p.equity).concat([precrashEquity, 0.50]);
  const rawMin = Math.min(...allEqs);
  const rawMax = Math.max(...allEqs);
  const sp = Math.max(rawMax - rawMin, 0.1);
  const eMin = Math.max(0, rawMin - sp * 0.1);
  const eMax = Math.min(1.05, rawMax + sp * 0.1);
  const eSpan = Math.max(eMax - eMin, 0.05);

  const toX = (m) => pad.l + (m / months) * iW;
  const toY = (eq) => pad.t + iH - ((eq - eMin) / eSpan) * iH;

  const path = "M" + curve.map((p, i) => `${toX(i)},${toY(p.equity)}`).join(" L");
  const areaPath = path + ` L${toX(months)},${pad.t + iH} L${toX(0)},${pad.t + iH} Z`;
  const GRIDS = [0.10,0.20,0.30,0.40,0.50,0.55,0.60,0.70,0.80,0.90,1.00].filter(v => v >= eMin - 0.01 && v <= eMax + 0.01);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id="recGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={T.blueMid} stopOpacity="0.15" />
          <stop offset="100%" stopColor={T.blueMid} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {GRIDS.map(v => {
        const y = toY(v); const is60 = v === 0.60, is55 = v === 0.55;
        return <g key={v}>
          <line x1={pad.l} x2={pad.l + iW} y1={y} y2={y} stroke={is60 ? T.greenMid : is55 ? T.amberMid : T.borderLight} strokeWidth={1} strokeDasharray={(is60 || is55) ? "5,4" : "0"} opacity={(is60 || is55) ? 0.8 : 1} />
          <text x={pad.l - 6} y={y + 4} textAnchor="end" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{(v * 100).toFixed(0)}%</text>
        </g>;
      })}
      {/* Pre-crash line */}
      {precrashEquity >= eMin && precrashEquity <= eMax && (
        <g>
          <line x1={pad.l} x2={pad.l + iW} y1={toY(precrashEquity)} y2={toY(precrashEquity)} stroke={T.indigo} strokeWidth={1.5} strokeDasharray="8,4" opacity={0.7} />
          <text x={pad.l + iW + 5} y={toY(precrashEquity) + 4} fill={T.indigo} fontSize="8" fontFamily="Nunito" fontWeight="700">Pre-crash</text>
        </g>
      )}
      {[0, 6, 12, 18, 24, 30, 36].map(m => (
        <text key={m} x={toX(m)} y={pad.t + iH + 16} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{m === 0 ? "Crash" : `+${m}mo`}</text>
      ))}
      <path d={areaPath} fill="url(#recGrad)" />
      <path d={path} fill="none" stroke={T.blueMid} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {recoveryMonth > 0 && recoveryMonth <= months && (
        <g>
          <line x1={toX(recoveryMonth)} x2={toX(recoveryMonth)} y1={pad.t} y2={pad.t + iH} stroke={T.indigo} strokeWidth={1.5} strokeDasharray="4,3" opacity={0.6} />
          <circle cx={toX(recoveryMonth)} cy={toY(curve[recoveryMonth].equity)} r="5" fill={T.indigo} stroke={T.surface} strokeWidth="2" />
          <text x={toX(recoveryMonth)} y={pad.t - 3} textAnchor="middle" fill={T.indigo} fontSize="9" fontFamily="Nunito" fontWeight="700">Recovered +{recoveryMonth}mo</text>
        </g>
      )}
      {[0, 12, 24, 36].filter(m => m < curve.length).map(m => (
        <circle key={m} cx={toX(m)} cy={toY(curve[m].equity)} r="3.5"
          fill={curve[m].equity >= 0.60 ? T.greenMid : curve[m].equity >= 0.55 ? T.amberMid : T.red}
          stroke={T.surface} strokeWidth="2" />
      ))}
    </svg>
  );
}

// ─── STRESS TEST TAB ──────────────────────────────────────────────────────────

function StressTestTab({ latest, settings }) {
  const [drawdown, setDrawdown] = useState(25);
  const [nextBillAmt, setNextBillAmt] = useState("200");

  if (!latest) return <Card><div style={{ textAlign: "center", padding: 48, color: T.textMuted }}>Log at least one month to run stress tests.</div></Card>;

  const { gross, margin, effectiveDivs: divs, w2, bills, equity: precrashEquity } = latest;
  const { marginRate, effectiveYield: yield_ } = settings;

  const d = drawdown / 100;
  const postCrashGross = gross * (1 - d);
  const postCrashEquity = margin > 0 ? (postCrashGross - margin) / postCrashGross : 1.0;
  const postCrashDivs = postCrashGross * yield_ / 12;
  const dollarLoss = gross - postCrashGross;
  const recoveryMonths = calcRecoveryMonths(postCrashGross, margin, postCrashDivs, w2, bills, marginRate, yield_, precrashEquity);

  const drop60 = criticalDropPct(gross, margin, 0.60);
  const drop55 = criticalDropPct(gross, margin, 0.55);
  const dropCall25 = criticalDropPct(gross, margin, 0.25);
  const noMargin = !margin || margin <= 0;

  const eqStatus = (eq) => {
    if (eq >= 0.60) return { label: "Above trigger", color: T.green, bg: T.greenBg, border: T.greenBorder };
    if (eq >= 0.55) return { label: "Caution zone", color: T.amber, bg: T.amberBg, border: T.amberBorder };
    if (eq >= 0.25) return { label: "Below floor", color: T.red, bg: T.redBg, border: T.redBorder };
    return { label: "Margin call risk", color: T.rose, bg: T.roseBg, border: T.roseBorder };
  };
  const status = eqStatus(postCrashEquity);

  const CushionBar = ({ label, dropPct, color, bg, border }) => {
    const isInf = !isFinite(dropPct) || noMargin;
    const pct = isInf ? 100 : Math.min(100, Math.max(0, dropPct));
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{label}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: 800, color, fontFamily: "'Lora', serif" }}>{isInf ? "∞" : `−${pct.toFixed(1)}%`}</span>
            {!isInf && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: bg, color, border: `1px solid ${border}` }}>{pct > 40 ? "Very Safe" : pct > 20 ? "Healthy" : pct > 10 ? "Watch" : "Tight"}</span>}
          </div>
        </div>
        <div style={{ height: 8, background: T.borderLight, borderRadius: 4, overflow: "hidden", position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: color, borderRadius: 4, opacity: 0.55, transition: "width 0.4s" }} />
          {!isInf && drawdown > 0 && drawdown < 100 && (
            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${Math.min(drawdown, 99)}%`, width: 2, background: T.text, opacity: 0.35 }} />
          )}
        </div>
        <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4 }}>
          {isInf ? "No margin — price drops alone cannot trigger this threshold" : `Portfolio can absorb a ${pct.toFixed(1)}% market drop before this line is crossed`}
        </div>
      </div>
    );
  };

  const SCENARIOS = [5, 10, 15, 20, 25, 30, 40, 50, 60];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Current vs post-crash */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card style={{ background: T.text }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.5px", color: "rgba(255,255,255,0.4)", marginBottom: 12 }}>CURRENT POSITION</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[
              { l: "Equity", v: fmtPct(precrashEquity), c: precrashEquity >= 0.60 ? "#6EE7B7" : precrashEquity >= 0.55 ? "#FCD34D" : "#FCA5A5" },
              { l: "Gross Portfolio", v: fmt$(gross), c: "#fff" },
              { l: "Margin Debt", v: fmt$(margin), c: margin > 0 ? "#FCA5A5" : "#6EE7B7" },
              { l: "Net Value", v: fmt$(gross - margin), c: "#fff" },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</div></div>
            ))}
          </div>
        </Card>
        <Card style={{ background: status.bg, border: `1px solid ${status.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.5px", color: status.color, marginBottom: 12 }}>AFTER −{drawdown}% CRASH</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {[
              { l: "Equity", v: fmtPct(postCrashEquity), c: status.color },
              { l: "Gross Portfolio", v: fmt$(postCrashGross), c: T.text },
              { l: "Dollar Loss", v: "−" + fmt$(dollarLoss), c: T.red },
              { l: "Net Value", v: fmt$(postCrashGross - margin), c: T.text },
            ].map(({ l, v, c }) => (
              <div key={l}><div style={{ fontSize: 10, color: T.textMuted, marginBottom: 4 }}>{l}</div><div style={{ fontSize: 16, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</div></div>
            ))}
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: "rgba(0,0,0,0.07)", color: status.color }}>{status.label}</span>
            {recoveryMonths !== null
              ? <span style={{ fontSize: 11, fontWeight: 600, color: T.indigo, padding: "3px 10px", borderRadius: 20, background: T.indigoBg, border: `1px solid ${T.indigoBorder}` }}>Recovery: ~{recoveryMonths} months</span>
              : <span style={{ fontSize: 11, fontWeight: 600, color: T.red, padding: "3px 10px", borderRadius: 20, background: T.redBg, border: `1px solid ${T.redBorder}` }}>Recovery: &gt;10 years</span>
            }
          </div>
        </Card>
      </div>

      {/* Simulator slider */}
      <Card>
        <SectionLabel>CRASH SIMULATOR</SectionLabel>
        <style>{`.crash-slider{-webkit-appearance:none;height:6px;border-radius:3px;background:linear-gradient(90deg,${T.red} 0%,${T.red} ${(drawdown/70)*100}%,${T.borderLight} ${(drawdown/70)*100}%,${T.borderLight} 100%);outline:none;cursor:pointer}.crash-slider::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:${T.red};border:3px solid #fff;box-shadow:0 2px 6px rgba(220,38,38,0.4);cursor:pointer}.crash-slider::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:${T.red};border:3px solid #fff;cursor:pointer}`}</style>
        <div style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: T.textSub }}>Drag to simulate a market drawdown</span>
          <div style={{ fontSize: 32, fontWeight: 800, color: T.red, fontFamily: "'Lora', serif" }}>−{drawdown}%</div>
        </div>
        <input type="range" min="1" max="70" value={drawdown} onChange={e => setDrawdown(Number(e.target.value))} className="crash-slider" style={{ width: "100%", marginBottom: 10 }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.textMuted, marginBottom: 16 }}>
          <span>−1%</span><span>−15% correction</span><span>−30% bear</span><span>−50% crash</span><span>−70% crisis</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[{ l: "Correction", v: 10 }, { l: "Bear Market", v: 25 }, { l: "2008 Crisis", v: 38 }, { l: "Dot-Com Crash", v: 50 }, { l: "Worst Case", v: 60 }].map(({ l, v }) => (
            <button key={v} onClick={() => setDrawdown(v)} style={{ padding: "5px 12px", background: drawdown === v ? T.red : T.surfaceAlt, color: drawdown === v ? "#fff" : T.textSub, border: `1px solid ${drawdown === v ? T.red : T.border}`, borderRadius: 20, fontSize: 11, fontWeight: 600, fontFamily: "inherit", transition: "all 0.18s", cursor: "pointer" }}>
              {l} ({v}%)
            </button>
          ))}
        </div>
      </Card>

      {/* Safety cushion bars */}
      <Card>
        <SectionLabel>YOUR SAFETY CUSHION — HOW MUCH CAN THE MARKET DROP?</SectionLabel>
        <div style={{ fontSize: 12, color: T.textSub, marginBottom: 20, lineHeight: 1.6 }}>
          Each bar shows how large a market drop your portfolio can absorb before that threshold is crossed. The faint vertical marker shows your currently simulated drawdown of {drawdown}%.
        </div>
        <CushionBar label="Before hitting 60% trigger (pause on adding bills until recovery)" dropPct={drop60} color={T.green} bg={T.greenBg} border={T.greenBorder} />
        <CushionBar label="Before hitting 55% hard floor (emergency — stop all new margin draws)" dropPct={drop55} color={T.amber} bg={T.amberBg} border={T.amberBorder} />
        <CushionBar label="Before margin call (E-Trade 25% maintenance requirement)" dropPct={dropCall25} color={T.rose} bg={T.roseBg} border={T.roseBorder} />
        {noMargin && (
          <div style={{ padding: "12px 16px", background: T.greenBg, border: `1px solid ${T.greenBorder}`, borderRadius: T.radiusSm, fontSize: 12, color: T.green, marginTop: 8 }}>
            <strong>No margin debt.</strong> Margin call risk is essentially zero — price drops reduce your wealth but cannot trigger a forced liquidation.
          </div>
        )}
      </Card>

      {/* Recovery chart */}
      <Card>
        <SectionLabel>RECOVERY TRAJECTORY — AFTER −{drawdown}% CRASH</SectionLabel>
        <div style={{ fontSize: 12, color: T.textSub, marginBottom: 14, lineHeight: 1.6 }}>
          Projects equity recovery from the post-crash position via W2 deposits and dividend compounding. Indigo dashed = pre-crash equity ({fmtPct(precrashEquity)}).
          {recoveryMonths !== null ? ` Full recovery in ~${recoveryMonths} months.` : " Full recovery not projected within 10 years at current pace — consider additional deposits or reducing margin."}
        </div>
        <RecoveryChart postCrashGross={postCrashGross} margin={margin} divs={postCrashDivs} w2={w2} bills={bills} marginRate={marginRate} yield_={yield_} precrashEquity={precrashEquity} />
      </Card>

      {/* Scenario grid */}
      <Card>
        <SectionLabel>FULL SCENARIO GRID — CLICK TO SIMULATE</SectionLabel>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${T.border}` }}>
                {["Drop", "Post-Crash Equity", "Net Value", "Divs/Mo", "Status", "Recovery"].map(h => (
                  <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: T.textMuted }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCENARIOS.map(pct => {
                const dFrac = pct / 100;
                const pcg = gross * (1 - dFrac);
                const pce = margin > 0 ? (pcg - margin) / pcg : 1.0;
                const pcd = pcg * yield_ / 12;
                const rec = calcRecoveryMonths(pcg, margin, pcd, w2, bills, marginRate, yield_, precrashEquity);
                const st = eqStatus(pce);
                const isActive = pct === drawdown;
                return (
                  <tr key={pct} onClick={() => setDrawdown(pct)} style={{ borderBottom: `1px solid ${T.borderLight}`, background: isActive ? T.surfaceAlt : "transparent", cursor: "pointer", transition: "background 0.1s" }}
                    onMouseEnter={ev => { if (!isActive) ev.currentTarget.style.background = T.surfaceAlt; }}
                    onMouseLeave={ev => { if (!isActive) ev.currentTarget.style.background = "transparent"; }}>
                    <td style={{ padding: "11px 14px", fontWeight: 700, color: pct >= 40 ? T.red : pct >= 20 ? T.amber : T.text, fontFamily: "'Lora', serif", fontSize: 14 }}>−{pct}%</td>
                    <td style={{ padding: "11px 14px", fontWeight: 700, color: st.color, fontSize: 14, fontFamily: "'Lora', serif" }}>{fmtPct(pce)}</td>
                    <td style={{ padding: "11px 14px", color: T.textSub }}>{fmt$(pcg - margin)}</td>
                    <td style={{ padding: "11px 14px", color: T.green }}>{fmt$(pcd)}</td>
                    <td style={{ padding: "11px 14px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: st.bg, color: st.color, border: `1px solid ${st.border}` }}>{st.label}</span>
                    </td>
                    <td style={{ padding: "11px 14px", color: T.indigo, fontWeight: 600 }}>
                      {rec !== null ? `${rec} months` : <span style={{ color: T.red }}>&gt; 10 years</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* What if you add a bill then crash? */}
      <Card style={{ background: T.indigoBg, border: `1px solid ${T.indigoBorder}`, boxShadow: "none" }}>
        <SectionLabel>WHAT IF YOU ADD A BILL, THEN THE MARKET CRASHES?</SectionLabel>
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: T.textSub }}>Simulate adding</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: T.textMuted }}>$</span>
            <input value={nextBillAmt} onChange={e => setNextBillAmt(e.target.value)} style={{ width: 80, padding: "7px 10px", background: T.surface, border: `1px solid ${T.indigoBorder}`, borderRadius: T.radiusXs, fontSize: 14, fontWeight: 700, color: T.indigo, fontFamily: "'Lora', serif", outline: "none", textAlign: "right" }} />
            <span style={{ color: T.textMuted }}>/mo</span>
          </div>
          <span style={{ fontSize: 12, color: T.textSub }}>then absorbing a −{drawdown}% crash</span>
        </div>
        {(() => {
          const billAmt = parseNum(nextBillAmt) || 0;
          if (!billAmt) return null;
          const postBillCrashGross = gross * (1 - d);
          const postBillCrashEq = margin > 0 ? (postBillCrashGross - margin) / postBillCrashGross : 1.0;
          const postBillRec = calcRecoveryMonths(postBillCrashGross, margin, postBillCrashGross * yield_ / 12, w2 + billAmt, bills + billAmt, marginRate, yield_, precrashEquity);
          const stBill = eqStatus(postBillCrashEq);
          return (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
              {[
                { l: `Crash equity (no new bill)`, v: fmtPct(postCrashEquity), c: status.color },
                { l: `Crash equity (with +${fmt$(billAmt, 0)}/mo added)`, v: fmtPct(postBillCrashEq), c: stBill.color },
                { l: "Recovery time (with new bill)", v: postBillRec !== null ? `${postBillRec} months` : "> 10 years", c: T.indigo },
              ].map(({ l, v, c }) => (
                <div key={l} style={{ background: T.surface, borderRadius: T.radiusSm, padding: "14px 16px", border: `1px solid ${T.indigoBorder}` }}>
                  <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 6, lineHeight: 1.4 }}>{l}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</div>
                </div>
              ))}
            </div>
          );
        })()}
        <div style={{ marginTop: 14, fontSize: 11, color: T.indigo, lineHeight: 1.7 }}>
          <strong>Key insight:</strong> Adding a bill increases your W2 deposit by the same amount, which accelerates recovery. But it also grows your monthly draw if dividends don't yet cover it. The W2 increase and bill increase are always equal — cash-flow neutral to your life.
        </div>
      </Card>
    </div>
  );
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────

function SettingsTab({ settings, setSettings, derivedYield, hasActualData }) {
  const [local, setLocal] = useState({ ...settings, marginRateStr: (settings.marginRate * 100).toFixed(2), targetYieldStr: (settings.targetYield * 100).toFixed(1) });
  const apply = () => {
    const mr = parseNum(local.marginRateStr) / 100;
    const ty = parseNum(local.targetYieldStr) / 100;
    if (mr > 0 && mr < 1 && ty > 0 && ty < 2) setSettings(s => ({ ...s, marginRate: mr, targetYield: ty, yieldMode: local.yieldMode }));
  };
  return (
    <div style={{ maxWidth: 700, display: "flex", flexDirection: "column", gap: 20 }}>
      <Card>
        <SectionLabel>MARGIN INTEREST RATE</SectionLabel>
        <div style={{ display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <Input label="Your current E-Trade margin rate" hint="(annual %)" value={local.marginRateStr} onChange={e => setLocal(l => ({ ...l, marginRateStr: e.target.value }))} placeholder="e.g. 8.44" />
            <div style={{ marginTop: 8, fontSize: 11, color: T.textMuted, lineHeight: 1.6 }}>Default is 8.44% (negotiated). Call E-Trade and ask for the active trader rate — worth <strong style={{ color: T.text }}>$55K+ over 10 years</strong>.</div>
          </div>
          <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "14px 18px", minWidth: 160, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, letterSpacing: "1px", marginBottom: 6 }}>CURRENT SETTING</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: T.red, fontFamily: "'Lora', serif" }}>{(settings.marginRate * 100).toFixed(2)}%</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>annual rate</div>
          </div>
        </div>
      </Card>
      <Card>
        <SectionLabel>TARGET PORTFOLIO YIELD</SectionLabel>
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {[["manual", "Manual Override"], ["auto", "Auto (from your data)"]].map(([mode, label]) => (
            <Pill key={mode} active={local.yieldMode === mode} onClick={() => setLocal(l => ({ ...l, yieldMode: mode }))}>{label}</Pill>
          ))}
        </div>
        {local.yieldMode === "auto" ? (
          <div style={{ background: T.greenBg, border: `1px solid ${T.greenBorder}`, borderRadius: T.radiusSm, padding: "16px" }}>
            {hasActualData ? (
              <><div style={{ fontSize: 11, color: T.green, fontWeight: 600, marginBottom: 4 }}>Derived from your logged actual dividends</div>
                <div style={{ fontSize: 32, fontWeight: 700, color: T.green, fontFamily: "'Lora', serif" }}>{fmtPct(derivedYield, 1)}</div>
                <div style={{ fontSize: 11, color: T.textSub, marginTop: 6 }}>Updates automatically every time you log a month with actual dividends.</div></>
            ) : (
              <div style={{ fontSize: 12, color: T.textSub }}><strong style={{ color: T.text }}>No actual dividend data yet.</strong> Log monthly actual dividends and this will auto-calculate your real blended yield.</div>
            )}
          </div>
        ) : (
          <div>
            <Input label="Target blended annual yield" hint="(annual %)" value={local.targetYieldStr} onChange={e => setLocal(l => ({ ...l, targetYieldStr: e.target.value }))} placeholder="e.g. 23.0" />
            <div style={{ marginTop: 10, fontSize: 11, color: T.textMuted, lineHeight: 1.7 }}><strong style={{ color: T.text }}>Lower (15–18%):</strong> stable NAV, conservative. <strong style={{ color: T.text }}>Higher (30–40%):</strong> faster dividends, more NAV erosion risk.</div>
          </div>
        )}
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {[{ label: "Conservative", yield_: 0.15, note: "Stable NAV" }, { label: "Current Setting", yield_: settings.effectiveYield, note: "Active projection" }, { label: "Aggressive", yield_: 0.35, note: "NAV erosion risk" }].map(({ label, yield_, note }) => (
            <div key={label} onClick={() => { if (local.yieldMode === "manual") setLocal(l => ({ ...l, targetYieldStr: (yield_ * 100).toFixed(1) })); }}
              style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "14px", cursor: local.yieldMode === "manual" ? "pointer" : "default" }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: T.text, fontFamily: "'Lora', serif" }}>{fmtPct(yield_, 0)}</div>
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4 }}>{note}</div>
            </div>
          ))}
        </div>
      </Card>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={apply} style={{ padding: "11px 28px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Save Settings</button>
        <button onClick={() => { setLocal({ ...DEFAULT_SETTINGS, marginRateStr: "8.44", targetYieldStr: "23.0" }); setSettings(DEFAULT_SETTINGS); }}
          style={{ padding: "11px 20px", background: "transparent", color: T.textSub, border: `1px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Reset to Defaults</button>
        <div style={{ fontSize: 11, color: T.textMuted }}>Changes affect all projections instantly.</div>
      </div>
      <Card style={{ background: T.indigoBg, border: `1px solid ${T.indigoBorder}`, boxShadow: "none" }}>
        <SectionLabel>WHY YOUR MARGIN RATE MATTERS SO MUCH</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {[{ label: "At 12.58% (default)", rate: 0.1258, color: T.red }, { label: "At 8.44% (negotiated)", rate: 0.0844, color: T.green }, { label: "10-Year Advantage", rate: null, color: T.indigo }].map(({ label, rate, color }, i) => (
            <div key={i} style={{ background: T.surface, borderRadius: T.radiusSm, padding: "14px", border: `1px solid ${T.indigoBorder}` }}>
              <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, marginBottom: 8 }}>{label}</div>
              {rate !== null ? (
                <><div style={{ fontSize: 11, color: T.textSub, marginBottom: 3 }}>Interest on $10K margin</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'Lora', serif" }}>{fmt$(10000 * rate / 12)}<span style={{ fontSize: 11, color: T.textMuted }}>/mo</span></div>
                  <div style={{ fontSize: 11, color: T.textSub, marginTop: 6 }}>Spread: {(0.23 / rate).toFixed(2)}x</div></>
              ) : (
                <><div style={{ fontSize: 11, color: T.textSub, marginBottom: 3 }}>Net portfolio advantage</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'Lora', serif" }}>+$55,271</div>
                  <div style={{ fontSize: 11, color: T.textSub, marginTop: 6 }}>+$1,731/mo by year 10</div></>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── HELP PAGE ────────────────────────────────────────────────────────────────

function HelpPage() {
  const Term = ({ term, color = T.text, children }) => (
    <div style={{ marginBottom: 10, padding: "12px 16px", background: T.surfaceAlt, border: `1px solid ${T.borderLight}`, borderRadius: T.radiusSm }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4 }}>{term}</div>
      <div style={{ fontSize: 12, color: T.textSub, lineHeight: 1.75 }}>{children}</div>
    </div>
  );
  const Step = ({ n, children }) => (
    <div style={{ display: "flex", gap: 14, marginBottom: 12 }}>
      <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.text, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", flexShrink: 0, fontWeight: 700 }}>{n}</div>
      <div style={{ fontSize: 12, color: T.textSub, lineHeight: 1.75, paddingTop: 4 }}>{children}</div>
    </div>
  );
  const Note = ({ icon, children, color = T.textSub, bg = T.surfaceAlt, border = T.border }) => (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: T.radiusSm, padding: "12px 16px", marginBottom: 12, display: "flex", gap: 10 }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <div style={{ fontSize: 12, color, lineHeight: 1.75 }}>{children}</div>
    </div>
  );
  return (
    <div style={{ maxWidth: 960, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
      <div>
        <Card style={{ marginBottom: 20 }}>
          <SectionLabel>HOW TO USE THIS TRACKER</SectionLabel>
          <Note icon="📅" color={T.amber} bg={T.amberBg} border={T.amberBorder}>Log once per month on the <strong>1st of each month</strong>. Weekly logging breaks the rising streak logic.</Note>
          <Step n={1}>Open <strong>E-Trade → Accounts → Portfolio Summary</strong>. Note <strong>Total Portfolio Value</strong> (Gross) and <strong>Margin Balance</strong>.</Step>
          <Step n={2}>Go to <strong>Accounts → Activity → Dividends</strong>. Sum all dividends paid this month. Enter in the <strong>Actual Dividends</strong> field — optional but highly recommended.</Step>
          <Step n={3}>Enter your <strong>W2 Deposit</strong> (monthly paycheck redirect) and <strong>Bills Floated</strong>. Use the Bill Tracker tab as your source of truth.</Step>
          <Step n={4}>When all 3 green conditions fire — act the same day. Toggle the next bill in the Bill Tracker and update your deposit amount.</Step>
          <Step n={5}>Run <strong>Stress Test</strong> monthly to know your exact safety cushion before adding any bill.</Step>
          <Note icon="👁" color={T.blue} bg={T.blueBg} border={T.blueBorder}>Use <strong>Quick Check</strong> for Friday equity peeks — snapshot without saving a log entry.</Note>
          <Note icon="🛡️" color={T.rose} bg={T.roseBg} border={T.roseBorder}>The <strong>Bill Tracker</strong> is your master list. Every bill you'll ever float lives here.</Note>
        </Card>
        <Card>
          <SectionLabel>THE THREE CONDITIONS</SectionLabel>
          <Term term="Condition 1 — Equity ≥ 60%" color={T.green}>Equity must be at or above 60%. Formula: <strong>(Gross − Margin) ÷ Gross</strong>. Below 60% means your cushion is too thin for a new recurring draw.</Term>
          <Term term="Condition 2 — Rising 2+ Consecutive Months" color={T.amber}>Equity must increase for at least 2 months in a row. One month is noise. Two consecutive is a confirmed uptrend. Streak resets to zero on any dip.</Term>
          <Term term="Condition 3 — 3-Month Forward Floor ≥ 55%" color={T.blue}>Simulates the next 3 months with the new bill added. Every projected month must stay ≥ 55%. If any month dips below, condition fails — even if today looks fine.</Term>
        </Card>
      </div>
      <div>
        <Card style={{ marginBottom: 20 }}>
          <SectionLabel>TERM DEFINITIONS</SectionLabel>
          <Term term="Gross Portfolio Value">Total value of all positions before subtracting margin debt. Top-line number on E-Trade summary.</Term>
          <Term term="Equity %" color={T.green}><strong>(Gross − Margin) ÷ Gross.</strong> The most important number. Keep above 60% to add bills, above 55% always.</Term>
          <Term term="Net Margin Draw" color={T.red}><strong>Bills − Dividends.</strong> Monthly amount added to margin. Goal: $0 (dividends cover all bills).</Term>
          <Term term="Bill Coverage %" color={T.amber}><strong>Dividends ÷ Bills.</strong> What percentage of floated bills are paid by dividends. Goal: 100%.</Term>
          <Term term="Margin Efficiency" color={T.indigo}><strong>Yield ÷ Margin Rate.</strong> At 23%/8.44% = 2.73x — every borrowed dollar generates 2.73× its cost in dividends.</Term>
          <Term term="Freedom Date" color={T.indigo}>Month when dividends fully cover all floated bills — W2 becomes optional.</Term>
          <Term term="Safety Cushion" color={T.rose}>How much the market can drop before hitting each critical threshold (60%, 55%, margin call).</Term>
          <Term term="Recovery Time" color={T.violet}>After a crash, months until equity returns to pre-crash level via deposits + dividends.</Term>
        </Card>
        <Card>
          <SectionLabel>KEY NUMBERS</SectionLabel>
          {[{ l: "Trigger equity", v: "60%", c: T.green }, { l: "Hard floor", v: "55%", c: T.amber }, { l: "Rising streak", v: "2 months", c: T.text }, { l: "Forward check", v: "3 months", c: T.blue }, { l: "Target yield", v: "23%", c: T.green }, { l: "Negotiated rate", v: "8.44%", c: T.red }, { l: "Business spread", v: "~14.6%", c: T.green }, { l: "Maint. margin (E-Trade)", v: "25%", c: T.rose }].map(({ l, v, c }) => (
            <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${T.borderLight}` }}>
              <span style={{ fontSize: 12, color: T.text }}>{l}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: c, fontFamily: "'Lora', serif" }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <SectionLabel>WHERE TO FIND YOUR NUMBERS IN E-TRADE</SectionLabel>
            {[{ l: "Gross Portfolio Value", w: "Accounts → Portfolio → Total Portfolio Value" }, { l: "Margin Balance", w: "Accounts → Portfolio → Margin Balance / Debit" }, { l: "Actual Dividends", w: "Accounts → Activity & Orders → Dividends" }, { l: "Your Margin Rate", w: "Accounts → Margin → Margin Rate (call to negotiate)" }].map(({ l, w }) => (
              <div key={l} style={{ padding: "9px 12px", background: T.surfaceAlt, borderRadius: T.radiusXs, marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.text }}>{l}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 2 }}>→ {w}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── QUICK CHECK ──────────────────────────────────────────────────────────────

function QuickCheckModal({ onClose, latest, settings }) {
  const [qGross, setQGross] = useState(""); const [qMargin, setQMargin] = useState(""); const [result, setResult] = useState(null);
  const eqColor = (eq) => eq >= 0.60 ? T.green : eq >= 0.55 ? T.amber : T.red;
  const check = () => { const g = parseNum(qGross), m = parseNum(qMargin); if (!g) return; const equity = (g - m) / g; const divs = g * settings.effectiveYield / 12; setResult({ equity, divs, change: latest ? equity - latest.equity : null }); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16, backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: T.surface, borderRadius: T.radius, boxShadow: T.shadowHover, padding: 28, width: 380, maxWidth: "100%" }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4, fontFamily: "'Lora', serif" }}>Quick Check</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 20 }}>Snapshot equity without saving a log entry</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
          <Input label="GROSS PORTFOLIO ($)" value={qGross} onChange={e => setQGross(e.target.value)} placeholder="e.g. 8,490.76" />
          <Input label="MARGIN BALANCE ($)" value={qMargin} onChange={e => setQMargin(e.target.value)} placeholder="e.g. 638.26" />
        </div>
        <button onClick={check} style={{ width: "100%", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, padding: "11px", fontFamily: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", marginBottom: result ? 16 : 0 }}>Calculate</button>
        {result && (
          <div style={{ background: T.surfaceAlt, borderRadius: T.radiusSm, padding: 16, border: `1px solid ${T.border}` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, marginBottom: 4 }}>CURRENT EQUITY</div>
                <div style={{ fontSize: 32, fontWeight: 700, color: eqColor(result.equity), fontFamily: "'Lora', serif" }}>{fmtPct(result.equity)}</div>
                {result.change !== null && <div style={{ fontSize: 11, color: result.change >= 0 ? T.green : T.red, marginTop: 4 }}>{result.change >= 0 ? "▲ +" : "▼ "}{fmtPct(result.change, 1)} vs last log</div>}
              </div>
              <div>
                <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 600, marginBottom: 4 }}>STATUS</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: eqColor(result.equity), marginTop: 8 }}>{result.equity >= 0.60 ? "✓ Above trigger" : result.equity >= 0.55 ? "⚠ Caution zone" : "✗ Below floor"}</div>
                <div style={{ fontSize: 11, color: T.textMuted, marginTop: 6 }}>Est. {fmt$(result.divs)}/mo divs</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, padding: "8px 12px", background: T.surface, borderRadius: T.radiusXs }}>Snapshot only — not saved. Log officially on the 1st.</div>
          </div>
        )}
        <button onClick={onClose} style={{ width: "100%", background: "transparent", color: T.textMuted, border: `1px solid ${T.border}`, borderRadius: T.radiusXs, padding: "10px", fontFamily: "inherit", fontSize: 13, cursor: "pointer", marginTop: 12 }}>Close</button>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────

export default function App() {
  const [entries, setEntries] = useState([]);
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [billItems, setBillItems] = useState([]);
  const [form, setForm] = useState({ gross: "", margin: "", w2: "871", bills: "801", actualDivs: "", date: new Date().toISOString().slice(0, 7) });
  const [nextBill, setNextBill] = useState("200");
  const [showAdd, setShowAdd] = useState(false);
  const [showQC, setShowQC] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");

  useEffect(() => {
    const load = async () => {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (r?.value) setEntries(JSON.parse(r.value));
        const s = await window.storage.get(SETTINGS_KEY);
        if (s?.value) setSettingsState(prev => ({ ...prev, ...JSON.parse(s.value) }));
        const b = await window.storage.get(BILLS_KEY);
        if (b?.value) setBillItems(JSON.parse(b.value));
      } catch {}
    };
    load();
  }, []);

  const saveEntries = useCallback(async (data) => { try { await window.storage.set(STORAGE_KEY, JSON.stringify(data)); } catch {} }, []);
  const setSettings = useCallback(async (updater) => {
    setSettingsState(prev => { const next = typeof updater === "function" ? updater(prev) : updater; window.storage.set(SETTINGS_KEY, JSON.stringify(next)).catch(() => {}); return next; });
  }, []);
  const saveBills = useCallback(async (data) => { try { await window.storage.set(BILLS_KEY, JSON.stringify(data)); } catch {} }, []);

  const derivedYield = useMemo(() => {
    const w = entries.filter(e => e.actualDivs != null && e.actualDivs !== "" && e.gross > 0);
    if (!w.length) return DEFAULT_SETTINGS.targetYield;
    const avg = w.reduce((sum, e) => sum + (parseNum(e.actualDivs) * 12) / e.gross, 0) / w.length;
    return avg > 0 ? avg : DEFAULT_SETTINGS.targetYield;
  }, [entries]);

  const effectiveYield = settings.yieldMode === "auto" && entries.some(e => e.actualDivs != null && e.actualDivs !== "") ? derivedYield : settings.targetYield;
  const fullSettings = { ...settings, effectiveYield };
  const floatedBillsTotal = useMemo(() => billItems.filter(b => b.isFloated).reduce((s, b) => s + b.amount, 0), [billItems]);

  const computed = useMemo(() => entries.map((e, i) => {
    const equity = (e.gross - e.margin) / e.gross;
    const prev = i > 0 ? entries[i - 1] : null;
    const prevEquity = prev ? (prev.gross - prev.margin) / prev.gross : null;
    const rising = prevEquity !== null ? equity > prevEquity : null;
    const estimatedDivs = e.gross * effectiveYield / 12;
    const actualDivs = e.actualDivs != null && e.actualDivs !== "" ? parseNum(e.actualDivs) : null;
    const effectiveDivs = actualDivs !== null ? actualDivs : estimatedDivs;
    const prevEff = prev ? (prev.actualDivs != null && prev.actualDivs !== "" ? parseNum(prev.actualDivs) : prev.gross * effectiveYield / 12) : null;
    const divGrowth = prevEff !== null ? effectiveDivs - prevEff : null;
    const coverage = effectiveDivs / e.bills;
    const netDraw = Math.max(0, e.bills - effectiveDivs);
    const interestCost = e.margin * settings.marginRate / 12;
    const actualYield = actualDivs !== null ? (actualDivs * 12) / e.gross : effectiveYield;
    const equityMomentum = prevEquity !== null ? equity - prevEquity : null;
    return { ...e, equity, prevEquity, rising, estimatedDivs, actualDivs, effectiveDivs, divGrowth, coverage, netDraw, interestCost, actualYield, equityMomentum };
  }), [entries, effectiveYield, settings.marginRate]);

  const latest = computed[computed.length - 1];
  const nextBillAmt = parseNum(nextBill) || 200;
  let risingStreak = 0;
  for (let i = computed.length - 1; i >= 1; i--) { if (computed[i].rising) risingStreak++; else break; }
  const cond1 = latest ? latest.equity >= 0.60 : false;
  const cond2 = risingStreak >= 2;
  const cond3 = latest ? projectMinEquity(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + nextBillAmt, latest.bills + nextBillAmt, settings.marginRate, effectiveYield, 3) >= 0.55 : false;
  const allGreen = cond1 && cond2 && cond3;
  const freedomMonths = latest ? projectFreedomMonths(latest.gross, latest.margin, latest.effectiveDivs, latest.w2, latest.bills, settings.marginRate, effectiveYield) : null;
  const freedomDate = getFreedomDate(freedomMonths);
  const daysUntilLog = getDaysUntilNextLog(entries);
  const totalDivsReceived = computed.reduce((s, e) => s + e.effectiveDivs, 0);
  const recentMom = computed.slice(-3).map(e => e.equityMomentum).filter(v => v !== null);
  const equityMomAvg = recentMom.length ? recentMom.reduce((a, b) => a + b, 0) / recentMom.length : null;
  const monthsToTrigger = equityMomAvg > 0 && latest && !cond1 ? Math.ceil((0.60 - latest.equity) / equityMomAvg) : null;
  const eqColor = (eq) => eq >= 0.60 ? T.green : eq >= 0.55 ? T.amber : T.red;

  const handleAdd = async () => {
    const g = parseNum(form.gross), m = parseNum(form.margin), w = parseNum(form.w2), b = parseNum(form.bills);
    if (!g || !w || !b) return;
    const actualDivs = form.actualDivs.trim() !== "" ? parseNum(form.actualDivs) : null;
    const newEntries = [...entries, { date: form.date, gross: g, margin: m, w2: w, bills: b, actualDivs }].sort((a, b2) => a.date.localeCompare(b2.date));
    setEntries(newEntries); await saveEntries(newEntries); setShowAdd(false);
    setForm(f => ({ ...f, gross: "", margin: "", actualDivs: "" }));
    setPulse(true); setTimeout(() => setPulse(false), 800);
  };
  const handleDelete = async (idx) => { const n = entries.filter((_, i) => i !== idx); setEntries(n); await saveEntries(n); };

  // Chart — fully dynamic Y axis
  const chartH = 180, chartW = 640, cPad = { t: 16, r: 24, b: 30, l: 48 };
  const ciW = chartW - cPad.l - cPad.r, ciH = chartH - cPad.t - cPad.b;
  const allEqs = computed.map(e => e.equity);
  const rawEqMin = computed.length ? Math.min(...allEqs) : 0.5;
  const rawEqMax = computed.length ? Math.max(...allEqs) : 1.0;
  const eqPadAmt = Math.max((rawEqMax - rawEqMin) * 0.12, 0.04);
  const eqMin = Math.max(0, rawEqMin - eqPadAmt);
  const eqMax = Math.min(1.05, rawEqMax + eqPadAmt);
  const eqSpan = Math.max(eqMax - eqMin, 0.05);
  const toX = (i) => cPad.l + (i / Math.max(computed.length - 1, 1)) * ciW;
  const toY = (eq) => cPad.t + ciH - ((eq - eqMin) / eqSpan) * ciH;
  const linePath = computed.length > 1 ? "M" + computed.map((e, i) => `${toX(i)},${toY(e.equity)}`).join(" L") : null;
  const areaPath = linePath ? linePath + ` L${toX(computed.length - 1)},${cPad.t + ciH} L${toX(0)},${cPad.t + ciH} Z` : null;

  const TABS = [["dashboard", "Overview"], ["modeler", "Bill Modeler"], ["bills", "Bill Tracker"], ["stress", "Stress Test"], ["metrics", "Metrics"], ["log", "History"], ["settings", "Settings"], ["help", "Help"]];

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Nunito', 'Helvetica Neue', Arial, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&family=Nunito:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${T.bg}; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; }
        input:focus { outline: none; }
        .pulse { animation: pa 0.5s ease-out; }
        @keyframes pa { 0%{transform:scale(1)} 50%{transform:scale(1.008)} 100%{transform:scale(1)} }
        .trigger-glow { animation: glow 2.5s ease-in-out infinite alternate; }
        @keyframes glow { from{box-shadow:0 4px 20px rgba(21,128,61,0.15)} to{box-shadow:0 8px 40px rgba(21,128,61,0.3)} }
        button { cursor: pointer; }
        .crash-slider { -webkit-appearance: none; height: 6px; border-radius: 3px; outline: none; cursor: pointer; }
        .crash-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: ${T.red}; border: 3px solid #fff; box-shadow: 0 2px 6px rgba(220,38,38,0.4); cursor: pointer; }
        .crash-slider::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; background: ${T.red}; border: 3px solid #fff; cursor: pointer; border: none; }
      `}</style>

      {/* Top bar */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, padding: "0 32px", position: "sticky", top: 0, zIndex: 40 }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", height: 64 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: "'Lora', serif" }}>P2P Equity Tracker</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Paycheck to Portfolio</div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {daysUntilLog !== null && (
              <div style={{ padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: daysUntilLog <= 3 ? T.redBg : daysUntilLog <= 7 ? T.amberBg : T.surfaceAlt, color: daysUntilLog <= 3 ? T.red : daysUntilLog <= 7 ? T.amber : T.textMuted, border: `1px solid ${daysUntilLog <= 3 ? T.redBorder : daysUntilLog <= 7 ? T.amberBorder : T.border}` }}>
                {daysUntilLog > 0 ? `Log in ${daysUntilLog}d` : daysUntilLog === 0 ? "Log due today" : "Log overdue"}
              </div>
            )}
            {floatedBillsTotal > 0 && (
              <div style={{ padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: T.greenBg, color: T.green, border: `1px solid ${T.greenBorder}` }}>
                {fmt$(floatedBillsTotal, 0)}/mo routing
              </div>
            )}
            <button onClick={() => setShowQC(true)} style={{ padding: "8px 16px", background: T.blueBg, color: T.blue, border: `1px solid ${T.blueBorder}`, borderRadius: 8, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>Quick Check</button>
            <button onClick={() => setShowAdd(true)} style={{ padding: "8px 20px", background: T.text, color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>+ Log Month</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ background: T.surface, borderBottom: `1px solid ${T.border}`, overflowX: "auto" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 32px", display: "flex", gap: 0, minWidth: "max-content" }}>
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setActiveTab(id)} style={{ padding: "14px 18px", background: "transparent", border: "none", borderBottom: `2.5px solid ${activeTab === id ? T.text : "transparent"}`, color: activeTab === id ? T.text : T.textMuted, fontFamily: "inherit", fontSize: 13, fontWeight: activeTab === id ? 700 : 500, transition: "all 0.18s", whiteSpace: "nowrap" }}>
              {id === "bills" && billItems.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10, background: T.greenBg, color: T.green, border: `1px solid ${T.greenBorder}`, marginRight: 6 }}>{billItems.filter(b => b.isFloated).length}/{billItems.length}</span>}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Page */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "32px" }}>

        {/* ── OVERVIEW ── */}
        {activeTab === "dashboard" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {computed.length >= 2 && (
                allGreen ? (
                  <div className="trigger-glow" style={{ background: T.greenBg, border: `1.5px solid ${T.greenBorder}`, borderRadius: T.radius, padding: "20px 28px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.green, fontFamily: "'Lora', serif" }}>Add your next bill now</div>
                      <div style={{ fontSize: 12, color: T.textSub, marginTop: 4 }}>All 3 conditions met — redirect +${nextBillAmt.toLocaleString()}/mo to brokerage immediately</div>
                    </div>
                    <div style={{ fontSize: 36 }}>🟢</div>
                  </div>
                ) : (
                  <div style={{ background: T.amberBg, border: `1px solid ${T.amberBorder}`, borderRadius: T.radius, padding: "18px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: T.amber }}>Holding — {[cond1, cond2, cond3].filter(Boolean).length} of 3 conditions met</div>
                      <div style={{ fontSize: 12, color: T.textSub, marginTop: 3 }}>Log monthly to track progress toward the trigger</div>
                    </div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: T.amber, fontFamily: "'Lora', serif" }}>{[cond1, cond2, cond3].filter(Boolean).length}/3</div>
                  </div>
                )
              )}

              {latest && (
                <Card style={{ background: T.text }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 24 }}>
                    {[
                      { l: "FREEDOM DATE", v: freedomDate || "—", sub: freedomMonths ? `${freedomMonths} months away` : "", serif: true, big: true, c: "#fff" },
                      { l: "NET MARGIN DRAW", v: fmt$(latest.netDraw), sub: "bills minus dividends", c: latest.netDraw > 0 ? "#FCA5A5" : "#6EE7B7", big: true },
                      { l: "ANNUAL RUN RATE", v: fmt$(latest.effectiveDivs * 12), sub: latest.actualDivs !== null ? "from actual data" : "estimated at " + fmtPct(effectiveYield, 0), c: "#6EE7B7", big: true },
                      { l: "ALL-TIME DIVS", v: fmt$(totalDivsReceived), sub: `across ${entries.length} months`, c: "#fff", big: true },
                    ].map(({ l, v, sub, c, big }) => (
                      <div key={l}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "1.2px", color: "rgba(255,255,255,0.45)", marginBottom: 8 }}>{l}</div>
                        <div style={{ fontSize: big ? 18 : 14, fontWeight: 700, color: c, fontFamily: "'Lora', serif", lineHeight: 1.2 }}>{v}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{sub}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>0% covered</span>
                      <span style={{ fontSize: 11, color: "#6EE7B7", fontWeight: 600 }}>{fmtPct(latest.coverage, 1)} of bills covered by dividends today</span>
                      <span style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>100% = freedom</span>
                    </div>
                    <div style={{ height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.min(100, latest.coverage * 100)}%`, background: "linear-gradient(90deg, #6EE7B7, #34D399)", borderRadius: 3, transition: "width 0.5s" }} />
                    </div>
                  </div>
                </Card>
              )}

              {/* Chart */}
              <Card>
                <SectionLabel>EQUITY % OVER TIME</SectionLabel>
                <div style={{ display: "flex", gap: 20, marginBottom: 12, flexWrap: "wrap" }}>
                  {[["Equity", T.blueMid, false], ["60% trigger", T.greenMid, true], ["55% floor", T.amberMid, true]].map(([l, c, dashed]) => (
                    <div key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {dashed
                        ? <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke={c} strokeWidth="1.5" strokeDasharray="4,3" /></svg>
                        : <div style={{ width: 20, height: 2.5, background: c, borderRadius: 1 }} />}
                      <span style={{ fontSize: 11, color: T.textSub }}>{l}</span>
                    </div>
                  ))}
                </div>
                {computed.length < 2 ? (
                  <div style={{ height: chartH, display: "flex", alignItems: "center", justifyContent: "center", color: T.textMuted, fontSize: 13 }}>Log at least 2 months to see the chart</div>
                ) : (
                  <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} style={{ overflow: "visible" }}>
                    <defs>
                      <linearGradient id="main-ag" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.blueMid} stopOpacity="0.12" /><stop offset="100%" stopColor={T.blueMid} stopOpacity="0.01" />
                      </linearGradient>
                    </defs>
                    {[0.10,0.20,0.30,0.40,0.50,0.55,0.60,0.70,0.80,0.90,1.00].map(v => {
                      if (v < eqMin - 0.01 || v > eqMax + 0.01) return null;
                      const y = toY(v); const is60 = v === 0.60, is55 = v === 0.55;
                      return <g key={v}>
                        <line x1={cPad.l} x2={cPad.l + ciW} y1={y} y2={y} stroke={is60 ? T.greenMid : is55 ? T.amberMid : T.borderLight} strokeWidth={1} strokeDasharray={(is60 || is55) ? "6,4" : "0"} opacity={(is60 || is55) ? 0.75 : 1} />
                        <text x={cPad.l - 8} y={y + 4} textAnchor="end" fill={(is60 || is55) ? (is60 ? T.greenMid : T.amberMid) : T.textMuted} fontSize="10" fontFamily="Nunito" fontWeight={(is60 || is55) ? "700" : "400"}>{(v * 100).toFixed(0)}%</text>
                      </g>;
                    })}
                    {areaPath && <path d={areaPath} fill="url(#main-ag)" />}
                    {linePath && <path d={linePath} fill="none" stroke={T.blueMid} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
                    {computed.map((e, i) => <circle key={i} cx={toX(i)} cy={toY(e.equity)} r="4.5" fill={eqColor(e.equity)} stroke={T.surface} strokeWidth="2.5" />)}
                    {computed.map((e, i) => {
                      if (computed.length > 8 && i % 2 !== 0) return null;
                      const dd = new Date(e.date + "-01");
                      return <text key={i} x={toX(i)} y={cPad.t + ciH + 18} textAnchor="middle" fill={T.textMuted} fontSize="9" fontFamily="Nunito">{dd.toLocaleDateString("en-US", { month: "short", year: "2-digit" })}</text>;
                    })}
                  </svg>
                )}
              </Card>
            </div>

            {/* Right sidebar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Card>
                <SectionLabel>BILL ADDITION CONDITIONS</SectionLabel>
                <div style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: T.textSub }}>
                  Next bill:
                  <input value={nextBill} onChange={e => setNextBill(e.target.value)} placeholder="200" style={{ width: 76, padding: "6px 10px", background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, color: T.text, fontFamily: "inherit", outline: "none", textAlign: "right" }} />
                  <span>/mo</span>
                </div>
                {[
                  { pass: cond1, hd: computed.length > 0, label: "Equity ≥ 60%", sub: latest ? `Currently ${fmtPct(latest.equity)}` : "No data yet" },
                  { pass: cond2, hd: computed.length > 1, label: "Rising 2+ months", sub: risingStreak >= 2 ? "Confirmed uptrend ✓" : `${risingStreak} of 2 consecutive months`, badge: risingStreak > 0 ? `↑ ${risingStreak}mo` : null },
                  { pass: cond3, hd: computed.length > 0, label: "3-month floor ≥ 55%", sub: latest ? `Projected min: ${fmtPct(projectMinEquity(latest.gross, latest.margin, latest.effectiveDivs, latest.w2 + nextBillAmt, latest.bills + nextBillAmt, settings.marginRate, effectiveYield, 3))}` : "No data yet" },
                ].map(({ pass, hd, label, sub, badge }) => (
                  <div key={label} style={{ display: "flex", gap: 12, padding: "12px 14px", borderRadius: T.radiusSm, marginBottom: 8, background: !hd ? T.surfaceAlt : pass ? T.greenBg : T.redBg, border: `1px solid ${!hd ? T.border : pass ? T.greenBorder : T.redBorder}` }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: !hd ? T.textMuted : pass ? T.greenMid : T.red, marginTop: 4, flexShrink: 0, boxShadow: pass ? `0 0 8px ${T.greenMid}55` : "none" }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
                        {label}
                        {badge && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: T.amberBg, color: T.amber, border: `1px solid ${T.amberBorder}` }}>{badge}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: T.textSub, marginTop: 2 }}>{sub}</div>
                    </div>
                  </div>
                ))}
                {monthsToTrigger !== null && monthsToTrigger > 0 && !cond1 && (
                  <div style={{ padding: "10px 14px", background: T.blueBg, border: `1px solid ${T.blueBorder}`, borderRadius: T.radiusSm, fontSize: 11, color: T.blue, fontWeight: 600 }}>
                    📈 At current pace — trigger in ~{monthsToTrigger} month{monthsToTrigger !== 1 ? "s" : ""}
                  </div>
                )}
              </Card>

              {latest && (
                <Card>
                  <SectionLabel>LATEST SNAPSHOT</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {[
                      { l: "GROSS", v: fmt$(latest.gross), c: T.text },
                      { l: "NET VALUE", v: fmt$(latest.gross - latest.margin), c: T.text },
                      { l: "MARGIN DEBT", v: fmt$(latest.margin), c: T.red },
                      { l: "EQUITY", v: fmtPct(latest.equity), c: eqColor(latest.equity) },
                      { l: "DIVS / MO", v: fmt$(latest.effectiveDivs), c: T.green, badge: latest.actualDivs !== null ? "ACTUAL" : "EST" },
                      { l: "COVERAGE", v: fmtPct(latest.coverage, 1), c: latest.coverage >= 1 ? T.green : T.amber },
                      { l: "INTEREST / MO", v: fmt$(latest.interestCost), c: T.red },
                      { l: "NET DRAW", v: fmt$(latest.netDraw), c: latest.netDraw > 0 ? T.red : T.green },
                    ].map(({ l, v, c, badge }) => <StatTile key={l} label={l} value={v} color={c} size={14} badge={badge} serif />)}
                  </div>
                </Card>
              )}

              <Card style={{ background: T.surfaceAlt }}>
                <SectionLabel>QUICK REFERENCE</SectionLabel>
                <div style={{ fontSize: 12, color: T.textSub, lineHeight: 2 }}>
                  {[["Trigger", "60% equity", T.green], ["Hard floor", "55% equity", T.amber], ["Streak", "2 rising months", T.text], ["Forward check", "3 months", T.text], ["Log cadence", "1st of month", T.text]].map(([l, v, c]) => (
                    <div key={l} style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: T.textMuted }}>{l}</span>
                      <span style={{ fontWeight: 700, color: c }}>{v}</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                    <button onClick={() => setActiveTab("stress")} style={{ background: "none", border: "none", color: T.rose, fontSize: 11, fontWeight: 600, fontFamily: "inherit", padding: 0, cursor: "pointer", display: "block", marginBottom: 4 }}>
                      🛡️ Run Stress Test
                    </button>
                    <button onClick={() => setActiveTab("help")} style={{ background: "none", border: "none", color: T.blue, fontSize: 11, fontWeight: 600, fontFamily: "inherit", padding: 0, cursor: "pointer" }}>
                      → Full definitions & instructions
                    </button>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeTab === "modeler" && <BillModelerTab latest={latest} settings={fullSettings} />}
        {activeTab === "bills" && <BillTrackerTab billItems={billItems} setBillItems={setBillItems} saveBills={saveBills} latest={latest} settings={fullSettings} />}
        {activeTab === "stress" && <StressTestTab latest={latest} settings={fullSettings} />}

        {activeTab === "metrics" && (
          <div>
            {!latest ? <Card><div style={{ textAlign: "center", padding: 48, color: T.textMuted }}>Log your first month to see metrics.</div></Card> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <Card>
                  <SectionLabel>DIVIDEND SNOWBALL</SectionLabel>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(computed.length, 6)}, 1fr)`, gap: 12 }}>
                    {computed.slice(-6).map((e, i) => {
                      const dd = new Date(e.date + "-01");
                      return (
                        <div key={i} style={{ textAlign: "center", padding: "16px 12px", background: T.surfaceAlt, borderRadius: T.radiusSm, border: `1px solid ${T.borderLight}` }}>
                          <div style={{ fontSize: 11, color: T.textMuted, fontWeight: 600, marginBottom: 8, display: "flex", justifyContent: "center", gap: 6, alignItems: "center" }}>
                            {dd.toLocaleDateString("en-US", { month: "short", year: "2-digit" })}
                            <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 20, background: e.actualDivs !== null ? T.greenBg : T.amberBg, color: e.actualDivs !== null ? T.green : T.amber, border: `1px solid ${e.actualDivs !== null ? T.greenBorder : T.amberBorder}` }}>{e.actualDivs !== null ? "ACTUAL" : "EST"}</span>
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: T.green, fontFamily: "'Lora', serif" }}>{fmt$(e.effectiveDivs)}</div>
                          <div style={{ fontSize: 10, color: T.textMuted }}>per month</div>
                          {e.divGrowth !== null && <div style={{ fontSize: 12, fontWeight: 700, color: e.divGrowth >= 0 ? T.green : T.red, marginTop: 8 }}>{e.divGrowth >= 0 ? "+" : ""}{fmt$(e.divGrowth)}/mo</div>}
                          <div style={{ fontSize: 10, color: T.textMuted, marginTop: 4 }}>{fmt$(e.effectiveDivs * 12)}/yr</div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
                  {[
                    {
                      title: "PORTFOLIO YIELD",
                      main: fmtPct(latest.actualYield, 1), mainColor: latest.actualYield >= 0.20 ? T.green : T.amber,
                      sub: "blended annual yield on gross",
                      rows: [{ l: "Target", v: fmtPct(effectiveYield, 1), c: T.textSub }, { l: "Actual", v: fmtPct(latest.actualYield, 1), c: latest.actualYield >= effectiveYield * 0.95 ? T.green : T.amber }, { l: "Variance", v: (latest.actualYield >= effectiveYield ? "+" : "") + fmtPct(latest.actualYield - effectiveYield, 1), c: latest.actualYield >= effectiveYield ? T.green : T.red }]
                    },
                    {
                      title: "MARGIN EFFICIENCY",
                      main: (effectiveYield / settings.marginRate).toFixed(2) + "x", mainColor: T.indigo,
                      sub: "yield ÷ margin rate",
                      rows: [{ l: "Yield", v: fmtPct(effectiveYield, 1), c: T.green }, { l: "Margin rate", v: fmtPct(settings.marginRate, 2), c: T.red }, { l: "Net spread", v: "+" + fmtPct(effectiveYield - settings.marginRate, 1), c: T.green }]
                    },
                    {
                      title: "EQUITY MOMENTUM",
                      main: equityMomAvg !== null ? (equityMomAvg > 0 ? "+" : "") + fmtPct(equityMomAvg, 1) + "/mo" : "—", mainColor: equityMomAvg !== null ? (equityMomAvg > 0 ? T.green : T.red) : T.textMuted,
                      sub: "3-month average equity change",
                      rows: monthsToTrigger ? [{ l: "At this pace", v: `60% in ~${monthsToTrigger}mo`, c: T.blue }] : [{ l: "Status", v: cond1 ? "Above trigger ✓" : "Below trigger", c: cond1 ? T.green : T.amber }]
                    },
                    {
                      title: "MONTHLY INTEREST COST",
                      main: fmt$(latest.interestCost), mainColor: T.red,
                      sub: `at ${fmtPct(settings.marginRate, 2)} annual rate`,
                      rows: [{ l: "Margin balance", v: fmt$(latest.margin), c: T.textSub }, { l: "Annual cost", v: fmt$(latest.interestCost * 12), c: T.red }, { l: "Divs cover it?", v: latest.effectiveDivs > latest.interestCost ? "Yes ✓" : "Not yet", c: latest.effectiveDivs > latest.interestCost ? T.green : T.red }]
                    },
                    {
                      title: "NET MARGIN DRAW",
                      main: fmt$(latest.netDraw), mainColor: latest.netDraw > 0 ? T.red : T.green,
                      sub: latest.netDraw > 0 ? "added to margin this month" : "dividends covering all bills",
                      rows: [{ l: "Bills", v: "-" + fmt$(latest.bills), c: T.red }, { l: "Dividends", v: "+" + fmt$(latest.effectiveDivs), c: T.green }, { l: "Net draw", v: fmt$(latest.netDraw), c: latest.netDraw > 0 ? T.red : T.green }]
                    },
                    {
                      title: "MILESTONES",
                      main: fmt$(totalDivsReceived), mainColor: T.green,
                      sub: `all-time dividends across ${entries.length} months`,
                      rows: [{ l: "Freedom Date", v: freedomDate || "—", c: T.indigo }, { l: "Months away", v: freedomMonths ? String(freedomMonths) : "—", c: T.indigo }, { l: "Bills covered", v: fmtPct(latest.coverage, 1), c: latest.coverage >= 1 ? T.green : T.amber }]
                    },
                  ].map(({ title, main, mainColor, sub, rows }) => (
                    <Card key={title}>
                      <SectionLabel>{title}</SectionLabel>
                      <div style={{ fontSize: 40, fontWeight: 700, color: mainColor, fontFamily: "'Lora', serif", lineHeight: 1 }}>{main}</div>
                      <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, marginBottom: 14 }}>{sub}</div>
                      {rows.map(({ l, v, c }) => (
                        <div key={l} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 0", borderBottom: `1px solid ${T.borderLight}` }}>
                          <span style={{ color: T.textMuted }}>{l}</span><span style={{ fontWeight: 700, color: c }}>{v}</span>
                        </div>
                      ))}
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "log" && (
          <Card className={pulse ? "pulse" : ""}>
            <SectionLabel action={<button onClick={() => setShowAdd(true)} style={{ padding: "7px 18px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>+ Log Month</button>}>
              MONTHLY LOG — {entries.length} ENTRIES
            </SectionLabel>
            {computed.length === 0 ? (
              <div style={{ textAlign: "center", padding: 48, color: T.textMuted }}>No entries yet. Log your first month to begin tracking.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${T.border}` }}>
                      {["Date", "Gross", "Margin", "Net", "Equity", "Divs / Mo", "Type", "Net Draw", "Coverage", ""].map(h => (
                        <th key={h} style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: "1px", color: T.textMuted }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {computed.map((e, i) => (
                      <tr key={i} style={{ borderBottom: `1px solid ${T.borderLight}` }}
                        onMouseEnter={ev => ev.currentTarget.style.background = T.surfaceAlt}
                        onMouseLeave={ev => ev.currentTarget.style.background = "transparent"}>
                        <td style={{ padding: "11px 12px", color: T.textSub, fontWeight: 600 }}>{new Date(e.date + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}</td>
                        <td style={{ padding: "11px 12px" }}>{fmt$(e.gross)}</td>
                        <td style={{ padding: "11px 12px" }}>{fmt$(e.margin)}</td>
                        <td style={{ padding: "11px 12px", fontWeight: 600 }}>{fmt$(e.gross - e.margin)}</td>
                        <td style={{ padding: "11px 12px" }}>
                          <span style={{ fontWeight: 700, color: eqColor(e.equity) }}>{fmtPct(e.equity)}</span>
                          {e.rising !== null && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: e.rising ? T.green : T.red }}>{e.rising ? "▲" : "▼"}</span>}
                        </td>
                        <td style={{ padding: "11px 12px", color: T.green, fontWeight: 600 }}>
                          {fmt$(e.effectiveDivs)}
                          {e.divGrowth !== null && <span style={{ fontSize: 10, color: e.divGrowth >= 0 ? T.green : T.red, marginLeft: 6 }}>{e.divGrowth >= 0 ? "+" : ""}{fmt$(e.divGrowth)}</span>}
                        </td>
                        <td style={{ padding: "11px 12px" }}>
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: e.actualDivs !== null ? T.greenBg : T.amberBg, color: e.actualDivs !== null ? T.green : T.amber, border: `1px solid ${e.actualDivs !== null ? T.greenBorder : T.amberBorder}` }}>
                            {e.actualDivs !== null ? "ACTUAL" : "EST"}
                          </span>
                        </td>
                        <td style={{ padding: "11px 12px", color: e.netDraw > 0 ? T.red : T.green, fontWeight: 600 }}>{fmt$(e.netDraw)}</td>
                        <td style={{ padding: "11px 12px", color: e.coverage >= 1 ? T.green : T.textSub }}>{fmtPct(e.coverage, 1)}</td>
                        <td style={{ padding: "11px 12px" }}>
                          <button onClick={() => handleDelete(i)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.textMuted, borderRadius: T.radiusXs, padding: "3px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {activeTab === "settings" && <SettingsTab settings={fullSettings} setSettings={setSettings} derivedYield={derivedYield} hasActualData={entries.some(e => e.actualDivs != null && e.actualDivs !== "")} />}
        {activeTab === "help" && <HelpPage />}
      </div>

      {/* Log Modal */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(28,25,23,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16, backdropFilter: "blur(4px)" }} onClick={() => setShowAdd(false)}>
          <div style={{ background: T.surface, borderRadius: T.radius, boxShadow: T.shadowHover, padding: 32, width: 440, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.text, fontFamily: "'Lora', serif", marginBottom: 4 }}>Log This Month</div>
            <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 24 }}>Log on the 1st of each month for accurate streak tracking</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
              <Input label="MONTH" type="month" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Input label="GROSS PORTFOLIO ($)" value={form.gross} onChange={e => setForm(f => ({ ...f, gross: e.target.value }))} placeholder="e.g. 8,490.76" />
                <Input label="MARGIN BALANCE ($)" value={form.margin} onChange={e => setForm(f => ({ ...f, margin: e.target.value }))} placeholder="e.g. 638.26" />
                <Input label="W2 DEPOSIT / MO ($)" value={form.w2} onChange={e => setForm(f => ({ ...f, w2: e.target.value }))} placeholder="e.g. 871" />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 5 }}>BILLS FLOATED / MO ($)</div>
                  <input value={form.bills} onChange={e => setForm(f => ({ ...f, bills: e.target.value }))} placeholder="e.g. 801"
                    style={{ width: "100%", padding: "10px 13px", background: T.surfaceAlt, border: `1.5px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, color: T.text, fontFamily: "inherit", outline: "none" }} />
                  {floatedBillsTotal > 0 && (
                    <div style={{ marginTop: 4, fontSize: 10, color: T.green, cursor: "pointer" }} onClick={() => setForm(f => ({ ...f, bills: String(floatedBillsTotal) }))}>
                      ↑ Use Bill Tracker total: {fmt$(floatedBillsTotal, 0)}/mo
                    </div>
                  )}
                </div>
              </div>
              <Input label="ACTUAL DIVIDENDS RECEIVED ($)" hint="optional" value={form.actualDivs} onChange={e => setForm(f => ({ ...f, actualDivs: e.target.value }))} placeholder="e.g. 77.46 — from E-Trade Activity → Dividends" accent />
            </div>
            <div style={{ background: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "12px 14px", marginBottom: 20, fontSize: 11, color: T.textMuted, lineHeight: 1.7 }}>
              <strong style={{ color: T.text }}>Gross + Margin</strong> → E-Trade account summary &nbsp;·&nbsp; <strong style={{ color: T.green }}>Actual Dividends</strong> → Accounts → Activity → Dividends
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={handleAdd} style={{ flex: 1, padding: "12px", background: T.text, color: "#fff", border: "none", borderRadius: T.radiusXs, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>Save Entry</button>
              <button onClick={() => setShowAdd(false)} style={{ padding: "12px 20px", background: "transparent", color: T.textSub, border: `1px solid ${T.border}`, borderRadius: T.radiusXs, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showQC && <QuickCheckModal onClose={() => setShowQC(false)} latest={latest} settings={fullSettings} />}
    </div>
  );
}
