import urllib.request, json
try:
    url = 'http://localhost:5001/api/calculator?system=Korsiki&facility=large'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    results = data.get('results', [])
    good = [r for r in results if (r.get('net_profit') or 0) > 0]

    # Group by category
    from collections import defaultdict
    by_cat = defaultdict(list)
    for r in good:
        by_cat[r.get('category','?')].append(r.get('roi',0))
    
    print('ROI by category (profitable items only):')
    for cat, rois in sorted(by_cat.items()):
        rois.sort()
        if rois:
            print(f"  {cat}: count={len(rois)}, min={rois[0]:.4f}%, median={rois[len(rois)//2]:.4f}%, max={rois[-1]:.4f}%")
            # Count items that show as "0.0%" (roi < 0.05%)
            zero_display = sum(1 for r in rois if r < 0.05)
            if zero_display > 0:
                print(f"    -> {zero_display} items show as '0.0%' (roi < 0.05%)")
    
except Exception as e:
    print('Error:', e)
