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
    label: 'QUEUE NOTIFICATIONS',
    fields: [
      { key: 'JOB_SCAN_INTERVAL',      label: 'Job Scan (s)',       type: 'number', hint: 'seconds between industry job checks',
        info: 'How often to poll each character\'s industry jobs for completion or 5-minute warnings.\n\n• 60s — near-real-time, one ESI call per character per minute\n• 300s (5 min) — default, low overhead\n• 600s — very light, may miss the 5-min warning window\n\nCost: 1 authenticated ESI call per character per interval.',
      },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap(g => g.fields.map(f => f.key));
// Default form values for fields that aren't plain text/number inputs
const FIELD_DEFAULTS = { JOB_SCAN_INTERVAL: 300 };
const LS_KEY = 'crest_bot_settings';

function isMaskedTokenValue(value) {
  const token = String(value ?? '').trim();
  return token.includes('*') && !token.includes(':');
}

function validateBotForm(form) {
  const token = String(form.TELEGRAM_TOKEN ?? '').trim();
  const chatId = String(form.TELEGRAM_CHAT_ID ?? '').trim();

  if (token && !isMaskedTokenValue(token)) {
    const parts = token.split(':');
    if (/\s/.test(token)) return 'Bot token cannot contain spaces.';
    if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || parts[1].length < 10) {
      return 'Bot token must look like 123456789:ABCdef...';
    }
  }

  if (chatId && /\s/.test(chatId)) {
    return 'Chat ID cannot contain spaces.';
  }

  return null;
}

export default function MessagesPage({ embedded = false, sectionId }) {
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
          running:         data.running,
          last_job_scan:   data.last_job_scan,
          last_alert_sent: data.last_alert_sent,
          alerts_sent:     data.alerts_sent,
          last_error:      data.last_error,
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
    const validationError = validateBotForm(form);
    if (validationError) {
      setSaveMsg({ ok: false, text: validationError });
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 4000);
      return;
    }

    const payload = { ...form };
    if (isMaskedTokenValue(payload.TELEGRAM_TOKEN)) {
      delete payload.TELEGRAM_TOKEN;
    } else if (typeof payload.TELEGRAM_TOKEN === 'string') {
      payload.TELEGRAM_TOKEN = payload.TELEGRAM_TOKEN.trim();
    }
    if (typeof payload.TELEGRAM_CHAT_ID === 'string') {
      payload.TELEGRAM_CHAT_ID = payload.TELEGRAM_CHAT_ID.trim();
    }

    try {
      const r = await fetch(`${API}/api/settings/bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  const content = (
    <>

      {/* Page title */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, color: 'var(--dim)', marginBottom: 4 }}>
          SETTINGS / MESSAGES
        </div>
        <div style={{ fontSize: 20, letterSpacing: 3, color: 'var(--text)', fontWeight: 400 }}>
          TELEGRAM QUEUE NOTIFICATIONS
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

      {/* Queue notifier status strip */}
      {status && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: 'var(--dim)', marginBottom: 10 }}>
            QUEUE NOTIFIER STATUS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px 20px' }}>
            {[
              { label: 'Running',            val: status.running ? 'YES' : 'NO', color: status.running ? 'var(--green)' : 'var(--dim)' },
              { label: 'Notifications Sent', val: status.alerts_sent ?? '—' },
              { label: 'Last Queue Scan',    val: fmtTs(status.last_job_scan) },
              { label: 'Last Notification',  val: fmtTs(status.last_alert_sent) },
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
    </>
  );

  if (embedded) {
    return (
      <section
        id={sectionId}
        className="settings-stack-section"
        style={{ display: 'flex', justifyContent: 'center', background: 'rgba(255,255,255,0.018)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div style={{ padding: '24px 28px', width: '100%', maxWidth: 900 }}>
          {content}
        </div>
      </section>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: '24px 28px', width: '100%', maxWidth: 720 }}>
        {content}
      </div>
    </div>
  );
}
