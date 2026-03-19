from calculator import calculate_profit, CONFIG
from pricer import get_prices_bulk
from blueprints import load_blueprints

bps = load_blueprints()
print(f'Total blueprints: {len(bps)}')

bps_sample = bps[:10]
all_ids = set()
out_ids = set()
for bp in bps_sample:
    out_ids.add(bp['output_id'])
    all_ids.add(bp['output_id'])
    for m in bp['materials']:
        all_ids.add(m['type_id'])

prices = get_prices_bulk(list(all_ids), history_ids=list(out_ids))

for bp in bps_sample:
    r = calculate_profit(bp, prices)
    if r:
        cost = r['material_cost'] + r['job_cost'] + r['sales_tax'] + r['broker_fee']
        roi = (r['net_profit'] / cost * 100) if cost > 0 else 0
        print(f"{r['name']}: net_profit={r['net_profit']:.0f}, cost={cost:.0f}, roi={roi:.2f}%, mat_cost={r['material_cost']:.0f}, sales_tax={r['sales_tax']:.0f}, broker_fee={r['broker_fee']:.0f}")
