import urllib.request, json
try:
    url = 'http://localhost:5001/api/calculator?system=Korsiki&facility=large&sell_loc=jita&buy_loc=jita'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    results = data.get('results', [])
    good = [r for r in results if (r.get('net_profit') or 0) > 0]
    # Sort by net_profit desc (same as UI default)
    good.sort(key=lambda r: r.get('net_profit', 0), reverse=True)
    print(f'Top 15 items by net_profit (UI default sort):')
    for r in good[:15]:
        roi = r.get('roi', 0)
        np = r.get('net_profit', 0)
        mc = r.get('material_cost', 0)
        cat = r.get('category', '?')
        print(f"  {r.get('name','?')[:40]} roi={roi:.4f}% np={np/1e6:.1f}M cat={cat}")
except Exception as e:
    print('Error:', e)
