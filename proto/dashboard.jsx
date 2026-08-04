// Dashboard — KPIs + tabs por tipo + subcat pills + chart + heatmap + tabla editable

// ============================================================
// Selectors / aggregators
// ============================================================
function selectFilteredRecords(state) {
  const { sucursal, period, typeTab, subcat, estado } = state.dashFilters;
  const monthKeys = new Set(periodToMonthKeys(period));
  return state.records.filter(r => {
    if (estado === "activa" && r.estado === "eliminada") return false;
    if (estado === "eliminada" && r.estado !== "eliminada") return false;
    // estado === "all" → don't filter by estado
    if (sucursal !== "all" && r.sucursal !== sucursal) return false;
    const mk = r.date.slice(0, 7);
    if (!monthKeys.has(mk)) return false;
    if (typeTab !== "all" && r.type !== typeTab) return false;
    if (typeTab === r.type && subcat !== "all" && r.subcat !== subcat) return false;
    return true;
  });
}

// Records eliminadas NEVER count in totals, charts or KPIs — even if the user is
// viewing them via the "Todas" filter. The detail table is the only place that can
// show them.
function isInScope(r, state, { ignoreSubcat = false } = {}) {
  if (r.estado === "eliminada") return false;
  const { sucursal, typeTab, subcat } = state.dashFilters;
  if (sucursal !== "all" && r.sucursal !== sucursal) return false;
  if (typeTab !== "all" && r.type !== typeTab) return false;
  if (!ignoreSubcat && typeTab === r.type && subcat !== "all" && r.subcat !== subcat) return false;
  return true;
}

function kpiAggregates(state) {
  // Aggregators always exclude eliminada records — even if the user is viewing
  // them via the "Todas" / "Solo eliminadas" filter. They're never counted in totals.
  const filtered = selectFilteredRecords(state).filter(r => r.estado !== "eliminada");
  const curMonth = CURRENT_MONTH_KEY;
  const curMonthRecs = filtered.filter(r => r.date.startsWith(curMonth));
  const prevMonth = PREV_MONTH_KEY;
  // For "vs prev" we always look at same scope but prev month
  const allInScope = state.records.filter(r => {
    if (r.estado === "eliminada") return false;
    const { sucursal, typeTab, subcat } = state.dashFilters;
    if (sucursal !== "all" && r.sucursal !== sucursal) return false;
    if (typeTab !== "all" && r.type !== typeTab) return false;
    if (typeTab === r.type && subcat !== "all" && r.subcat !== subcat) return false;
    return true;
  });
  const prevMonthRecs = allInScope.filter(r => r.date.startsWith(prevMonth));

  const sumQty = arr => arr.reduce((a, r) => a + (r.cantidad || 0), 0);
  const sumCost = arr => arr.reduce((a, r) => a + (r.costo || 0), 0);

  const qtyCur = sumQty(curMonthRecs);
  const qtyPrev = sumQty(prevMonthRecs);
  const qtyDelta = qtyPrev > 0 ? ((qtyCur - qtyPrev) / qtyPrev) * 100 : 0;

  const costCur = sumCost(curMonthRecs);
  const costPrev = sumCost(prevMonthRecs);
  const costDelta = costPrev > 0 ? ((costCur - costPrev) / costPrev) * 100 : 0;

  // Sucursales reportadas (en periodo)
  const sucReporting = new Set(filtered.map(r => r.sucursal));

  return {
    qtyCur, qtyDelta,
    costCur, costDelta,
    sucCount: sucReporting.size,
    totalSuc: activeSucNames(state).length,
    recordsInPeriod: filtered.length,
  };
}

// ---- Unit helpers (combustible mixed-unit split) -----------------------
const FUEL_UNIT_CATEGORY = {
  L: "Volumen", gal: "Volumen", "m³": "Volumen",
  kg: "Masa", t: "Masa",
  kWh: "Energía",
};
function unitOfSubcat(type, subId) {
  if (type !== "combustible") return TYPES[type]?.unit || "";
  const c = (typeof FUEL_SUBCATS_CATALOG !== "undefined") ? FUEL_SUBCATS_CATALOG[subId] : null;
  return c ? c.defaultUnit : "";
}
function unitBlockLabel(unit) {
  const cat = FUEL_UNIT_CATEGORY[unit];
  return cat ? cat + " · " + unit : unit;
}

// Aggregate filtered records by (subcat, month) — for multi-line chart.
// When typeTab=combustible AND subcat=all AND active subcats span multiple units,
// returns { mixed: true, blocks: [{ unit, label, series }, ...] }.
// Otherwise: { mixed: false, months, series, unit }.
function chartDataByMonthAndSubcat(state) {
  const { typeTab, period, subcat } = state.dashFilters;
  const monthKeys = periodToMonthKeys(period);
  const type = TYPES[typeTab];
  const subs = getSubcatsFor(state, typeTab);

  const { sucursal } = state.dashFilters;
  const recs = state.records.filter(r => {
    if (r.estado === "eliminada") return false;
    if (r.type !== typeTab) return false;
    if (sucursal !== "all" && r.sucursal !== sucursal) return false;
    const mk = r.date.slice(0, 7);
    if (!monthKeys.includes(mk)) return false;
    return true;
  });

  const COLORS = [type.color, "var(--rl-primary-900)", "var(--rl-success-600)", "var(--rl-error-500)", "var(--rl-warning-700)", "var(--rl-gray-700)"];
  const buildSeries = (subList) => {
    if (subList.length === 0) {
      return [{
        key: typeTab, label: type.label,
        color: type.color,
        data: monthKeys.map(mk => recs.filter(r => r.date.startsWith(mk)).reduce((a, r) => a + r.cantidad, 0)),
      }];
    }
    return subList.map((sub, i) => ({
      key: sub.id, label: sub.label, unit: unitOfSubcat(typeTab, sub.id),
      color: COLORS[i % COLORS.length],
      dashed: i >= COLORS.length,
      data: monthKeys.map(mk =>
        recs.filter(r => r.date.startsWith(mk) && r.subcat === sub.id).reduce((a, r) => a + r.cantidad, 0)
      ),
    }));
  };

  if (typeTab === "combustible" && subcat === "all") {
    const unitsBySub = subs.map(s => ({ sub: s, unit: unitOfSubcat("combustible", s.id) })).filter(x => x.unit);
    const uniqUnits = [...new Set(unitsBySub.map(x => x.unit))];
    if (uniqUnits.length > 1) {
      const blocks = uniqUnits.map(u => {
        const subList = unitsBySub.filter(x => x.unit === u).map(x => x.sub);
        return { unit: u, label: unitBlockLabel(u), series: buildSeries(subList) };
      });
      return { mixed: true, months: monthKeys, blocks };
    }
  }

  // Subcat específica (o tipo no-combustible): una sola serie con la unidad
  // que corresponde a esa subcat. Antes usaba `subs` (todas) + type.unit, lo
  // que mezclaba líneas de otras subcats y mostraba la unidad por defecto.
  const selSubs = subcat === "all" ? subs : subs.filter(s => s.id === subcat);
  const unit = (typeTab === "combustible" && subcat !== "all")
    ? unitOfSubcat("combustible", subcat)
    : type.unit;
  return { mixed: false, months: monthKeys, series: buildSeries(selSubs), unit };
}

