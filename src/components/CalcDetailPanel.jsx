import { fmtISK, fmtVol, fmtDuration, roiColor } from '../utils/fmt';

function SkillPips({ have, need }) {
  return (
    <span style={{ marginLeft: 6 }}>
      {[1, 2, 3, 4, 5].map(lvl => (
        <span
          key={lvl}
          className={`skill-level-pip${lvl <= (have ?? 0) ? ' filled' : ''}${lvl === need ? ' needed' : ''}`}
          title={`Level ${lvl}${lvl === need ? ' (required)' : ''}`}
        />
      ))}
    </span>
  );
}

export default function CalcDetailPanel({ item, charSkills }) {
  const materials = item.material_breakdown || [];
  const skills    = item.required_skills    || [];
  const roi       = item.roi || 0;
  const tierColor = roiColor(roi);

  let skillStatus = null;
  if (charSkills && skills.length > 0) {
    const met = skills.filter(s => (charSkills[s.name] ?? 0) >= s.level).length;
    skillStatus = met === skills.length ? 'green'
                : met > 0              ? 'orange'
                :                        'red';
  }
  const skillStatusColor =
    skillStatus === 'green'  ? '#00cc66' :
    skillStatus === 'orange' ? '#ccaa00' :
    skillStatus === 'red'    ? 'var(--accent)' :
    'var(--dim)';

  return (
    <tr>
      <td colSpan={16} style={{ padding: 0, background: '#000' }}>
        <div className="calc-detail" style={{ borderLeft: `3px solid ${tierColor}` }}>

          {/* Header strip */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, letterSpacing: 2, color: 'var(--text)' }}>
              {item.name}
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)' }}>
                {item.tech && `TECH ${item.tech}`}
                {item.category && ` · ${item.category.toUpperCase()}`}
                {item.size && item.size !== 'U' ? ` · ${item.size}` : ''}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)' }}>
                ME{item.me_level} · TE{item.te_level} · {fmtDuration(item.duration)}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: tierColor, fontWeight: 700 }}>
                {roi.toFixed(1)}% ROI
              </span>
              {item.resolved_sci != null && (
                <span style={{ fontSize: 10, color: 'var(--dim)', letterSpacing: 1 }}>
                  SCI {(item.resolved_sci * 100).toFixed(2)}% · {item.facility_label}
                </span>
              )}
            </div>
          </div>

          <div className="calc-detail-grid">

            {/* Column 1: Materials */}
            <div>
              <div className="calc-detail-section-title">◈ Required Materials</div>
              {materials.length > 0 ? materials.map((m, i) => (
                <div key={i} className="mat-row">
                  <span className="mat-name">{m.name || `Type ${m.type_id}`}</span>
                  <span className="mat-qty">
                    <span style={{ color: 'var(--text)', marginRight: 6 }}>{fmtVol(m.quantity)}</span>
                    <span style={{ color: 'var(--dim)' }}>× {fmtISK(m.unit_price)}</span>
                    <span style={{ color: 'var(--text)', marginLeft: 6 }}>{fmtISK(m.line_cost)}</span>
                  </span>
                </div>
              )) : (
                <div style={{ color: 'var(--dim)', fontSize: 11 }}>No material data</div>
              )}
            </div>

            {/* Column 2: Skills */}
            <div>
              <div className="calc-detail-section-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>◈ Required Skills</span>
                {skillStatus && (
                  <span style={{ color: skillStatusColor }}>
                    {skillStatus === 'green'  ? '✓ Ready'   :
                     skillStatus === 'orange' ? '⚠ Partial' : '✗ Missing'}
                  </span>
                )}
              </div>
              {skills.length > 0 ? skills.map((s, i) => {
                const have = charSkills ? (charSkills[s.name] ?? null) : null;
                const met  = have !== null ? have >= s.level : null;
                return (
                  <div key={i} className="skill-row">
                    <span className="skill-name" style={{
                      color: met === false ? 'var(--accent)' : met === true ? '#00cc66' : 'var(--text)',
                    }}>
                      {s.name}
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {have !== null ? (
                        <>
                          <SkillPips have={have} need={s.level} />
                          <span style={{ fontSize: 10, color: met ? '#00cc66' : 'var(--accent)', minWidth: 24, textAlign: 'right' }}>
                            {met ? '✓' : `${have}/${s.level}`}
                          </span>
                        </>
                      ) : (
                        <span style={{ color: 'var(--dim)', fontSize: 11 }}>Lv {s.level}</span>
                      )}
                    </span>
                  </div>
                );
              }) : (
                <div style={{ color: 'var(--dim)', fontSize: 11 }}>No skill requirements</div>
              )}
            </div>

            {/* Column 3: Cost breakdown */}
            <div>
              <div className="calc-detail-section-title">◈ Cost Breakdown</div>
              {[
                ['Material Cost', item.material_cost, 'var(--text)'],
                ['Job Install',   item.job_cost,       'var(--dim)'],
                ['Sales Tax',     item.sales_tax,      'var(--dim)'],
                ['Broker Fee',    item.broker_fee,     'var(--dim)'],
              ].map(([label, val, col]) => (
                <div key={label} className="mat-row">
                  <span style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                  <span style={{ color: col }}>{fmtISK(val)} ISK</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase' }}>Revenue</span>
                <span style={{ color: 'var(--text)', fontSize: 13 }}>{fmtISK(item.gross_revenue)} ISK</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 2, color: 'var(--text)', textTransform: 'uppercase' }}>Net Profit</span>
                <span style={{ color: tierColor, fontSize: 16, fontWeight: 700 }}>
                  {fmtISK(item.net_profit)} ISK
                  <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 6 }}>({item.margin_pct?.toFixed(1)}%)</span>
                </span>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {item.isk_per_hour > 0 && (
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase' }}>ISK/HR</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtISK(item.isk_per_hour)}</div>
                  </div>
                )}
                {item.isk_per_m3 > 0 && (
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase' }}>ISK/M³</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtISK(item.isk_per_m3)}</div>
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
      </td>
    </tr>
  );
}
