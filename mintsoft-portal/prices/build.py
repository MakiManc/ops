#!/usr/bin/env python3
"""
Turns the China Stock Price File into prices/china-stock-prices.json.

Run:  python3 -I prices/build.py <path to China_Stock_Price_File.xlsx>

WHY THERE IS A HAND-WRITTEN MAP IN HERE

The portal's product names come from Mintsoft ("150ML LADLE - MRK011"); the price
file's come from supplier quotations in Google Drive ("150ml Ladel"). Only 46 of the
portal's 93 products match by name after case, punctuation and the site-code suffix are
normalised away, so something has to bridge the other 47.

Fuzzy matching was tried and rejected. At a 0.80 similarity cutoff it paired:

  "2.0L TUB + LID"  and  "4.5L TUB + LID"  both -> "4L tub + Lid"      (wrong size, twice)
  "CAST IRON TEA POT (900ML)"              -> "Cast iron Tea Pot (600ml)"  (wrong capacity)
  "Round Table Base"                       -> "Round Table" at GBP 99     (a base is not a table)
  "SAKURA TREES PLANTERS ... 30*60*80"     -> "... 60*60*80cm"            (wrong size)

Three of those four put a confidently wrong number on a finance report, which is worse
than a gap. So the bridge is the ALIAS table below: every pair read against the file's
size/spec column by hand. Where the file genuinely cannot answer, the product goes in
UNPRICED with the reason, and the report shows it as unpriced rather than guessing.

WHICH SHEET THE PRICES COME FROM

"Price List (GBP)", the latest supplier unit price per product. Not "Recharge prices
(to sites)", although that sheet is named for what we want, because:

  - not one of its 156 rows carries a date, so "the current price" cannot be identified
  - 100 of those 156 rows simply repeat the supplier cost (ratio 1.0), so they are not
    recharge prices at all
  - 29 of its 55 products disagree with themselves across the four documents it draws on
  - the file's own Read me warns the pack size changes between those documents
    ("3.02 per pack of 10 pairs vs 1.51 per pack of 5 pairs")

So the price here is COST OF GOODS. It excludes freight, which the supplier quotes per
CBM (GBP 200-210) with no per-product volume recorded anywhere in the file, and it
excludes UK VAT and duty. The report says so wherever it shows a total.
"""
import json, re, sys, datetime
import openpyxl

SHEET = 'Price List (GBP)'

# portal product name -> name in the price file. Checked by hand against the file's
# 'Size / spec' column; the note is carried through to the report where it matters.
ALIAS: dict[str, tuple[str, str | None]] = {
    '150ML LADLE - MRK011': ('150ml Ladel', None),
    '2.0L TUB + LID - MRK011': ('2L tub + Lid', None),
    'Ceramic teacups': ('ceramic tea cups', None),
    'DRINKS MENU COVERS - MRK001': ('Drink Menu Covers A5', None),
    'High Chairs - MRK008': ('high chair', None),
    'MENU COVERS - MRK001': ('Menu Covers A4', None),
    'MENU HOLDERS - MRK001': ('Menu Holders(A5)', None),
    'MILK TEA BOTTLE WITH LOGO - MRK002': (
        'Milk tea bottle',
        'The file’s row is a plain 500ML milk tea bottle; this product says "with logo". '
        'Same supplier orders, so taken as the same bottle.',
    ),
    # One hoodie price covers every size: the file's size/spec reads "37XL/38XXL".
    'M&R Hoodie (Black)- L - MRK010': ('M&R HOODIE (black)', 'One price covers L, XL and XXL.'),
    'M&R Hoodie (Black)- XL - MRK010': ('M&R HOODIE (black)', 'One price covers L, XL and XXL.'),
    'M&R Hoodie (Black)- XXL - MRK010': ('M&R HOODIE (black)', 'One price covers L, XL and XXL.'),
    'M&R Hoodie(pink)- L - MRK010': ('M&R HOODIE (pink)', 'One price covers L, XL and XXL.'),
    'M&R Hoodie(pink)- XL - MRK010': ('M&R HOODIE (pink)', 'One price covers L, XL and XXL.'),
    'M&R Hoodie(pink)- XXL - MRK010': ('M&R HOODIE (pink)', 'One price covers L, XL and XXL.'),
    # The file's one round-table row is explicitly "Round table table top 900mm Diameter".
    'SAKURA TREES PLANTERS WITH LOGO - 60*60* 80 - MRK002': ('Sakura Trees Planters with logo', None),
    # Copper-edged birch tops: the file carries a rectangle (1200x600) and a square (600x600).
    'RECTANGLE TABLETOP (COPPER) - MRK007': ('Wooden table top with copper edges Birch wood (Rectangle)', None),
    'WODDEN TABLE TOP WITH COPPER EDGES BIRCH WOOD (RECTANGLE) - MRK002': (
        'Wooden table top with copper edges Birch wood (Rectangle)', None),
    'Wodden table top with copper edges Birch wood (Rectangle)': (
        'Wooden table top with copper edges Birch wood (Rectangle)', None),
    'WODDEN TABLE TOP WITH COPPER EDGES BIRCH WOOD (RECTANGLE) - GOLDEN RIM - MRK008': (
        'Wooden table top with copper edges Birch wood (Rectangle)',
        'Priced as the rectangle copper-edged top. The file has no separate golden-rim price, '
        'so if the rim costs more this is under.',
    ),
    'Square Table Top (Copper)': ('Wooden table top with copper edges Birch wood (Square)', None),
    'Wooden tabletop with copper edges Birch wood (Square)': (
        'Wooden table top with copper edges Birch wood (Square)', None),
}

