import urllib.request, json
try:
    url = 'http://localhost:5001/api/calculator?system=Korsiki&facility=large&sell_loc=jita&buy_loc=jita'
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read())
    results = data.get('results', [])
    print(f'Got {len(results)} results')
    if results:
        for r in results[:5]:
            roi = r.get('roi')
            np_ = r.get('net_profit')
            mc = r.get('material_cost')
            jc = r.get('job_cost')
            st = r.get('sales_tax')
            bf = r.get('broker_fee')
            cost = (mc or 0) + (jc or 0) + (st or 0) + (bf or 0)
            print(f"  {r.get('name','?')}: roi={roi}, net_profit={np_:.0f}, cost={cost:.0f}")
except Exception as e:
    print('Server not reachable or error:', e)
