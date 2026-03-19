import urllib.request, json
try:
    url = 'http://localhost:5001/api/calculator?system=Korsiki&facility=large'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    results = data.get('results', [])
    good = [r for r in results if (r.get('net_profit') or 0) > 0]
    # Sort by net_profit desc (default UI sort)
    good.sort(key=lambda r: r.get('net_profit', 0), reverse=True)
    
    print('First 20 items UI displays (sorted by net_profit desc, showing what ROI cell shows):')
    for r in good[:20]:
        roi = r.get('roi') or 0
        roi_display = f"{roi:.1f}%"  # same as roi.toFixed(1) + '%'
        print(f"  {r.get('name','?')[:42]:42} ROI={roi_display:8} cat={r.get('category','?')}")
    
    print()
    # Now simulate TYPE filter: show only "Modules"
    modules = [r for r in good if r.get('category') == 'Modules']
    modules.sort(key=lambda r: r.get('net_profit', 0), reverse=True)
    print('Modules only, sorted by net_profit desc:')
    for r in modules[:15]:
        roi = r.get('roi') or 0
        roi_display = f"{roi:.1f}%"
        print(f"  {r.get('name','?')[:42]:42} ROI={roi_display:8}")
    
except Exception as e:
    print('Error:', e)