# Products the file cannot price. The reason is shown in the report, because "no price"
# with a reason is actionable and "no price" on its own just looks broken.
UNPRICED: dict[str, str] = {
    # Quoted per pack, for products the portal orders by the unit. The portal's pack_size
    # is 1 and its unit is "unit", so pricing a line of 200 at the pack price would be out
    # by the pack size -- 10x and 50x respectively. The per-unit price genuinely is not
    # known: the Read me warns the chopstick pack size changes between documents
    # ("3.02 per pack of 10 pairs vs 1.51 per pack of 5 pairs").
    'Black Chopsticks':
        'Quoted per pack, not per pair, and the pack size changes between documents '
        '(\u00a33.02 per pack of 10 pairs on the latest, \u00a31.51 per pack of 5 pairs '
        'elsewhere). A per-unit price cannot be read off it.',
    'Red Spoon for sauce':
        'Quoted at \u00a35.39 per pack of 50, and the portal orders these by the unit, so '
        'there is no per-unit price to use.',
    '4.5L TUB + LID - MRK011': 'The file prices a 2L and a 4L tub, not a 4.5L one.',
    'BANNERS': 'No banner appears anywhere in the price file.',
    'BLACK SPOON FOR SAUCE - MRK012':
        'Only the red sauce spoon is priced. The file’s Gaps sheet lists order 260305 '
        '"Black spoon" as having no accessible priced document.',
    'Blue Cups Round- MRK005':
        'The file’s only cup lines are disposables ("CUPS" at 8p); this is tableware.',
    'Blue Cups Sphere - MRK005':
        'The file’s only cup lines are disposables ("CUPS" at 8p); this is tableware.',
    'Blue Spoons - MRK005': 'Only the red sauce spoon is priced.',
    'CAST IRON TEA POT (900ML) - MRK008':
        'The file prices the 600ml pot only, which the portal carries as its own product.',
    'Disposable chopsticks - MRK010':
        'The file’s Gaps sheet lists order 260605 "Disposable chopsticks (Mercium)" as '
        'having no accessible priced document.',
    'Disposable paper apron - MRK010': 'Not in the price file.',
    'FREEZER': 'Not in the price file.',
    'Fresh Seal Bowl - MRK005':
        'The nearest line is a 1250ML takeaway bowl and lid at 13.8p, which is a different thing.',
    'MAKI BIRU HALF PINT GLASSES - MRK001': 'No Maki Biru glassware in the price file.',
    'MAKI BIRU PINT GLASSES': 'No Maki Biru glassware in the price file.',
    'MAKI BIRU PINT GLASSES - MRK001': 'No Maki Biru glassware in the price file.',
    'Paper Sushi Tube - MRK006':
        'The sushi tube is quoted at 78p on a "sets; pack 140 sets/box" basis, so whether that '
        'is per tube or per box of 140 is not clear enough to price a line with.',
    'Planters':
        'The file prices only the 60*60*80cm sakura planter, not a planter in general.',
    'ROUND TABLE - 1100MM - MRK002':
        'The file’s round table is a 900mm top. The 1100mm is not separately priced.',
    'ROUND TABLE - GOLDEN RIM  - MRK001':
        'The file’s round table is a plain 900mm top. No golden-rim price.',
    'Round Table Top (Copper)':
        'The file prices a plain 900mm round top; its copper-edged tops are the rectangle and '
        'the square. No copper-edged round top.',
    'Round plate with gold coating at the Edges - MRK005': 'Not in the price file.',
    'SAKURA TREES PLANTERS WITH LOGO - 30*60*80 - MRK002':
        'The file prices the 60*60*80cm planter. This is a different size.',
    'Sushi plates Blue - MRK005': 'Not in the price file.',
    # The file's Read me: "Table bases are never priced separately on the supplier
    # documents; the price sits on the table-top row."
    'Rectangle Table Base': 'Table bases are not priced separately; the price sits on the table top.',
    'Round Table Base': 'Table bases are not priced separately; the price sits on the table top.',
    'Square Table Base': 'Table bases are not priced separately; the price sits on the table top.',
    'ROUND TABLE BASE FOR SQUARE TABLE - MRK001':
        'Table bases are not priced separately; the price sits on the table top.',
}


