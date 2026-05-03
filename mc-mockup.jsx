import { useState } from "react";

const STATES = {
  investigating: {
    label: "INVESTIGATING",
    pattern: null,
    triggered: true,
    trigger_period: 3,
    trigger_clock: "8:42",
    trigger_margin: 7,
    trigger_floor: 0.88,
    trigger_xgb: 0.926,
    current_mc: 0.382,
    ctrl_team: "ORL",
    verdicts: ["INV", "INV", "INV"],
  },
  clean: {
    label: "COLLAPSE",
    pattern: "CLEAN",
    triggered: true,
    trigger_period: 3,
    trigger_clock: "8:42",
    trigger_margin: 3,
    trigger_floor: 0.88,
    trigger_xgb: 0.926,
    current_mc: 0.042,
    ctrl_team: "ORL",
    verdicts: ["INV", "INV", "CONT", "CONT", "LIKELY", "LIKELY", "CONF", "CONF", "CONF"],
  },
  wave: {
    label: "OSCILLATING",
    pattern: "WAVE",
    triggered: true,
    trigger_period: 3,
    trigger_clock: "8:42",
    trigger_margin: 5,
    trigger_floor: 0.82,
    trigger_xgb: 0.871,
    current_mc: 0.317,
    ctrl_team: "BOS",
    verdicts: ["INV", "CONT", "LIKELY", "CONF", "CONF", "NORM", "NORM", "CONT", "LIKELY", "CONF"],
  },
  normalized: {
    label: "CLEARED",
    pattern: "NORMALIZED",
    triggered: true,
    trigger_period: 3,
    trigger_clock: "8:42",
    trigger_margin: 9,
    trigger_floor: 0.79,
    trigger_xgb: 0.845,
    current_mc: 0.71,
    ctrl_team: "DEN",
    cleared_clock: "2:15",
    verdicts: ["INV", "INV", "CONT", "CONT", "NORM", "NORM", "NORM"],
  },
};

const TEAM_COLORS = {
  ORL: "#0077C0", BOS: "#007A33", DEN: "#0E2240", PHI: "#006BB6",
  LAL: "#552583", MIA: "#98002E", CLE: "#860038", GSW: "#1D428A",
};

const VERDICT_STYLES = {
  INV:    { bg: "rgba(148,163,184,0.25)", border: "rgba(148,163,184,0.4)", hollow: true },
  CONT:   { bg: "#F5B544", border: "#F5B544", hollow: false },
  LIKELY: { bg: "#F87171", border: "#F87171", hollow: false },
  CONF:   { bg: "#ef4444", border: "#ef4444", hollow: false },
  NORM:   { bg: "rgba(52,211,153,0.25)", border: "#34D399", hollow: true },
};

function VerdictDot({ verdict, size = 8 }) {
  const s = VERDICT_STYLES[verdict] || VERDICT_STYLES.INV;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: s.hollow ? "transparent" : s.bg,
        border: `1.5px solid ${s.border}`,
        flexShrink: 0,
      }}
      title={verdict}
    />
  );
}

function MCMeter({ value, color }) {
  return (
    <div style={{
      height: 4, background: "rgba(148,163,184,0.12)", borderRadius: 2,
      overflow: "hidden", marginTop: 4, width: "100%",
    }}>
      <div style={{
        height: "100%", width: `${Math.max(2, value * 100)}%`,
        background: color, borderRadius: 2,
        transition: "width 0.4s ease",
      }} />
    </div>
  );
}

