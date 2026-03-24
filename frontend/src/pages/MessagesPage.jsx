import { useState, useEffect } from 'react';
import { API } from '../App';

const GROUPS = [
  {
    label: 'CONNECTION',
    fields: [
      { key: 'TELEGRAM_TOKEN',  label: 'Bot Token',  type: 'password', hint: 'from @BotFather' },
      { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID',   type: 'text',     hint: 'personal or group chat ID' },
    ],
  },
  {
    label: 'ALERT FILTERS',
    fields: [
      { key: 'BLUEPRINT_TYPE',       label: 'Blueprint Type',    type: 'radio',  options: [
          { value: 'bpo',  label: 'BPO — Originals only' },
          { value: 'bpc',  label: 'BPC — Copies only' },
          { value: 'both', label: 'BOTH — Originals & copies' },
        ],
        info: 'BPOs are permanent and can be used indefinitely. BPCs have a limited run count. "Both" watches for either type in contracts.',
      },
      { key: 'ROI_THRESHOLD',        label: 'Min ROI %',           type: 'number', hint: 'minimum ROI to trigger alert',
        info: 'Return on investment threshold. A blueprint with 20% ROI means you earn 20% of your material cost back as profit per manufacturing run. Lower values = more alerts.',
      },
      { key: 'BREAKEVEN_MAX_RUNS',   label: 'Max Breakeven Runs',  type: 'number', hint: 'max runs to recover BP cost',
        info: 'Maximum number of manufacturing runs to recover the blueprint purchase price. e.g. 100 means: if the BP costs 500M and each run profits 5M, that\'s exactly 100 runs to break even — and it would be accepted. 101 runs would be rejected.',
      },
      { key: 'MIN_NET_PROFIT',       label: 'Min Net Profit (ISK)', type: 'number', hint: 'e.g. 1000000 = 1M ISK',
        info: 'Minimum profit per manufacturing run in ISK. Filters out low-margin junk. 1,000,000 = 1M ISK per run.',
      },
      { key: 'ALERT_COOLDOWN_HOURS', label: 'Cooldown (hours)',    type: 'number', hint: 'hours before re-alerting same deal',
        info: 'Suppresses repeat alerts for the same contract. If a BPO listing is still up 6 hours later, it will fire again. Lower values increase noise.',
      },
    ],
  },
  {
    label: 'SCAN INTERVALS',
    fields: [
      { key: 'CONTRACT_SCAN_INTERVAL', label: 'Contract Scan (s)', type: 'number', hint: 'seconds between contract scans',
        info: 'How often to scan public ESI contracts for blueprint deals.\n\n• 300s (5 min) — aggressive sniping, highest ESI load\n• 900s (15 min) — recommended balance\n• 1800s (30 min) — light load, may miss short-lived listings\n\nEach scan fetches up to MAX_PAGES × 1000 contracts, resolves item details for all candidates, then sends alerts. Lower = more ESI requests per hour.',
      },
      { key: 'JOB_SCAN_INTERVAL',      label: 'Job Scan (s)',       type: 'number', hint: 'seconds between industry job checks',
        info: 'How often to poll each character\'s industry jobs for completion or 5-minute warnings.\n\n• 60s — near-real-time, one ESI call per character per minute\n• 300s (5 min) — default, low overhead\n• 600s — very light, may miss the 5-min warning window\n\nCost: 1 authenticated ESI call per character per interval.',
      },
    ],
  },
  {
    label: 'ADVANCED',
    fields: [
      { key: 'MAX_PAGES', label: 'Max ESI Pages', type: 'number', hint: 'max contract pages to fetch (1 page = 1000 contracts)',
        info: 'Each ESI page contains 1000 contracts. New listings always appear on early pages, so high values rarely find more deals but significantly increase scan time and ESI error rate.\n\n• 1–3 pages — fastest, catches freshly posted contracts only\n• 5–10 pages — recommended, covers the last few hours of listings\n• 20+ pages — slow, high ESI load, diminishing returns\n\nNote: items within each matching contract require a separate ESI call, so fewer pages = fewer total requests.',
      },
      { key: 'REGION_ID', label: 'Region', type: 'select',
        options: [
          { value: 0,        label: 'ALL MAJOR HUBS — Jita · Amarr · Dodixie · Hek · Rens' },
          { value: 10000002, label: 'The Forge — Jita' },
          { value: 10000043, label: 'Domain — Amarr' },
          { value: 10000032, label: 'Sinq Laison — Dodixie' },
          { value: 10000042, label: 'Metropolis — Hek' },
          { value: 10000030, label: 'Heimatar — Rens' },
        ],
        info: 'Which market region(s) to scan for contracts.\n\n• ALL MAJOR HUBS — scans all 5 trade hubs per cycle; multiplies ESI load by 5 but covers the entire empire market.\n• Individual region — lower load, faster scan, recommended if you trade in one hub.',
      },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap(g => g.fields.map(f => f.key));
// Default form values for fields that aren't plain text/number inputs
const FIELD_DEFAULTS = { BLUEPRINT_TYPE: 'bpo', REGION_ID: 10000002 };
const LS_KEY = 'crest_bot_settings';

export default function MessagesPage() {
  const [form, setForm]         = useState({});
  const [status, setStatus]     = useState(null);
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [saveMsg, setSaveMsg]   = useState(null);
  const [testMsg, setTestMsg]   = useState(null);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    // Load from localStorage immediately for a snappy first paint
    try {
      const cached = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (Object.keys(cached).length) setForm(cached);
    } catch {}

    // Fetch from server (authoritative) and override
    fetch(`${API}/api/settings/bot`)
      .then(r => r.json())
      .then(data => {
        const init = {};
        ALL_KEYS.forEach(k => { init[k] = data[k] ?? FIELD_DEFAULTS[k] ?? ''; });
        setForm(init);
        try { localStorage.setItem(LS_KEY, JSON.stringify(init)); } catch {}
        setStatus({
          running:            data.running,
          last_contract_scan: data.last_contract_scan,
          last_job_scan:      data.last_job_scan,
          last_alert_sent:    data.last_alert_sent,
          alerts_sent:        data.alerts_sent,
          last_error:         data.last_error,
        });
      })
      .catch(() => {});
  }, []);

  function handleChange(key, val) {
    setForm(prev => {
      const next = { ...prev, [key]: val };
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await fetch(`${API}/api/settings/bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (data.ok) {
        setSaveMsg({ ok: true, text: 'Settings saved.' });
      } else {
        setSaveMsg({ ok: false, text: data.error || 'Save failed.' });
      }
    } catch (e) {
      setSaveMsg({ ok: false, text: 'Network error.' });
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(null), 4000);
  }

  async function handleTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await fetch(`${API}/api/settings/bot/test`, { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        setTestMsg({ ok: true, text: 'Test message sent!' });
      } else {
        setTestMsg({ ok: false, text: data.error || 'Send failed.' });
      }
    } catch (e) {
      setTestMsg({ ok: false, text: 'Network error.' });
    }
    setTesting(false);
    setTimeout(() => setTestMsg(null), 5000);
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', height: '100%', overflowY: 'auto' }}>
    <div style={{ padding: '24px 28px', width: '100%', maxWidth: 720 }}>

      {/* Page title */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', marginBottom: 4 }}>
          SETTINGS / MESSAGES
        </div>
        <div style={{ fontSize: 20, letterSpacing: 3, color: 'var(--text)', fontWeight: 400 }}>
          TELEGRAM BOT CONFIGURATION
        </div>
      </div>

      {/* Config groups */}
      {GROUPS.map(group => (
        <div key={group.label} style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 9, letterSpacing: 2, color: 'var(--dim)', textTransform: 'uppercase',
            paddingBottom: 6, borderBottom: '1px solid var(--border)', marginBottom: 12,
          }}>
            {group.label}
          </div>
          {group.fields.map(field => (
            <div key={field.key} style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '6px 20px', alignItems: 'center', marginBottom: 10 }}>
              <label style={{ fontSize: 11, letterSpacing: 1, color: 'var(--dim)', textTransform: 'uppercase', textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                {field.label}
                {field.info && (
                  <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 13, height: 13, fontSize: 9, fontWeight: 700, letterSpacing: 0,
                      border: '1px solid var(--dim)', color: 'var(--dim)', cursor: 'default',
                      flexShrink: 0, lineHeight: 1,
                    }}>?</span>
                    <span style={{
                      position: 'absolute', bottom: '100%', right: 0, marginBottom: 6,
                      width: 280, background: '#1a1a1a', border: '1px solid var(--border)',
                      padding: '10px 12px', fontSize: 11, letterSpacing: 0.3, lineHeight: 1.6,
                      color: 'var(--text2)', textTransform: 'none', fontWeight: 300,
                      whiteSpace: 'pre-wrap', zIndex: 300, pointerEvents: 'none',
                      opacity: 0, transition: 'opacity 0.1s',
                    }}
                    className="field-tooltip"
                    >{field.info}</span>
                  </span>
                )}
              </label>
              <div style={{ position: 'relative', display: 'flex', gap: 6 }}>
                {field.type === 'radio' ? (
                  <div style={{ display: 'flex', gap: 0 }}>
                    {field.options.map(opt => {
                      const active = (form[field.key] ?? 'bpo') === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => handleChange(field.key, opt.value)}
                          style={{
                            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1,
                            textTransform: 'uppercase', padding: '5px 14px',
                            background: active ? 'var(--accent)' : 'var(--bg2)',
                            color: active ? '#000' : 'var(--dim)',
                            border: '1px solid var(--border)',
                            borderRight: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                    {/* Close the right border of the last button */}
                    <div style={{ width: 1, background: 'var(--border)' }} />
                  </div>
                ) : field.type === 'select' ? (
                  <select
                    value={form[field.key] ?? ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    style={{
                      flex: 1, background: 'var(--bg2)', border: '1px solid var(--border)',
                      color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 13,
                      padding: '5px 10px', outline: 'none', cursor: 'pointer',
                      appearance: 'none',
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23B0B0B0'/%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 10px center',
                      paddingRight: 28,
                    }}
                    onFocus={e => (e.target.style.borderColor = 'var(--accent)')}
                    onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                  >
                    {field.options.map(opt => (
                      <option key={opt.value} value={opt.value} style={{ background: 'var(--bg2)' }}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      type={field.key === 'TELEGRAM_TOKEN' && !showToken ? 'password' : field.type === 'number' ? 'number' : 'text'}
                      value={form[field.key] ?? ''}
                      onChange={e => handleChange(field.key, e.target.value)}
                      placeholder={field.hint}
                      style={{
                        flex: 1,
                        background: 'var(--bg2)',
                        border: '1px solid var(--border)',
                        color: 'var(--text)',
                        fontFamily: 'var(--mono)',
                        fontSize: 13,
                        padding: '5px 10px',
                        outline: 'none',
                        letterSpacing: 0,
                      }}
                      onFocus={e => (e.target.style.borderColor = 'var(--accent)')}
                      onBlur={e => (e.target.style.borderColor = 'var(--border)')}
                    />
                    {field.key === 'TELEGRAM_TOKEN' && (
                      <button
                        onClick={() => setShowToken(s => !s)}
                        style={{
                          background: 'var(--bg2)',
                          border: '1px solid var(--border)',
                          color: 'var(--dim)',
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          letterSpacing: 1,
                          padding: '0 8px',
                          cursor: 'pointer',
                          textTransform: 'uppercase',
                        }}
                      >
                        {showToken ? 'HIDE' : 'SHOW'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, marginBottom: 28 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase',
            padding: '7px 20px', background: saving ? 'var(--border)' : 'var(--accent)',
            color: '#000', border: 'none', cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'SAVING…' : 'SAVE CONFIG'}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase',
            padding: '7px 20px', background: 'transparent',
            color: testing ? 'var(--dim)' : 'var(--text)',
            border: '1px solid var(--border)', cursor: testing ? 'not-allowed' : 'pointer',
          }}
        >
          {testing ? 'SENDING…' : 'SEND TEST'}
        </button>
        {saveMsg && (
          <span style={{ fontSize: 11, letterSpacing: 1, color: saveMsg.ok ? 'var(--green)' : 'var(--error)' }}>
            {saveMsg.text}
          </span>
        )}
        {testMsg && !saveMsg && (
          <span style={{ fontSize: 11, letterSpacing: 1, color: testMsg.ok ? 'var(--green)' : 'var(--error)' }}>
            {testMsg.text}
          </span>
        )}
      </div>

      {/* Scanner status strip */}
      {status && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 10 }}>
            SCANNER STATUS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px 20px' }}>
            {[
              { label: 'Running',         val: status.running ? 'YES' : 'NO', color: status.running ? 'var(--green)' : 'var(--dim)' },
              { label: 'Alerts Sent',     val: status.alerts_sent ?? '—' },
              { label: 'Last Contract',   val: fmtTs(status.last_contract_scan) },
              { label: 'Last Job Scan',   val: fmtTs(status.last_job_scan) },
            ].map(item => (
              <div key={item.label}>
                <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'var(--dim)', textTransform: 'uppercase', marginBottom: 3 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 13, color: item.color || 'var(--text)' }}>
                  {item.val}
                </div>
              </div>
            ))}
          </div>
          {status.last_error && (
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--error)', letterSpacing: 0.5 }}>
              LAST ERROR: {status.last_error}
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