def norm(s: object) -> str:
    """Case, punctuation, the Mintsoft site-code suffix and '&'. Nothing clever."""
    t = re.sub(r'\s*-?\s*mrk\s*0*\d+\s*', ' ', str(s or '').lower())
    t = re.sub(r'[^a-z0-9]+', ' ', t.replace('&', ' and '))
    return re.sub(r'\s+', ' ', t).strip()


def read_sheet(wb, name: str) -> list[dict]:
    ws = wb[name]
    rs = list(ws.iter_rows(values_only=True))
    head = [str(c).strip() if c is not None else '' for c in rs[0]]
    return [
        dict(zip(head, r)) for r in rs[1:]
        if not all(c is None or str(c).strip() == '' for c in r)
    ]


def as_date(v: object) -> str | None:
    if v is None or str(v).strip() == '':
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.date().isoformat() if isinstance(v, datetime.datetime) else v.isoformat()
    return str(v)[:10]


def main(xlsx: str, products: list[str]) -> dict:
    wb = openpyxl.load_workbook(xlsx, data_only=True, read_only=True)
    rows = read_sheet(wb, SHEET)

    by_name: dict[str, dict] = {}
    for r in rows:
        name = str(r['Product'] or '').strip()
        if name:
            by_name[name] = r
    by_norm: dict[str, dict] = {}
    for name, r in by_name.items():
        by_norm.setdefault(norm(name), r)

    priced, unpriced = [], []
    for product in products:
        if product in UNPRICED:
            unpriced.append({'product': product, 'reason': UNPRICED[product]})
            continue

        note = None
        if product in ALIAS:
            file_name, note = ALIAS[product]
            row = by_name.get(file_name)
            if row is None:
                raise SystemExit(f'alias target not in {SHEET}: {file_name!r} (for {product!r})')
            match = 'alias'
        else:
            row = by_norm.get(norm(product))
            if row is None:
                raise SystemExit(
                    f'{product!r} is neither matched, aliased nor listed as unpriced. '
                    'Add it to ALIAS or to UNPRICED with a reason.'
                )
            match = 'exact'

        price = row['Latest unit price']
        if price is None:
            unpriced.append({'product': product, 'reason': f'The {SHEET} row carries no price.'})
            continue

        distinct = int(row['No. of distinct prices'] or 1)
        priced.append({
            'product': product,
            'fileProduct': str(row['Product']).strip(),
            'match': match,
            'unitPrice': round(float(price), 4),
            'currency': str(row['Currency'] or 'GBP').strip(),
            'unit': (str(row['Unit (as on latest doc)']).strip() or None)
                    if row['Unit (as on latest doc)'] else None,
            'spec': (str(row['Size / spec']).strip() or None) if row['Size / spec'] else None,
            'docDate': as_date(row['Latest doc date']),
            'orderNo': str(row['Order no.']).strip() if row['Order no.'] else None,
            'source': str(row['Latest source (click to open)'] or '').strip() or None,
            'distinctPrices': distinct,
            'lowest': round(float(row['Lowest price']), 4) if row['Lowest price'] is not None else None,
            'highest': round(float(row['Highest price']), 4) if row['Highest price'] is not None else None,
            'flags': str(row['Flags']).strip() if row['Flags'] else None,
            'note': note,
        })

    priced.sort(key=lambda p: p['product'])
    unpriced.sort(key=lambda p: p['product'])
    return {
        'basis': 'supplier',
        'description':
            'Latest supplier unit price per product, goods only. Excludes freight, which is '
            'quoted per CBM (GBP 200-210) with no per-product volume on record, and excludes '
            'UK VAT and duty.',
        'sourceFile': 'China Stock Price File',
        'sourceSheet': SHEET,
        'compiled': '2026-10-06',
        'priced': priced,
        'unpriced': unpriced,
    }


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('usage: build.py <China_Stock_Price_File.xlsx> <portal-products.json>')
    names = [r['name'] for r in json.load(open(sys.argv[2]))[0]['results'] if r['active']]
    out = main(sys.argv[1], names)
    print(json.dumps(out, indent=2, ensure_ascii=False))