function MCStrip({ state, animate }) {
  const mc = state;
  const pattern = mc.pattern;
  const teamColor = TEAM_COLORS[mc.ctrl_team] || "#94a3b8";

  // Style config per pattern
  let stripBg, stripBorder, badgeColor, badgeBg, badgeBorder, mcColor, icon;
  if (pattern === "CLEAN") {
    stripBg = "rgba(248,113,113,0.06)";
    stripBorder = "rgba(248,113,113,0.22)";
    badgeColor = "#F87171"; badgeBg = "rgba(248,113,113,0.14)"; badgeBorder = "rgba(248,113,113,0.22)";
    mcColor = "#F87171"; icon = "▼";
  } else if (pattern === "WAVE") {
    stripBg = "rgba(245,181,68,0.06)";
    stripBorder = "rgba(245,181,68,0.22)";
    badgeColor = "#F5B544"; badgeBg = "rgba(245,181,68,0.14)"; badgeBorder = "rgba(245,181,68,0.22)";
    mcColor = "#F5B544"; icon = "◈";
  } else if (pattern === "NORMALIZED") {
    stripBg = "rgba(52,211,153,0.03)";
    stripBorder = "rgba(52,211,153,0.18)";
    badgeColor = "#34D399"; badgeBg = "rgba(52,211,153,0.14)"; badgeBorder = "rgba(52,211,153,0.22)";
    mcColor = "#34D399"; icon = "✓";
  } else {
    // INVESTIGATING
    stripBg = "rgba(245,181,68,0.03)";
    stripBorder = "rgba(148,163,184,0.15)";
    badgeColor = "#F5B544"; badgeBg = "rgba(245,181,68,0.14)"; badgeBorder = "rgba(245,181,68,0.22)";
    mcColor = "#F5B544"; icon = "◉";
  }

  const marginLabel = mc.trigger_margin <= 3 ? "tight" : mc.trigger_margin <= 8 ? "mid" : mc.trigger_margin <= 15 ? "comf" : "blow";
  const marginPrec = mc.trigger_margin <= 3 ? "81%" : mc.trigger_margin <= 8 ? "72%" : mc.trigger_margin <= 15 ? "63%" : "—";

  return (
    <div style={{
      padding: "10px 12px", background: stripBg,
      border: `1px solid ${stripBorder}`, borderRadius: 8,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: pattern === "NORMALIZED" ? 6 : 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            color: badgeColor, fontSize: 11,
            ...(animate && !pattern ? {
              animation: "pulse 1.8s ease-in-out infinite",
            } : {}),
          }}>{icon}</span>
          <span style={{
            fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
            fontSize: 9.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
            padding: "3px 8px", borderRadius: 20,
            color: badgeColor, background: badgeBg, border: `1px solid ${badgeBorder}`,
          }}>
            {mc.label}
          </span>
        </div>
        <span style={{ fontSize: 9.5, color: "rgba(148,163,184,0.6)" }}>
          {pattern === "NORMALIZED"
            ? `Q${mc.trigger_period} ${mc.trigger_clock} → Q${mc.trigger_period} ${mc.cleared_clock || "2:15"}`
            : `since Q${mc.trigger_period} ${mc.trigger_clock} · +${mc.trigger_margin}`
          }
        </span>
      </div>

      {/* NORMALIZED: compact single-line */}
      {pattern === "NORMALIZED" ? (
        <div style={{
          fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
          fontSize: 11, color: "rgba(148,163,184,0.7)", lineHeight: 1.5,
        }}>
          MC investigated structural shift — rates recovered. Hold validated.
        </div>
      ) : (
        <>
          {/* Body: MC value + verdict timeline */}
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "start" }}>
            {/* MC win prob cell */}
            <div style={{
              padding: "6px 10px", background: "rgba(15,23,42,0.4)",
              borderRadius: 6, minWidth: 72, border: "1px solid rgba(148,163,184,0.08)",
            }}>
              <div style={{ fontSize: 8, color: "rgba(148,163,184,0.5)", marginBottom: 2, letterSpacing: "0.08em",
                fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif", fontWeight: 600,
              }}>MC</div>
              <div style={{
                fontSize: 16, fontWeight: 500, color: mcColor,
                fontFeatureSettings: '"tnum"',
              }}>
                {(mc.current_mc * 100).toFixed(1)}%
              </div>
              <MCMeter value={mc.current_mc} color={mcColor} />
            </div>

            {/* Verdict timeline */}
            <div style={{ paddingTop: 2 }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                {mc.verdicts.map((v, i) => (
                  <VerdictDot key={i} verdict={v} />
                ))}
                {/* Placeholder dots for investigating */}
                {!pattern && [0,1,2].map(i => (
                  <div key={`ph-${i}`} style={{
                    width: 8, height: 8, borderRadius: 999,
                    border: "1px dashed rgba(148,163,184,0.15)",
                  }} />
                ))}
              </div>
              {/* Verdict labels */}
              <div style={{
                display: "flex", gap: 4, flexWrap: "wrap",
                fontSize: 7.5, color: "rgba(148,163,184,0.35)", letterSpacing: "0.04em",
              }}>
                {mc.verdicts.map((v, i) => (
                  <span key={i} style={{ width: 8, textAlign: "center", flexShrink: 0 }}>
                    {i === 0 || mc.verdicts[i - 1] !== v ? v.substring(0, 1) : ""}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Context line for CLEAN */}
          {pattern === "CLEAN" && (
            <div style={{
              marginTop: 8, fontSize: 9, color: "rgba(148,163,184,0.5)",
              borderTop: "1px solid rgba(148,163,184,0.08)", paddingTop: 6,
            }}>
              XGB: {Math.round(mc.trigger_xgb * 100)}% · Margin: +{mc.trigger_margin} → {marginLabel} ({marginPrec})
              {mc.trigger_margin <= 3 && <span style={{ color: "#F87171", marginLeft: 4 }}>⚡ highest conviction</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Fake game card wrapper to give context
function GameCard({ children, away, home, awayPts, homePts, period, clock }) {
  return (
    <div style={{
      background: "rgba(15,23,42,0.6)", borderRadius: 12,
      border: "1px solid rgba(148,163,184,0.08)",
      overflow: "hidden", maxWidth: 380,
    }}>
      {/* Mini hero */}
      <div style={{
        padding: "12px 16px 10px", display: "flex", alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid rgba(148,163,184,0.06)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
            fontSize: 13, fontWeight: 600, color: TEAM_COLORS[away] || "#94a3b8",
          }}>{away}</span>
          <span style={{
            fontFamily: "'SF Mono', monospace", fontSize: 16, fontWeight: 500,
            color: "rgba(226,232,240,0.9)", fontFeatureSettings: '"tnum"',
          }}>{awayPts}—{homePts}</span>
          <span style={{
            fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
            fontSize: 13, fontWeight: 600, color: TEAM_COLORS[home] || "#94a3b8",
          }}>{home}</span>
        </div>
        <span style={{
          fontFamily: "'SF Mono', monospace", fontSize: 9, color: "rgba(148,163,184,0.5)",
          letterSpacing: "0.06em",
        }}>
          LIVE · Q{period} {clock}
        </span>
      </div>

      {/* Floor row stub */}
      <div style={{ padding: "10px 16px 6px" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 4,
        }}>
          <span style={{
            fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
            fontSize: 9, fontWeight: 600, letterSpacing: "0.1em",
            textTransform: "uppercase", color: "rgba(148,163,184,0.4)",
          }}>Structural Read</span>
        </div>
      </div>

      {/* MC Strip */}
      <div style={{ padding: "0 16px 14px" }}>
        {children}
      </div>
    </div>
  );
}

export default function MCMockup() {
  const [activeState, setActiveState] = useState("clean");

  const tabs = [
    { key: "investigating", label: "Investigating" },
    { key: "clean", label: "Collapse" },
    { key: "wave", label: "Oscillating" },
    { key: "normalized", label: "Cleared" },
  ];

  const scenarios = {
    investigating: { away: "DET", home: "ORL", awayPts: 68, homePts: 75, period: 3, clock: "5:18" },
    clean: { away: "DET", home: "ORL", awayPts: 88, homePts: 85, period: 4, clock: "4:31" },
    wave: { away: "PHI", home: "BOS", awayPts: 91, homePts: 94, period: 4, clock: "6:02" },
    normalized: { away: "MIA", home: "DEN", awayPts: 72, homePts: 81, period: 3, clock: "2:15" },
  };

  const sc = scenarios[activeState];
  const state = STATES[activeState];

  return (
    <div style={{
      minHeight: "100vh", background: "#0B1120",
      padding: "24px 16px",
      fontFamily: "'SF Mono', 'Fira Code', monospace",
    }}>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {/* Title */}
      <div style={{
        fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
        fontSize: 11, fontWeight: 600, letterSpacing: "0.12em",
        textTransform: "uppercase", color: "rgba(148,163,184,0.4)",
        marginBottom: 16, textAlign: "center",
      }}>
        MC Investigation Strip — Dashboard Mockup
      </div>

      {/* State tabs */}
      <div style={{
        display: "flex", gap: 6, justifyContent: "center",
        marginBottom: 24, flexWrap: "wrap",
      }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveState(t.key)}
            style={{
              fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
              fontSize: 11, fontWeight: 600, padding: "6px 14px",
              borderRadius: 20, cursor: "pointer",
              border: `1px solid ${activeState === t.key ? "rgba(52,211,153,0.22)" : "rgba(148,163,184,0.12)"}`,
              background: activeState === t.key ? "rgba(52,211,153,0.1)" : "transparent",
              color: activeState === t.key ? "#34D399" : "rgba(148,163,184,0.5)",
              transition: "all 0.15s ease",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Card */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <GameCard {...sc}>
          <MCStrip state={state} animate={activeState === "investigating"} />
        </GameCard>
      </div>

      {/* Legend */}
      <div style={{
        marginTop: 24, display: "flex", justifyContent: "center",
        gap: 16, flexWrap: "wrap",
      }}>
        {[
          { v: "INV", label: "Insufficient" },
          { v: "CONT", label: "Contested" },
          { v: "LIKELY", label: "Likely" },
          { v: "CONF", label: "Confirmed" },
          { v: "NORM", label: "Recovered" },
        ].map(item => (
          <div key={item.v} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <VerdictDot verdict={item.v} />
            <span style={{
              fontFamily: "'Inter', 'SF Pro', -apple-system, sans-serif",
              fontSize: 9, color: "rgba(148,163,184,0.4)",
            }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
