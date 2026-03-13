import { fmtISK, fmtVol } from '../utils/fmt';
import { HangarBadge } from './ui';

export default function DetailPanel({ item }) {
  const totalCost   = (item.material_cost || 0) + (item.job_cost || 0) +
                      (item.sales_tax     || 0) + (item.broker_fee || 0);
  const profitColor = item.net_profit >= 0 ? 'var(--text)' : 'var(--accent)';

  return (
    <tr>
      <td colSpan={9} style={{ padding: 0, background: '#000' }}>
        <div className="detail-panel">
          <div className="detail-title">{item.name} — COST BREAKDOWN</div>
          <div className="detail-grid">
            <div>
              {[
                ['Gross Revenue', item.gross_revenue],
                ['Material Cost', item.material_cost],
                ['Job Install',   item.job_cost],
                ['Sales Tax',     item.sales_tax],
                ['Broker Fee',    item.broker_fee],
              ].map(([label, val]) => (
                <div key={label} className="cost-row">
                  <span className="cost-label">{label}</span>
                  <span className="cost-val">{fmtISK(val)} ISK</span>
                </div>
              ))}
              <div className="cost-row cost-total">
                <span className="cost-label">Total Cost</span>
                <span className="cost-val">{fmtISK(totalCost)} ISK</span>
              </div>
              <div className="cost-row cost-total" style={{ marginTop: 4 }}>
                <span className="cost-label" style={{ color: 'var(--text)', fontSize: 13 }}>NET PROFIT</span>
                <span className="cost-val" style={{ color: profitColor, fontSize: 17 }}>
                  {fmtISK(item.net_profit)} ISK &nbsp;
                  <span style={{ fontSize: 12 }}>({item.margin_pct?.toFixed(1)}%)</span>
                </span>
              </div>
            </div>
            <div>
              {item.missing && item.missing.length > 0 ? (
                <>
                  <div className="missing-title">◈ MATERIAL SHORTFALLS</div>
                  <table className="missing-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['MATERIAL', 'HAVE', 'NEED', 'SHORT BY'].map(h => (
                          <th key={h} style={{ textAlign: h === 'MATERIAL' ? 'left' : 'right', padding: '4px 8px', fontSize: 10 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {item.missing.map((m, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: 'left',  padding: '4px 8px', borderBottom: '1px solid #1a1a1a' }}>{m.name}</td>
                          <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #1a1a1a' }}>{fmtVol(m.have)}</td>
                          <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #1a1a1a' }}>{fmtVol(m.need)}</td>
                          <td style={{ textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid #1a1a1a', color: 'var(--accent)' }}>{fmtVol(m.short_by)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : item.can_build === true ? (
                <div style={{ color: '#00cc66', fontSize: 12, marginTop: 8 }}>
                  ✓ All materials in hangar — {item.max_runs} run{item.max_runs !== 1 ? 's' : ''} possible
                </div>
              ) : (
                <div style={{ color: 'var(--dim)', fontSize: 11, marginTop: 8, letterSpacing: 1 }}>
                  Hangar data unavailable — run server with ESI token
                </div>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