// Heatmap data: row=sucursal, col=month, value=qty for active type+subcat+period.
// Same mixed-unit split contract as chartDataByMonthAndSubcat.
function heatmapData(state) {
  const { typeTab, period, subcat } = state.dashFilters;
  const monthKeys = periodToMonthKeys(period);
  const baseRecs = state.records.filter(r => {
    if (r.estado === "eliminada") return false;
    if (r.type !== typeTab) return false;
    const mk = r.date.slice(0, 7);
    if (!monthKeys.includes(mk)) return false;
    if (subcat !== "all" && r.subcat !== subcat) return false;
    return true;
  });
  const buildRows = (recs) => activeSucNames(state).map(suc => ({
    suc,
    cells: monthKeys.map(mk => recs.filter(r => r.sucursal === suc && r.date.startsWith(mk)).reduce((a, r) => a + r.cantidad, 0)),
  }));

  if (typeTab === "combustible" && subcat === "all") {
    const subs = getSubcatsFor(state, typeTab);
    const unitsBySub = subs.map(s => ({ sub: s, unit: unitOfSubcat("combustible", s.id) })).filter(x => x.unit);
    const uniqUnits = [...new Set(unitsBySub.map(x => x.unit))];
    if (uniqUnits.length > 1) {
      const blocks = uniqUnits.map(u => {
        const subIds = unitsBySub.filter(x => x.unit === u).map(x => x.sub.id);
        const recs = baseRecs.filter(r => subIds.includes(r.subcat));
        return { unit: u, label: unitBlockLabel(u), months: monthKeys, rows: buildRows(recs) };
      });
      return { mixed: true, blocks };
    }
  }
  const unit = (typeTab === "combustible" && subcat !== "all")
    ? unitOfSubcat("combustible", subcat)
    : TYPES[typeTab].unit;
  return { mixed: false, months: monthKeys, rows: buildRows(baseRecs), unit };
}

// ============================================================
// Chart components
// ============================================================

// Catmull-Rom → cubic Bezier smoothing. tension ~0.2 = gentle curve, no overshoot.
function smoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  const t = 0.2;
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

