import { memo } from 'react';

export default memo(function InventionPage() {
  return (
    <div className="calc-page" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center', color: 'var(--dim)', fontFamily: 'var(--mono)' }}>
        <div style={{ fontSize: 10, letterSpacing: 4, marginBottom: 8 }}>INVENTION</div>
        <div style={{ fontSize: 9, letterSpacing: 2, opacity: 0.5 }}>COMING SOON</div>
      </div>
    </div>
  );
});
