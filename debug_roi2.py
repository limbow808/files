import urllib.request, json
try:
    url = 'http://localhost:5001/api/calculator?system=Korsiki&facility=large&sell_loc=jita&buy_loc=jita'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    results = data.get('results', [])
    print(f'Got {len(results)} total results')
    
    good = [r for r in results if (r.get('net_profit') or 0) > 0]
    print(f'Profitable (net_profit > 0): {len(good)}')
    
    roi_zero = [r for r in good if (r.get('roi') or 0) == 0]
    roi_small = [r for r in good if 0 < (r.get('roi') or 0) < 0.05]
    roi_ok = [r for r in good if (r.get('roi') or 0) >= 0.05]
    
    print(f'  roi == 0: {len(roi_zero)}')
    print(f'  roi in (0, 0.05): {len(roi_small)}')
    print(f'  roi >= 0.05: {len(roi_ok)}')
    
    if roi_zero:
        print('ROI=0 items:')
        for r in roi_zero[:5]:
            np_ = r.get('net_profit')
            mc = r.get('material_cost') or 0
            jc = r.get('job_cost') or 0
            st = r.get('sales_tax') or 0
            bf = r.get('broker_fee') or 0
            cost = mc + jc + st + bf
            print(f"  {r.get('name')} roi={r.get('roi')} np={np_:.0f} cost={cost:.0f}")
    
    # Show distribution of roi values
    if good:
        rois = sorted([(r.get('roi') or 0) for r in good])
        print(f'\nROI distribution in profitable items:')
        print(f'  min={rois[0]:.4f}%, max={rois[-1]:.4f}%, median={rois[len(rois)//2]:.4f}%')
        print(f'  First 10 roi values:', [round(r,4) for r in rois[:10]])
        
except Exception as e:
    print('Error:', e)
