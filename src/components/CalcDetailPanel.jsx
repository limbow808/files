import { useState } from 'react';
import { fmtISK, fmtVol, fmtDuration, roiColor } from '../utils/fmt';
import EveText from './EveText';

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

export default function CalcDetailPanel({ item, runs = 1, charSkills, roiColorFn }) {
  const materials = item.material_breakdown || [];
  const skills    = item.required_skills    || [];
  const roi       = item.roi || 0;
  const tierColor = (roiColorFn ?? roiColor)(roi);
  const n = Math.max(1, runs);
  const [jobOpen, setJobOpen] = useState(false);

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
      <td colSpan={16} style={{ padding: 0, background: 'var(--table-shell-bg)' }}>
        <div className="calc-detail eve-corners eve-panel-in" style={{ borderLeft: `3px solid ${tierColor}`, position: 'relative' }}>
          <div className="eve-corners-inner" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
          <div className="eve-scanline" />

          {/* Header strip */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 15, letterSpacing: 2, color: 'var(--text)' }}>
              <EveText text={item.name} scramble={true} steps={10} speed={25} />
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
                <div key={i} className="mat-row eve-row-reveal" style={{ animationDelay: `${i * 30}ms` }}>
                  <span className="mat-name">{m.name || `Type ${m.type_id}`}</span>
                  <span className="mat-qty">
                    <span style={{ color: 'var(--text)', marginRight: 6 }}>{fmtVol(m.quantity * n)}</span>
                    <span style={{ color: 'var(--dim)' }}>× {fmtISK(m.unit_price)}</span>
                    <span style={{ color: 'var(--text)', marginLeft: 6 }}>{fmtISK(m.line_cost * n)}</span>
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

              {/* Material Cost */}
              <div className="mat-row">
                <span style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Material Cost</span>
                <span style={{ color: 'var(--text)' }}>{fmtISK(item.material_cost * n)} ISK</span>
              </div>

              {/* Total Job Cost — collapsible */}
              <div
                className="mat-row"
                onClick={() => item.job_cost_breakdown && setJobOpen(o => !o)}
                style={{ cursor: item.job_cost_breakdown ? 'pointer' : 'default', userSelect: 'none' }}
              >
                <span style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
                  {item.job_cost_breakdown && (
                    <span style={{ fontSize: 9, display: 'inline-block', transition: 'transform 0.15s', transform: jobOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                  )}
                  Total Job Cost
                </span>
                <span style={{ color: 'var(--dim)' }}>{fmtISK(item.job_cost * n)} ISK</span>
              </div>
              {jobOpen && item.job_cost_breakdown && (() => {
                const jc = item.job_cost_breakdown;
                return (
                  <div style={{ margin: '2px 0 6px 8px', borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 1.5, marginBottom: 3 }}>
                      JOB FORMULA · SCI {(jc.sci * 100).toFixed(2)}% · fac.tax {(jc.facility_tax_rate * 100).toFixed(3)}%
                    </div>
                    {[
                      ['EIV',         jc.eiv * n,               'var(--dim2)'],
                      ['SCI gross',   jc.gross * n,             'var(--dim2)'],
                      ['role bonus',  jc.gross_bonus_amount * n, jc.gross_bonus_amount < 0 ? '#4cff91' : '#ff4700'],
                      ['install',     jc.gross_after_bonus * n,  'var(--dim2)'],
                      ['fac. tax',    jc.facility_tax * n,       'var(--dim2)'],
                      ['SCC 4%',      jc.scc_surcharge * n,      'var(--dim2)'],
                    ].map(([lbl, val, clr]) => (
                      <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '1px 0' }}>
                        <span style={{ color: 'var(--dim)', letterSpacing: 0.5 }}>{lbl}</span>
                        <span style={{ color: clr, fontFamily: 'var(--mono)' }}>{fmtISK(val)}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Sales Tax, Broker Fee, Invention */}
              {[
                ['Sales Tax',  item.sales_tax * n,      'var(--dim)'],
                ['Broker Fee', item.broker_fee * n,     'var(--dim)'],
                ...(item.invention_cost > 0
                  ? [['Invention', item.invention_cost * n, 'var(--accent)']]
                  : []),
              ].map(([label, val, col]) => (
                <div key={label} className="mat-row">
                  <span style={{ color: 'var(--dim)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                  <span style={{ color: col }}>{fmtISK(val)} ISK</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase' }}>Revenue</span>
                <span style={{ color: 'var(--text)', fontSize: 13 }}>{fmtISK(item.gross_revenue * n)} ISK</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: 2, color: 'var(--text)', textTransform: 'uppercase' }}>Net Profit</span>
                <span style={{ color: tierColor, fontSize: 16, fontWeight: 700 }}>
                  {fmtISK(item.net_profit * n)} ISK
                  <span style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 6 }}>({item.margin_pct?.toFixed(1)}%)</span>
                </span>
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {item.isk_per_hour > 0 && (
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase' }}>ISK/HR</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtISK(item.isk_per_hour)}</div>
                    <div style={{ fontSize: 9, color: item.avg_sell_days != null && item.avg_sell_days !== 3.0 ? '#00cc66' : 'var(--dim)', letterSpacing: 1 }}>
                      {item.avg_sell_days != null && item.avg_sell_days !== 3.0
                        ? `≈${item.avg_sell_days}d sell (personal)`
                        : '≈3d sell (default)'}
                    </div>
                  </div>
                )}
                {item.isk_per_m3 > 0 && (
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase' }}>ISK/M³</div>
                    <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtISK(item.isk_per_m3)}</div>
                  </div>
                )}
              </div>

              {/* Recommended runs */}
              {item.recommended_runs && (() => {
                const rec = item.recommended_runs;
                const tooSlow = rec.max_per_day < (item.avg_daily_volume / (item.output_qty || 1));
                const color = tooSlow ? '#00cc66' : rec.saturation_pct >= 90 ? 'var(--accent)' : 'var(--text)';
                return (
                  <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--border)', background: 'var(--bg2)' }}>
                    <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 6 }}>◈ Recommended Runs</div>
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'baseline' }}>
                      <div>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 700, color }}>{rec.runs}</span>
                        <span style={{ fontSize: 10, color: 'var(--dim)', marginLeft: 4 }}>RUNS/BATCH</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.6 }}>
                        <div>covers <span style={{ color: 'var(--text)' }}>{fmtVol(item.avg_daily_volume)}/day</span> demand</div>
                        <div>sells in ~<span style={{ color: 'var(--text)' }}>{rec.days_to_sell}d</span> · {rec.max_per_day}/day capacity</div>                          <div>isk/hr basis: <span style={{ color: item.avg_sell_days != null && item.avg_sell_days !== 3.0 ? '#00cc66' : 'var(--dim)' }}>
                            {item.avg_sell_days != null && item.avg_sell_days !== 3.0
                              ? `${item.avg_sell_days}d personal avg`
                              : '3d default (no history)'}
                          </span></div>                      </div>
                    </div>
                    {tooSlow && (
                      <div style={{ marginTop: 6, fontSize: 9, color: '#00cc66', letterSpacing: 1 }}>
                        ✓ DEMAND EXCEEDS YOUR CAPACITY — no oversaturation risk
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

          </div>
        </div>
      </td>
    </tr>
  );
}