const MultiLineChart = ({ months: monthArr, series, unit, h = 220 }) => {
  const w = 620;
  const padL = 44, padR = 16, padT = 18, padB = 30;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const n = monthArr.length;
  const allValues = series.flatMap(s => s.data);
  const yMax = Math.max(...allValues, 1);
  const sx = i => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const sy = y => padT + (1 - (y / yMax)) * innerH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => yMax * t);

  const [hoverIdx, setHoverIdx] = React.useState(null);
  const colW = n > 1 ? innerW / (n - 1) : innerW;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block", overflow: "visible" }}>
        {/* y grid */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => (
          <line key={i} x1={padL} x2={w - padR} y1={padT + t * innerH} y2={padT + t * innerH}
                stroke="var(--rl-gray-200)" strokeWidth="1" strokeDasharray={i === 4 ? "0" : "2 4"} />
        ))}
        {/* y labels */}
        {yTicks.map((v, i) => (
          <text key={i} x={padL - 8} y={sy(v) + 3} textAnchor="end" fontSize="10"
                fontFamily="var(--rl-font-display)" fill="var(--rl-gray-500)">
            {Math.round(v).toLocaleString("es-CL")}
          </text>
        ))}
        <text x={padL - 8} y={padT - 6} textAnchor="end" fontSize="10"
              fontFamily="var(--rl-font-display)" fill="var(--rl-gray-500)" fontWeight="700">{unit}</text>

        {/* x labels (months) */}
        {monthArr.map((mk, i) => {
          if (n > 6 && i % Math.ceil(n / 6) !== 0) return null;
          return (
            <text key={i} x={sx(i)} y={h - 10} textAnchor="middle" fontSize="10"
                  fontFamily="var(--rl-font-display)" fill="var(--rl-gray-500)">
              {monthLabelShort(mk)}
            </text>
          );
        })}

        {/* lines */}
        {series.map((s, si) => {
          const path = smoothPath(s.data.map((y, i) => [sx(i), sy(y)]));
          return (
            <g key={si}>
              <path d={path} fill="none" stroke={s.color} strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round"
                    strokeDasharray={s.dashed ? "6 4" : "0"} />
              {s.data.map((y, i) => (
                <circle key={i} cx={sx(i)} cy={sy(y)} r="3" fill="#FFFFFF" stroke={s.color} strokeWidth="2" />
              ))}
            </g>
          );
        })}

        {/* hover guide line + highlighted points */}
        {hoverIdx != null && (
          <g style={{ pointerEvents: "none" }}>
            <line x1={sx(hoverIdx)} x2={sx(hoverIdx)} y1={padT} y2={padT + innerH}
                  stroke="var(--rl-gray-500)" strokeWidth="1" strokeDasharray="3 3" />
            {series.map((s, si) => (
              <circle key={si} cx={sx(hoverIdx)} cy={sy(s.data[hoverIdx])} r="5"
                      fill={s.color} stroke="#FFFFFF" strokeWidth="2" />
            ))}
          </g>
        )}

        {/* invisible hover columns (must come last to capture events) */}
        {monthArr.map((mk, i) => (
          <rect key={"hover-" + i}
                x={sx(i) - colW / 2} y={padT}
                width={colW} height={innerH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{ cursor: "crosshair" }} />
        ))}
      </svg>

      {/* floating tooltip */}
      {hoverIdx != null && (
        <div style={{
          position: "absolute",
          left: ((sx(hoverIdx) / w) * 100) + "%",
          top: 0,
          transform: hoverIdx >= n / 2 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
          background: "var(--rl-gray-900, #111827)",
          color: "#fff",
          padding: "8px 10px",
          borderRadius: 8,
          font: "500 11px/1.4 var(--rl-font-body)",
          pointerEvents: "none",
          boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
          minWidth: 150,
          zIndex: 10,
          whiteSpace: "nowrap",
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, opacity: 0.85, textTransform: "capitalize" }}>
            {monthLabelShort(monthArr[hoverIdx])}
          </div>
          {series.map((s, si) => (
            <div key={si} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: s.color, flexShrink: 0 }} />
              <span style={{ flex: 1, opacity: 0.9 }}>{s.label}{s.unit && s.unit !== unit ? " (" + s.unit + ")" : ""}</span>
              <strong style={{ marginLeft: 8 }}>{fmtNum(s.data[hoverIdx])} {s.unit || unit}</strong>
            </div>
          ))}
        </div>
      )}
      {/* legend */}
      <div className="prt-row" style={{ flexWrap: "wrap", gap: 14, marginTop: 8, padding: "0 8px" }}>
        {series.map((s, i) => {
          const total = s.data.reduce((a, b) => a + b, 0);
          return (
            <div key={i} className="prt-row" style={{ gap: 6 }}>
              <span style={{
                display: "inline-block", width: 18, height: 0,
                borderTop: "2.5px " + (s.dashed ? "dashed" : "solid") + " " + s.color,
              }}></span>
              <span style={{ font: "600 12px/1 var(--rl-font-display)", color: "var(--rl-gray-800)" }}>{s.label}{s.unit ? " (" + s.unit + ")" : ""}</span>
              <span className="prt-hint" style={{ fontSize: 11 }}>· {fmtNum(total)} {s.unit || unit}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Heatmap = ({ months: monthArr, rows, color, unit }) => {
  const maxV = Math.max(1, ...rows.flatMap(r => r.cells));
  const cw = 38, ch = 26, pad = 4;
  const labW = 116;
  const w = labW + monthArr.length * cw + pad * 2;
  const h = 24 + rows.length * ch + pad * 2;

  const [hover, setHover] = React.useState(null); // { ri, ci, value }

  return (
    <div style={{ position: "relative" }}>
     <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
        {monthArr.map((mk, c) => (
          <text key={c} x={labW + c * cw + cw / 2} y={16} textAnchor="middle" fontSize="10"
                fontFamily="var(--rl-font-display)" fontWeight="700" fill="var(--rl-gray-500)">
            {monthLabelShort(mk).slice(0,3)}
          </text>
        ))}
        {rows.map((r, ri) => (
          <g key={ri}>
            <text x={labW - 8} y={24 + ri * ch + 16} textAnchor="end" fontSize="11"
                  fontFamily="var(--rl-font-display)" fontWeight="600" fill="var(--rl-gray-700)">{r.suc}</text>
            {r.cells.map((v, ci) => {
              const intensity = v === 0 ? 0 : Math.max(0.08, v / maxV);
              const isHover = hover && hover.ri === ri && hover.ci === ci;
              return (
                <rect key={ci} x={labW + ci * cw + 1} y={24 + ri * ch + 2}
                      width={cw - 2} height={ch - 4} rx="3"
                      fill={color} fillOpacity={intensity * 0.85 + (v > 0 ? 0.05 : 0)}
                      stroke={isHover ? "var(--rl-gray-900)" : "var(--rl-gray-100)"}
                      strokeWidth={isHover ? 1.5 : 0.5}
                      onMouseEnter={() => setHover({ ri, ci, value: v, suc: r.suc, month: monthArr[ci] })}
                      onMouseLeave={() => setHover(null)}
                      style={{ cursor: "pointer" }} />
              );
            })}
          </g>
        ))}
      </svg>
     </div>

      {hover && (
        <div style={{
          position: "absolute",
          left: ((labW + hover.ci * cw + cw / 2) / w) * 100 + "%",
          top: (24 + hover.ri * ch) / h * 100 + "%",
          transform: "translate(-50%, calc(-100% - 8px))",
          background: "var(--rl-gray-900, #111827)",
          color: "#fff",
          padding: "8px 10px",
          borderRadius: 8,
          font: "500 11px/1.4 var(--rl-font-body)",
          pointerEvents: "none",
          boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
          whiteSpace: "nowrap",
          zIndex: 10,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, opacity: 0.85 }}>{hover.suc}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0 }} />
            <span style={{ opacity: 0.9, textTransform: "capitalize" }}>{monthLabelShort(hover.month)}</span>
            <strong style={{ marginLeft: 8 }}>{fmtNum(hover.value)} {unit}</strong>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
// Sub-components
// ============================================================
const KpiCard = ({ label, value, unit, icon, color, bg, delta, deltaKind, sub, secondary, onClick, footer }) => (
  <div
    className={"prt-kpi" + (onClick ? " prt-kpi-clickable" : "")}
    onClick={onClick}
    role={onClick ? "button" : undefined}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
  >
    <div className="prt-kpi-head">
      <span className="prt-kpi-label">{label}</span>
      <span className="prt-kpi-ico" style={{ background: bg, color }}><Icon name={icon} size={22} /></span>
    </div>
    <div className="prt-kpi-value">
      <span>{value}</span>
      {unit && <span className="unit">{unit}</span>}
    </div>
    {secondary && (
      <div className="prt-hint" style={{ fontSize: 12, marginTop: 2 }}>{secondary}</div>
    )}
    {(delta != null || sub) && (
      <div className="prt-row" style={{ gap: 8, flexWrap: "wrap", marginTop: 4 }}>
        {delta != null && (
          <span className={"prt-kpi-delta " + (deltaKind || "neutral")}>
            <Icon name={deltaKind === "up" ? "trending_up" : deltaKind === "dn" ? "trending_down" : "trending_flat"} size={13} />
            {(delta > 0 ? "+" : "") + delta.toFixed(1) + "%"}
          </span>
        )}
        {sub && <span className="prt-hint" style={{ fontSize: 11 }}>{sub}</span>}
      </div>
    )}
    {footer && (
      <>
        <div className="prt-kpi-divider" />
        <div className="prt-kpi-footer">{footer}</div>
      </>
    )}
  </div>
);

const TypeTabs = () => {
  const { state, dispatch } = useApp();
  const active = state.dashFilters.typeTab;
  // compute totals per type for current period (for the sublabel)
  const monthKeys = new Set(periodToMonthKeys(state.dashFilters.period));
  const { sucursal } = state.dashFilters;
  const totals = {};
  Object.keys(TYPES).forEach(k => {
    const sum = state.records
      .filter(r => r.estado !== "eliminada" && r.type === k && monthKeys.has(r.date.slice(0,7)) && (sucursal === "all" || r.sucursal === sucursal))
      .reduce((a, r) => a + r.cantidad, 0);
    totals[k] = sum;
  });
  return (
    <div className="prt-type-tabs">
      {Object.values(TYPES).map(t => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            className={"prt-type-tab " + t.id + (isActive ? " active" : "")}
            onClick={() => dispatch({ type: "DASH/SET_FILTER", key: "typeTab", value: t.id })}
          >
            <span className="ico"><Icon name={t.icon} size={20} /></span>
            <div>
              <div className="lbl">{t.label}</div>
              <div className="sub">{fmtNum(totals[t.id])} {t.unit}</div>
            </div>
          </button>
        );
      })}
      {/* Botón Exportar oculto: sin funcionalidad por ahora. Reactivar cuando exista el exportable.
      <div style={{ marginLeft: "auto", paddingBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <Btn size="sm" icon="file_download">Exportar</Btn>
      </div>
      */}
    </div>
  );
};

const SubcatPills = () => {
  const { state, dispatch } = useApp();
  const { typeTab, subcat } = state.dashFilters;
  const subs = getSubcatsFor(state, typeTab);
  if (subs.length === 0) {
    return (
      <div className="prt-subcat-bar">
        <span className="prt-eyebrow" style={{ color: "var(--rl-gray-500)" }}>
          {TYPES[typeTab].label} no usa subcategorías.
        </span>
      </div>
    );
  }
  const color = TYPES[typeTab].color;
  return (
    <div className="prt-subcat-bar">
      <span className="prt-eyebrow" style={{ marginRight: 4 }}>Subcategoría</span>
      <button
        className={"prt-pill" + (subcat === "all" ? " active " + typeTab : "")}
        onClick={() => dispatch({ type: "DASH/SET_FILTER", key: "subcat", value: "all" })}
      >Todas</button>
      {subs.map(s => (
        <button
          key={s.id}
          className={"prt-pill" + (subcat === s.id ? " active " + typeTab : "")}
          onClick={() => dispatch({ type: "DASH/SET_FILTER", key: "subcat", value: s.id })}
        >{s.label}</button>
      ))}
      <button
        className="prt-pill dashed"
        onClick={() => {
          const label = window.prompt(`Nueva subcategoría para ${TYPES[typeTab].label}:`);
          if (!label) return;
          const id = label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          dispatch({ type: "SUBCAT/ADD", type: typeTab, id, label });
          dispatch({ type: "TOAST/SHOW", toast: {
            kind: "success", title: "Subcategoría creada",
            body: `"${label}" disponible en formularios y filtros.`,
          }});
        }}
      ><Icon name="add" size={12} /> Crear nueva</button>
      <span className="prt-hint" style={{ marginLeft: "auto", fontSize: 11 }}>
        Filtra gráfico y tabla. Comparables porque todas usan {TYPES[typeTab].unit}.
      </span>
    </div>
  );
};

const DashFilterBar = () => {
  const { state, dispatch } = useApp();
  const f = state.dashFilters;
  const set = (key, value) => dispatch({ type: "DASH/SET_FILTER", key, value });
  const custom = parseCustomPeriod(f.period);
  const isCustom = !!custom;
  const selValue = isCustom ? "custom" : f.period;
  // default custom range = the full 12-month window
  const defStart = months[0];
  const defEnd = CURRENT_MONTH_KEY;
  const onPeriodChange = (v) => {
    if (v === "custom") set("period", `custom:${defStart}:${defEnd}`);
    else set("period", v);
  };
  const setRange = (start, end) => set("period", `custom:${start}:${end}`);
  return (
    <div className="prt-row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
      <Select
        style={{ width: 220 }}
        value={f.sucursal}
        onChange={(v) => set("sucursal", v)}
        options={[
          { value: "all", label: `Todas las sucursales (${activeSucNames(state).length})` },
          ...activeSucNames(state).map(s => ({ value: s, label: s })),
        ]}
      />
      <Select
        style={{ width: 200 }}
        value={selValue}
        onChange={(v) => onPeriodChange(v)}
        options={[
          { value: "12m", label: "Últimos 12 meses" },
          { value: "6m",  label: "Últimos 6 meses" },
          { value: "3m",  label: "Últimos 3 meses" },
          { value: "1m",  label: periodLabel("1m") },
          { value: "custom", label: "Personalizado…" },
        ]}
      />
      {isCustom && (
        <div className="prt-row" style={{ gap: 6, alignItems: "center" }}>
          <input
            type="month"
            className="prt-input"
            style={{ width: 150 }}
            value={custom.start}
            max={custom.end && custom.end < CURRENT_MONTH_KEY ? custom.end : CURRENT_MONTH_KEY}
            onChange={e => e.target.value && setRange(e.target.value, custom.end)}
          />
          <span className="prt-hint" style={{ opacity: 0.7 }}>—</span>
          <input
            type="month"
            className="prt-input"
            style={{ width: 150 }}
            value={custom.end}
            min={custom.start}
            max={CURRENT_MONTH_KEY}
            onChange={e => e.target.value && setRange(custom.start, e.target.value)}
          />
        </div>
      )}
      <Btn size="sm" kind="ghost" icon="filter_alt_off" onClick={() => {
        set("sucursal", "all"); set("period", "12m"); set("subcat", "all");
      }}>Limpiar filtros</Btn>
    </div>
  );
};

const InsightCallout = () => null;

// ============================================================
// Recent records table — inline edit + undo
// ============================================================
const RecentTable = () => {
  const { state, dispatch } = useApp();
  const [editing, setEditing] = React.useState(null); // { id, field }
  const [confirmModal, setConfirmModal] = React.useState(null); // { action, rec }
  const allFiltered = selectFilteredRecords(state);

  // Ordenamiento click-to-sort. Defaults: por fecha descendente.
  const [sortKey, setSortKey] = React.useState("date");
  const [sortDir, setSortDir] = React.useState("desc");
  const NUMERIC_KEYS = new Set(["cantidad", "costo"]);
  const DATE_KEYS = new Set(["date"]);
  const toggleSort = (key) => {
    if (key === sortKey) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      // Numéricos y fecha → arrancan desc (más alto/reciente primero).
      setSortDir((NUMERIC_KEYS.has(key) || DATE_KEYS.has(key)) ? "desc" : "asc");
    }
  };
  const sortValueOf = (r) => {
    switch (sortKey) {
      case "date":     return r.date || "";
      case "sucursal": return r.sucursal || "";
      case "type":     return TYPES[r.type]?.label || r.type || "";
      case "subcat":   return r.subcat ? (subcatLabel(r.type, r.subcat) || r.subcat) : "";
      case "provider": return r.provider || "";
      case "cantidad": return Number(r.cantidad) || 0;
      case "costo":    return Number(r.costo) || 0;
      case "origen":   return r.origen || "";
      case "estado":   return r.estado || "";
      default:         return "";
    }
  };
  const sorted = React.useMemo(() => {
    const arr = [...allFiltered];
    const mult = sortDir === "asc" ? 1 : -1;
    arr.sort((a, b) => {
      const va = sortValueOf(a), vb = sortValueOf(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * mult;
      return String(va).localeCompare(String(vb), "es", { sensitivity: "base" }) * mult;
    });
    return arr;
  }, [allFiltered, sortKey, sortDir]);
  const PAGE_SIZE = 10;
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  React.useEffect(() => {
    if (page > totalPages - 1) setPage(0);
  }, [totalPages, page]);
  const currentPage = Math.min(page, totalPages - 1);
  const rows = sorted.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = sorted.length === 0 ? 0 : currentPage * PAGE_SIZE + 1;
  const rangeEnd = currentPage * PAGE_SIZE + rows.length;

  const handleDelete = (rec) => setConfirmModal({ action: "delete", rec });
  const handleRestore = (rec) => setConfirmModal({ action: "restore", rec });
  const confirmDelete = () => {
    const rec = confirmModal.rec;
    dispatch({ type: "DASH/DELETE_RECORD", id: rec.id });
    if (rec.origen === "sheets") {
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id: rec.id, field: "estado", value: "Eliminada" } })); } catch (e) {}
    }
    dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Registro eliminado", body: 'Se marcó como eliminado. Puedes restaurarlo desde el filtro "Solo eliminadas".' } });
    setConfirmModal(null);
  };
  const confirmRestore = () => {
    const rec = confirmModal.rec;
    dispatch({ type: "DASH/RESTORE_RECORD", id: rec.id });
    if (rec.origen === "sheets") {
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id: rec.id, field: "estado", value: "Activa" } })); } catch (e) {}
    }
    dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Registro restaurado", body: "El registro está activo y se incluye nuevamente en los cálculos." } });
    setConfirmModal(null);
  };

  const startEdit = (id, field) => setEditing({ id, field });
  const commitEdit = (id, field, value) => {
    const rec = state.records.find(r => r.id === id);
    if (!rec) { setEditing(null); return; }
    if (field === "cantidad" || field === "costo") {
      const parsed = parseFloat(value);
      if (isNaN(parsed) || rec[field] === parsed) { setEditing(null); return; }
      dispatch({ type: "DASH/EDIT_RECORD", id, patch: { [field]: parsed } });
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id, field, value: parsed } })); } catch(e) {}
      dispatch({ type: "TOAST/SHOW", toast: {
        kind: "success",
        title: field === "cantidad" ? "Cantidad actualizada" : "Costo actualizado",
        body: `${rec.sucursal} · ${TYPES[rec.type].label} · ${fmtMonth(rec.date)} · ${fmtNum(rec[field])} → ${fmtNum(parsed)}${field === "cantidad" ? " " + rec.unit : ""}`,
        undoAction: () => dispatch({ type: "DASH/UNDO_EDIT" }),
      }});
    } else if (field === "subcat") {
      if (rec.subcat === value) { setEditing(null); return; }
      dispatch({ type: "DASH/EDIT_RECORD", id, patch: { subcat: value || null } });
      const lbl = value ? subcatLabel(rec.type, value) : "";
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id, field: "subcat", value: lbl } })); } catch(e) {}
      dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Subcategoría actualizada", body: `${rec.sucursal} · ${TYPES[rec.type].label} · ${lbl || "—"}` } });
    } else if (field === "provider") {
      const v = String(value || "").trim();
      if (rec.provider === v) { setEditing(null); return; }
      dispatch({ type: "DASH/EDIT_RECORD", id, patch: { provider: v } });
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id, field: "provider", value: v } })); } catch(e) {}
      dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Proveedor actualizado", body: `${rec.sucursal} · ${TYPES[rec.type].label} · ${v || "—"}` } });
    } else if (field === "date") {
      // El editor entrega un mes (YYYY-MM); se guarda día 15, punto medio del mes.
      const mk = String(value || "").slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mk) || String(rec.date).slice(0, 7) === mk) { setEditing(null); return; }
      const iso = mk + "-15";
      dispatch({ type: "DASH/EDIT_RECORD", id, patch: { date: iso } });
      try { window.dispatchEvent(new CustomEvent("rc:edit", { detail: { id, field: "date", value: iso } })); } catch(e) {}
      dispatch({ type: "TOAST/SHOW", toast: {
        kind: "success",
        title: "Mes actualizado",
        body: `${rec.sucursal} · ${TYPES[rec.type].label} · ${fmtMonth(rec.date)} → ${fmtMonth(iso)}`,
        undoAction: () => dispatch({ type: "DASH/UNDO_EDIT" }),
      }});
    }
    setEditing(null);
  };

  // Adjuntar documento a un registro existente.
  const attachFileInputRef = React.useRef(null);
  const [attachTarget, setAttachTarget] = React.useState(null);
  const triggerAttach = (rec) => {
    setAttachTarget(rec);
    if (attachFileInputRef.current) attachFileInputRef.current.click();
  };
  const onAttachFileChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (e.target) e.target.value = "";
    const rec = attachTarget;
    setAttachTarget(null);
    if (!file || !rec) return;
    dispatch({ type: "TOAST/SHOW", toast: { kind: "info", title: "Subiendo documento…", body: file.name } });
    try {
      const up = await window.rcAttachDocumentToRecord(rec, file);
      dispatch({ type: "DASH/EDIT_RECORD", id: rec.id, patch: { _driveLink: up.link, factura: file.name } });
      dispatch({ type: "TOAST/SHOW", toast: { kind: "success", title: "Documento adjuntado", body: file.name } });
    } catch (err) {
      dispatch({ type: "TOAST/SHOW", toast: { kind: "error", title: "Error al adjuntar", body: String(err && err.message || err) } });
    }
  };

  return (
    <Card flush>
      <input
        ref={attachFileInputRef}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: "none" }}
        onChange={onAttachFileChange}
      />
      <div className="prt-card-head">
        <div>
          <div className="prt-h3">Tabla detallada · últimos registros</div>
          <div className="prt-hint" style={{ marginTop: 2 }}>Edita una celda haciendo clic. Los cambios se guardan al instante (con opción de deshacer).</div>
        </div>
        <div className="prt-row" style={{ gap: 8 }}>
          <Select
            size="sm"
            style={{ width: 160 }}
            value={state.dashFilters.estado}
            onChange={(v) => dispatch({ type: "DASH/SET_FILTER", key: "estado", value: v })}
            options={[
              { value: "activa", label: "Solo activas" },
              { value: "eliminada", label: "Solo eliminadas" },
              { value: "all", label: "Todas" },
            ]}
          />
          <Chip size="sm">{rangeStart}–{rangeEnd} de {sorted.length}</Chip>
          {/* Botón Ver todo oculto: sin funcionalidad por ahora.
          <Btn size="sm" icon="open_in_new">Ver todo</Btn>
          */}
        </div>
      </div>

      {state.dashFilters.estado === "all" && (
        <div style={{
          padding: "8px 22px", background: "var(--rl-warning-50)",
          borderBottom: "1px solid var(--rl-warning-100)",
          display: "flex", alignItems: "center", gap: 6,
          font: "500 12px/1.4 var(--rl-font-body)", color: "var(--rl-warning-700)",
        }}>
          <Icon name="info" size={14} />
          Los registros eliminados se muestran pero no se incluyen en los totales del dashboard.
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table className="prt-table">
          <thead>
            <tr>
              <SortableTh keyId="date"     sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Mes</SortableTh>
              <SortableTh keyId="sucursal" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Sucursal</SortableTh>
              <SortableTh keyId="type"     sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Tipo</SortableTh>
              <SortableTh keyId="subcat"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Subcategoría</SortableTh>
              <SortableTh keyId="provider" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Proveedor</SortableTh>
              <SortableTh keyId="cantidad" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} num>Cantidad</SortableTh>
              <SortableTh keyId="costo"    sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} num>Costo (CLP)</SortableTh>
              <SortableTh keyId="origen"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Origen</SortableTh>
              <th>Documento</th>
              <SortableTh keyId="estado"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort}>Estado</SortableTh>
              <th style={{ width: 48 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isDel = r.estado === "eliminada";
              return (
                <tr key={r.id} className={
                  "editable"
                  + (state.recentlyEdited === r.id ? " row-just-saved" : "")
                  + (isDel ? " row-deleted" : "")
                }>
                  <td
                    className={(isDel ? "td-del" : "") + (editing && editing.id === r.id && editing.field === "date" ? " cell-edit" : "")}
                    onClick={() => !isDel && startEdit(r.id, "date")}
                    style={{ cursor: isDel ? "default" : "pointer" }}
                  >
                    {editing && editing.id === r.id && editing.field === "date"
                      ? <DateEditCell defaultValue={r.date} onCommit={(v) => commitEdit(r.id, "date", v)} onCancel={() => setEditing(null)} />
                      : fmtMonth(r.date)}
                  </td>
                  <td className={isDel ? "td-del" : ""}>{r.sucursal}</td>
                  <td><TypeIndicator type={r.type} withLabel /></td>
                  <td
                    className={(isDel ? "td-del" : "") + (editing && editing.id === r.id && editing.field === "subcat" ? " cell-edit" : "")}
                    onClick={() => !isDel && r.type !== "electricidad" && startEdit(r.id, "subcat")}
                    style={{ cursor: isDel || r.type === "electricidad" ? "default" : "pointer" }}
                  >
                    {editing && editing.id === r.id && editing.field === "subcat"
                      ? <SelectEditCell
                          defaultValue={r.subcat || ""}
                          options={getSubcatsFor(state, r.type, r.sucursal).map(s => ({ value: s.id, label: s.label }))}
                          onCommit={(v) => commitEdit(r.id, "subcat", v)}
                          onCancel={() => setEditing(null)}
                        />
                      : (r.subcat ? <Chip>{subcatLabel(r.type, r.subcat)}</Chip> : <span className="prt-hint">—</span>)}
                  </td>
                  <td
                    className={(isDel ? "td-del" : "") + (editing && editing.id === r.id && editing.field === "provider" ? " cell-edit" : "")}
                    onClick={() => !isDel && startEdit(r.id, "provider")}
                    style={{ cursor: isDel ? "default" : "pointer" }}
                  >
                    {editing && editing.id === r.id && editing.field === "provider"
                      ? <SelectEditCell
                          defaultValue={r.provider || ""}
                          options={getProviderOptionsFor(state, r.sucursal, r.type)}
                          allowFreeText
                          onCommit={(v) => commitEdit(r.id, "provider", v)}
                          onCancel={() => setEditing(null)}
                        />
                      : (r.provider || <span className="prt-hint">—</span>)}
                  </td>
                  <td
                    className={"num" + (isDel ? " td-del" : "") + (editing && editing.id === r.id && editing.field === "cantidad" ? " cell-edit" : "")}
                    onClick={() => !isDel && startEdit(r.id, "cantidad")}
                    style={{ cursor: isDel ? "default" : "pointer" }}
                  >
                    {editing && editing.id === r.id && editing.field === "cantidad"
                      ? <EditCell defaultValue={r.cantidad} onCommit={(v) => commitEdit(r.id, "cantidad", v)} onCancel={() => setEditing(null)} align="right" />
                      : <span><strong>{fmtNum(r.cantidad)}</strong> <span className="prt-hint">{r.unit}</span></span>}
                  </td>
                  <td
                    className={"num" + (isDel ? " td-del" : "") + (editing && editing.id === r.id && editing.field === "costo" ? " cell-edit" : "")}
                    onClick={() => !isDel && startEdit(r.id, "costo")}
                    style={{ cursor: isDel ? "default" : "pointer" }}
                  >
                    {editing && editing.id === r.id && editing.field === "costo"
                      ? <EditCell defaultValue={r.costo} onCommit={(v) => commitEdit(r.id, "costo", v)} onCancel={() => setEditing(null)} align="right" />
                      : fmtCLP(r.costo)}
                  </td>
                  <td>
                    {r.origen === "documento" && <Chip size="sm" icon="picture_as_pdf">Documento</Chip>}
                    {r.origen === "manual"     && <Chip size="sm" icon="edit">Manual</Chip>}
                    {r.origen === "foto"       && <Chip size="sm" icon="photo_camera">Foto</Chip>}
                    {r.origen === "sheets"     && <Chip size="sm" icon="cloud">Importado</Chip>}
                  </td>
                  <td className={isDel ? "td-del" : ""}>
                    {r._driveLink ? (
                      <a
                        href={r._driveLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={r.factura || "Ver documento"}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6,
                          color: "var(--rl-primary-900)",
                          font: "600 12px/1 var(--rl-font-display)",
                          textDecoration: "none",
                          padding: "4px 8px",
                          borderRadius: 6,
                          border: "1px solid var(--rl-primary-200)",
                          background: "var(--rl-primary-50)",
                        }}
                      >
                        <Icon name="picture_as_pdf" size={14} />
                        <span>Ver</span>
                        <Icon name="open_in_new" size={12} />
                      </a>
                    ) : r.factura ? (
                      <span className="prt-row" style={{ gap: 4, color: "var(--rl-gray-500)" }} title={r.factura}>
                        <Icon name="picture_as_pdf" size={14} />
                        <span style={{ font: "500 12px/1 var(--rl-font-body)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.factura}</span>
                      </span>
                    ) : !isDel ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); triggerAttach(r); }}
                        title="Adjuntar documento"
                        style={{
                          all: "unset", cursor: "pointer",
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "4px 8px", borderRadius: 6,
                          border: "1px dashed var(--rl-gray-300)",
                          color: "var(--rl-gray-600)",
                          font: "500 12px/1 var(--rl-font-body)",
                        }}
                      >
                        <Icon name="cloud_upload" size={14} />
                        <span>Adjuntar</span>
                      </button>
                    ) : (
                      <span className="prt-hint">—</span>
                    )}
                  </td>
                  <td>
                    {isDel
                      ? <Chip kind="error" size="sm">Eliminada</Chip>
                      : <Chip kind="success" size="sm">Activa</Chip>}
                  </td>
                  <td style={{ textAlign: "center", padding: "0 4px" }}>
                    {isDel ? (
                      <button className="ob-icon-btn sm" title="Restaurar registro"
                        onClick={e => { e.stopPropagation(); handleRestore(r); }}
                        style={{ color: "var(--rl-success-500)" }}
                      ><Icon name="refresh" size={15} /></button>
                    ) : (
                      <button className="ob-icon-btn sm" title="Eliminar registro"
                        onClick={e => { e.stopPropagation(); handleDelete(r); }}
                        style={{ color: "var(--rl-gray-400)" }}
                      ><Icon name="delete" size={15} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={11} style={{ padding: 32, textAlign: "center", color: "var(--rl-gray-500)" }}>
                No hay registros que coincidan con los filtros actuales.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {sorted.length > PAGE_SIZE && (
        <div className="prt-row" style={{
          justifyContent: "space-between",
          padding: "10px 22px",
          borderTop: "1px solid var(--rl-gray-100)",
          background: "var(--rl-gray-50)",
        }}>
          <span className="prt-hint" style={{ font: "500 12px/1 var(--rl-font-body)" }}>
            Mostrando {rangeStart}–{rangeEnd} de {sorted.length} registros
          </span>
          <div className="prt-row" style={{ gap: 6 }}>
            <Btn size="sm" kind="ghost" icon="chevron_left"
              disabled={currentPage === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
            >Anterior</Btn>
            <span className="prt-hint" style={{
              font: "600 12px/1 var(--rl-font-body)",
              padding: "0 8px",
              alignSelf: "center",
            }}>
              Página {currentPage + 1} de {totalPages}
            </span>
            <Btn size="sm" kind="ghost" iconRight="chevron_right"
              disabled={currentPage >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            >Siguiente</Btn>
          </div>
        </div>
      )}

      {confirmModal?.action === "delete" && (
        <ConfirmDialog
          icon="delete" iconBg="var(--rl-error-50)" iconColor="var(--rl-error-500)"
          title="¿Eliminar este registro?"
          description="Quedará marcado como eliminado y no se incluirá en los cálculos del dashboard, pero podrás restaurarlo más adelante."
          detail={
            <div>
              <div><strong>{confirmModal.rec.sucursal}</strong> · {TYPES[confirmModal.rec.type].label}</div>
              <div>{fmtMonth(confirmModal.rec.date)} · {fmtNum(confirmModal.rec.cantidad)} {confirmModal.rec.unit} · {fmtCLP(confirmModal.rec.costo)}</div>
            </div>
          }
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Cancelar</Btn>
            <Btn kind="danger" icon="delete" onClick={confirmDelete}>Eliminar</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {confirmModal?.action === "restore" && (
        <ConfirmDialog
          icon="refresh" iconBg="var(--rl-success-50)" iconColor="var(--rl-success-700)"
          title="¿Restaurar este registro?"
          description="Volverá a estar activo y se incluirá nuevamente en los cálculos del dashboard."
          detail={
            <div>
              <div><strong>{confirmModal.rec.sucursal}</strong> · {TYPES[confirmModal.rec.type].label}</div>
              <div>{fmtMonth(confirmModal.rec.date)} · {fmtNum(confirmModal.rec.cantidad)} {confirmModal.rec.unit} · {fmtCLP(confirmModal.rec.costo)}</div>
            </div>
          }
          actions={<>
            <Btn onClick={() => setConfirmModal(null)}>Cancelar</Btn>
            <Btn kind="primary" icon="check" onClick={confirmRestore}>Restaurar</Btn>
          </>}
          onClose={() => setConfirmModal(null)}
        />
      )}
    </Card>
  );
};

// Encabezado clickeable para ordenar por columna. Muestra una flecha
// cuando la columna está activa; ícono neutro al hover.
const SortableTh = ({ keyId, sortKey, sortDir, onClick, num, children }) => {
  const active = sortKey === keyId;
  return (
    <th
      className={num ? "num" : ""}
      onClick={() => onClick(keyId)}
      title={"Ordenar por " + (typeof children === "string" ? children.toLowerCase() : "esta columna")}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        {children}
        {active
          ? <Icon name={sortDir === "asc" ? "arrow_upward" : "arrow_downward"} size={12} style={{ opacity: .85 }} />
          : <Icon name="unfold_more" size={12} style={{ opacity: .25 }} />}
      </span>
    </th>
  );
};

// Inline edit cell — usa el Select unificado del sistema en modo autoFocus.
// Si `allowFreeText` y no hay options, degrada a input de texto libre.
const SelectEditCell = ({ defaultValue, options, onCommit, onCancel, allowFreeText }) => {
  const v = String(defaultValue || "");
  const opts = (options || []).map(o => typeof o === "string" ? { value: o, label: o } : o);
  const isInOptions = opts.some(o => o.value === v);
  // Preserva el valor actual aunque no esté en opciones (proveedor custom legacy).
  const fullOpts = !isInOptions && v ? [{ value: v, label: v }, ...opts] : opts;
  if (allowFreeText && fullOpts.length === 0) {
    return (
      <input
        type="text"
        defaultValue={v}
        autoFocus
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit(e.currentTarget.value);
          if (e.key === "Escape") onCancel();
        }}
        style={{ border: "none", outline: "none", background: "transparent", width: "100%", padding: "0 8px", height: 32, font: "500 13px/1 var(--rl-font-body)" }}
      />
    );
  }
  return (
    <Select
      size="sm"
      autoFocus
      value={v}
      options={fullOpts}
      onChange={(nv) => onCommit(nv)}
      onClose={() => onCancel()}
      style={{ width: "100%" }}
    />
  );
};

// Inline edit cell input
const EditCell = ({ defaultValue, onCommit, onCancel, align }) => {
  const [v, setV] = React.useState(String(defaultValue));
  return (
    <input
      type="number"
      value={v}
      autoFocus
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={e => {
        if (e.key === "Enter") onCommit(v);
        if (e.key === "Escape") onCancel();
      }}
      style={{
        width: "100%", height: 44,
        border: "none", outline: "none", background: "transparent",
        padding: "0 16px",
        font: "500 13px/1 var(--rl-font-body)",
        color: "var(--rl-gray-900)",
        textAlign: align || "left",
      }}
    />
  );
};

// Editor inline de mes (input month nativo → YYYY-MM). max = mes actual.
// showPicker(): abre el desplegable al entrar a editar y al clickear cualquier
// parte del input (no solo el icono de calendario).
const DateEditCell = ({ defaultValue, onCommit, onCancel }) => {
  const [v, setV] = React.useState(String(defaultValue || "").slice(0, 7));
  const ref = React.useRef(null);
  const openPicker = () => { try { ref.current && ref.current.showPicker(); } catch (e) {} };
  React.useEffect(openPicker, []);
  return (
    <input
      ref={ref}
      type="month"
      value={v}
      autoFocus
      onClick={openPicker}
      max={currentMonthISO()}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={e => {
        if (e.key === "Enter") onCommit(v);
        if (e.key === "Escape") onCancel();
      }}
      style={{
        width: "100%", height: 44,
        border: "none", outline: "none", background: "transparent",
        padding: "0 12px",
        font: "500 13px/1 var(--rl-font-body)",
        color: "var(--rl-gray-900)",
      }}
    />
  );
};

// ============================================================
// Main Dashboard
// ============================================================
const Dashboard = () => {
  const { state, dispatch } = useApp();
  const kpis = kpiAggregates(state);
  const tt = TYPES[state.dashFilters.typeTab];
  const chart = chartDataByMonthAndSubcat(state);
  const heat = heatmapData(state);
  const filtered = selectFilteredRecords(state);
  // For aggregations, always exclude eliminada (the detail table is the only place we show them).
  const filteredActive = filtered.filter(r => r.estado !== "eliminada");

  // For the "active type KPI" we want both: total in the SELECTED PERIOD (primary)
  // and total in current month (secondary), plus delta current-month vs previous-month.
  const curMonth = CURRENT_MONTH_KEY;
  const prevMonth = PREV_MONTH_KEY;
  const inScope = (r) => r.estado !== "eliminada"
    && r.type === state.dashFilters.typeTab
    && (state.dashFilters.sucursal === "all" || r.sucursal === state.dashFilters.sucursal)
    && (state.dashFilters.subcat === "all" || r.subcat === state.dashFilters.subcat);
  const activeTypePeriod = filteredActive.filter(r => r.type === state.dashFilters.typeTab).reduce((a, r) => a + r.cantidad, 0);
  const activeTypeCur = state.records.filter(r => inScope(r) && r.date.startsWith(curMonth)).reduce((a, r) => a + r.cantidad, 0);
  const activeTypePrev = state.records.filter(r => inScope(r) && r.date.startsWith(prevMonth)).reduce((a, r) => a + r.cantidad, 0);
  const activeTypeDelta = activeTypePrev > 0 ? ((activeTypeCur - activeTypePrev) / activeTypePrev) * 100 : 0;

  // Cost: same shape — period primary, this-month secondary, delta vs prev month.
  const costPeriod = filteredActive.reduce((a, r) => a + (r.costo || 0), 0);
  const prevMonthLabel = monthLabelShort(PREV_MONTH_KEY);

  return (
    <div>
      <SectionHead
        eyebrow={`Dashboard · ${COMPANY}`}
        title="Consumos de servicios básicos"
        right={<>
          <Btn
            icon={state.recordsLoading ? "" : "refresh"}
            onClick={() => window.rcRefreshFromSheet && window.rcRefreshFromSheet(true)}
            disabled={state.recordsLoading}
            title={state.recordsLastFetch ? "Última carga: " + new Date(state.recordsLastFetch).toLocaleTimeString("es-CL") : "Cargar datos"}
          >
            {state.recordsLoading
              ? <><span className="prt-spinner" style={{ marginRight: 6 }}/>Cargando…</>
              : "Refrescar"}
          </Btn>
          <Btn icon="edit" onClick={() => dispatch({ type: "NAVIGATE", view: "manual", manualStep: "form" })}>
            Registrar manual
          </Btn>
          <Btn kind="primary" icon="cloud_upload" onClick={() => dispatch({ type: "NAVIGATE", view: "upload", uploadStep: 1 })}>
            Subir documento
          </Btn>
        </>}
      />

      <DashFilterBar />

      <InsightCallout />

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 18 }}>
        <KpiCard
          label={`${tt.label} en periodo`}
          value={fmtNum(activeTypePeriod)} unit={tt.unit}
          icon={tt.icon} color={tt.color} bg={tt.bg}
          secondary={`${fmtNum(activeTypeCur)} ${tt.unit} este mes`}
          delta={activeTypeDelta} deltaKind={activeTypeDelta < 0 ? "dn" : activeTypeDelta > 1 ? "up" : "neutral"}
          sub={`vs. ${prevMonthLabel}`}
        />
        <KpiCard
          label="Costo total periodo"
          value={fmtCLP(costPeriod)}
          icon="payments" color="var(--rl-primary-900)" bg="var(--rl-primary-50)"
          secondary={`${fmtCLP(kpis.costCur)} este mes`}
          delta={kpis.costDelta} deltaKind={kpis.costDelta < 0 ? "dn" : "up"}
          sub={`vs. ${prevMonthLabel} · CLP`}
        />
        <KpiCard
          label="Sucursales al día"
          value={kpis.sucCount} unit={`/ ${kpis.totalSuc}`}
          icon="apartment" color="var(--rl-success-700)" bg="var(--rl-success-50)"
          sub={kpis.sucCount === kpis.totalSuc ? "Todas reportaron" : `${kpis.totalSuc - kpis.sucCount} sin reportar`}
          onClick={() => dispatch({ type: "NAVIGATE", view: "matrix" })}
          footer={<span className="prt-row" style={{ gap: 4, color: "var(--rl-primary-900)", fontWeight: 600 }}>Ver detalle <Icon name="arrow_forward" size={14} /></span>}
        />
        <KpiCard
          label="Registros en periodo"
          value={fmtNum(kpis.recordsInPeriod)}
          icon="receipt_long" color="var(--rl-gray-700)" bg="var(--rl-gray-100)"
          sub={`${periodLabel(state.dashFilters.period)}`}
        />
      </div>

      {/* Chart card */}
      <Card flush style={{ marginBottom: 18 }}>
        <TypeTabs />
        <SubcatPills />
        {(chart.mixed || heat.mixed) && (
          <div className="prt-mixed-units-notice">
            <Icon name="info" size={14} />
            <span>Las subcategorías activas usan distintas unidades — se muestran en bloques separados porque no son comparables.</span>
          </div>
        )}
        {chart.mixed ? (
          <div style={{ padding: "20px 22px 22px", display: "flex", flexDirection: "column", gap: 28 }}>
            {chart.blocks.map((block) => {
              const heatBlock = heat.mixed ? heat.blocks.find(b => b.unit === block.unit) : null;
              return (
                <div key={block.unit} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 28 }}>
                  <div>
                    <div className="prt-spread" style={{ marginBottom: 8 }}>
                      <div>
                        <div className="prt-h3">Tendencia · {block.label}</div>
                        <div className="prt-hint">{block.unit} / mes · {periodLabel(state.dashFilters.period)}</div>
                      </div>
                      <Chip>{block.unit}</Chip>
                    </div>
                    <MultiLineChart months={chart.months} series={block.series} unit={block.unit} />
                  </div>
                  <div>
                    <div className="prt-spread" style={{ marginBottom: 8 }}>
                      <div>
                        <div className="prt-h3">Consumo por sucursal · {block.label}</div>
                        <div className="prt-hint">Suma · {block.unit}</div>
                      </div>
                      <Chip>Heatmap</Chip>
                    </div>
                    {heatBlock
                      ? <Heatmap months={heatBlock.months} rows={heatBlock.rows} color={tt.color} unit={block.unit} />
                      : <div className="prt-hint">Sin datos para esta unidad.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: "20px 22px 22px", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 28 }}>
            <div>
              <div className="prt-spread" style={{ marginBottom: 8 }}>
                <div>
                  <div className="prt-h3">Tendencia por subcategoría</div>
                  <div className="prt-hint">{chart.unit} / mes · {periodLabel(state.dashFilters.period)}</div>
                </div>
                <Chip>{chart.unit}</Chip>
              </div>
              <MultiLineChart months={chart.months} series={chart.series} unit={chart.unit} />
            </div>
            <div>
              <div className="prt-spread" style={{ marginBottom: 8 }}>
                <div>
                  <div className="prt-h3">Consumo por sucursal</div>
                  <div className="prt-hint">Suma · {heat.unit}</div>
                </div>
                <Chip>Heatmap</Chip>
              </div>
              <Heatmap months={heat.months} rows={heat.rows} color={tt.color} unit={heat.unit} />
            </div>
          </div>
        )}
      </Card>

      {/* Recent records table */}
      <RecentTable />
    </div>
  );
};

// Empty dashboard alternative — render only when there are 0 records
const DashboardEmpty = () => {
  const { state, dispatch } = useApp();
  return (
    <div>
      <SectionHead
        eyebrow={`Dashboard · ${COMPANY}`}
        title="Consumos de servicios básicos"
        right={
          <Btn
            icon={state.recordsLoading ? "" : "refresh"}
            onClick={() => window.rcRefreshFromSheet && window.rcRefreshFromSheet(true)}
            disabled={state.recordsLoading}
          >
            {state.recordsLoading
              ? <><span className="prt-spinner" style={{ marginRight: 6 }}/>Cargando…</>
              : "Refrescar"}
          </Btn>
        }
      />
      <EmptyState
        icon="inbox"
        title={state.recordsLoading ? "Cargando datos…" : "Aún no hay consumos registrados"}
        body={state.recordsLoading
          ? "Sincronizando registros de combustible, electricidad y agua."
          : "Cuando ingreses tu primer consumo (a mano o subiendo documentos), aquí verás KPIs, tendencias por tipo y la tabla detallada. Si ya hay datos cargados, presiona 'Refrescar'."}
        actions={state.recordsLoading ? null : <>
          <Btn kind="primary" icon="edit" onClick={() => dispatch({ type: "NAVIGATE", view: "manual" })}>Registrar manualmente</Btn>
          <Btn icon="cloud_upload" onClick={() => dispatch({ type: "NAVIGATE", view: "upload" })}>Subir documento</Btn>
        </>}
      />
    </div>
  );
};

const DashboardView = () => {
  const { state } = useApp();
  if (state.records.length === 0) return <DashboardEmpty />;
  return <Dashboard />;
};

Object.assign(window, { DashboardView, Dashboard });
