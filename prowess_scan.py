#!/usr/bin/env python3
"""
Scan an MTGGoldfish archetype page for recent decklists and flag cards that
deviate from a stock list, then render an interactive HTML report.

Usage:
    python3 prowess_scan.py \
        --url https://www.mtggoldfish.com/archetype/modern-izzet-prowess \
        --stock stock-prowess.deck \
        --out prowess_report.html

Comparison rules:
  * Maindeck  -> flags cards absent from the stock maindeck, AND cards whose
                 count differs from stock (count matters).
  * Sideboard -> presence vs absence only (count ignored).
  * Fetchlands are all bucketed into a single virtual "Fetchland" card so that
    a swap of e.g. Arid Mesa for Bloodstained Mire is NOT flagged as unusual.
"""

import argparse
import html as htmllib
import os
import re
import subprocess
import sys
import time

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# The classic fetchlands (+ Prismatic Vista / Fabled Passage). All collapsed to
# one bucket so mana-base fetch choices don't read as "unusual".
FETCHLANDS = {
    "Arid Mesa", "Scalding Tarn", "Wooded Foothills", "Bloodstained Mire",
    "Flooded Strand", "Polluted Delta", "Marsh Flats", "Misty Rainforest",
    "Verdant Catacombs", "Windswept Heath", "Prismatic Vista", "Fabled Passage",
}
FETCH_BUCKET = "Fetchland"


# --------------------------------------------------------------------------- #
# Fetching
# --------------------------------------------------------------------------- #
def get(url, cache_path=None, sleep=0.4):
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as fh:
            return fh.read()
    # curl is used rather than urllib: the python.org build lacks a CA bundle,
    # and curl handles TLS + a real UA cleanly in this environment.
    text = subprocess.run(
        ["curl", "-sS", "--fail", "-A", UA, url],
        capture_output=True, text=True, timeout=40,
    ).stdout
    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as fh:
            fh.write(text)
    if sleep:
        time.sleep(sleep)
    return text


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def parse_deck_text(text):
    """A downloaded deck: maindeck lines, blank line, sideboard lines."""
    main, side, cur = {}, {}, None
    saw_blank = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            saw_blank = True
            continue
        m = re.match(r"^(\d+)\s+(.*\S)$", line)
        if not m:
            continue
        n, name = int(m.group(1)), m.group(2).strip()
        (side if saw_blank else main)[name] = (side if saw_blank else main).get(name, 0) + n
    return main, side


def bucket_fetchlands(counts):
    out = {}
    for name, n in counts.items():
        key = FETCH_BUCKET if name in FETCHLANDS else name
        out[key] = out.get(key, 0) + n
    return out


def parse_archetype(html_text):
    """Return list of tournament dicts with their deck rows (id/place/player)."""
    tournaments = []
    # Each tournament == an <h4> with /tournament/ link followed by a table.
    hdr_re = re.compile(
        r"<h4>\s*<a href=\"/tournament/(\d+)\">(.*?)</a>.*?"
        r"<nobr>on\s*([\d-]+)</nobr>",
        re.S,
    )
    headers = list(hdr_re.finditer(html_text))
    for idx, h in enumerate(headers):
        start = h.end()
        end = headers[idx + 1].start() if idx + 1 < len(headers) else len(html_text)
        block = html_text[start:end]
        name = htmllib.unescape(re.sub(r"\s+\d{4}-\d\d-\d\d$", "", h.group(2)).strip())
        rows = []
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", block, re.S):
            place = re.search(r"column-place'>\s*(.*?)\s*</td>", tr, re.S)
            did = re.search(r'href="/deck/(\d+)#online"', tr)
            player = re.search(r'/player/[^"]+">([^<]+)</a>', tr)
            if not did:
                continue
            rows.append({
                "id": did.group(1),
                "place": htmllib.unescape(place.group(1).strip()) if place else "",
                "player": htmllib.unescape(player.group(1).strip()) if player else "?",
            })
        if rows:
            tournaments.append({
                "id": h.group(1),
                "name": name,
                "date": h.group(3),
                "decks": rows,
            })
    return tournaments


# --------------------------------------------------------------------------- #
# Comparison
# --------------------------------------------------------------------------- #
def diff_deck(main, side, stock_main, stock_side):
    """Return dict describing deviations from stock."""
    main = bucket_fetchlands(main)
    stock_main_b = bucket_fetchlands(stock_main)

    new_main, count_main = [], []
    for name, n in sorted(main.items()):
        if name not in stock_main_b:
            new_main.append((name, n))
        elif n != stock_main_b[name]:
            count_main.append((name, n, stock_main_b[name]))
    missing_main = sorted(
        (name, stock_main_b[name]) for name in stock_main_b if name not in main
    )

    new_side = sorted((name, n) for name, n in side.items() if name not in stock_side)
    missing_side = sorted(name for name in stock_side if name not in side)

    unusual = set(n for n, _ in new_main) | set(n for n, _, _ in count_main) \
        | set(n for n, _ in new_side)
    return {
        "new_main": new_main,          # (name, count)  -> not in stock maindeck
        "count_main": count_main,      # (name, count, stock_count)
        "missing_main": missing_main,  # (name, stock_count)
        "new_side": new_side,          # (name, count)  -> not in stock SB
        "missing_side": missing_side,  # name
        "unusual_names": unusual,      # set of names to highlight in the list
    }


# --------------------------------------------------------------------------- #
# HTML rendering
# --------------------------------------------------------------------------- #
def esc(s):
    return htmllib.escape(str(s))


def decklist_html(main, side, unusual):
    """Full decklist for the hover panel, with unusual cards highlighted."""
    def section(title, counts):
        rows = []
        for name, n in sorted(counts.items()):
            hot = " hot" if name in unusual else ""
            rows.append(
                f'<div class="cardline{hot}"><span class="qty">{n}</span>'
                f'<span class="cname">{esc(name)}</span></div>'
            )
        total = sum(counts.values())
        return (f'<div class="secttl">{esc(title)} ({total})</div>' + "".join(rows))

    return section("Maindeck", main) + section("Sideboard", side)


def chip_html(diff):
    chips = []
    for name, n in diff["new_main"]:
        chips.append(f'<span class="chip main" title="not in stock maindeck">'
                     f'{n} {esc(name)}</span>')
    for name, n, sn in diff["count_main"]:
        chips.append(f'<span class="chip count" title="stock runs {sn}">'
                     f'{n} {esc(name)} <em>(stock {sn})</em></span>')
    for name, n in diff["new_side"]:
        chips.append(f'<span class="chip side" title="not in stock sideboard">'
                     f'SB {n} {esc(name)}</span>')
    if not chips:
        return '<span class="chip none">stock list</span>'
    return "".join(chips)


def render(tournaments, decks, stock_main, stock_side, url):
    items = []
    for t in tournaments:
        for row in t["decks"]:
            d = decks.get(row["id"])
            if not d:
                continue
            diff = d["diff"]
            n_unusual = (len(diff["new_main"]) + len(diff["count_main"])
                         + len(diff["new_side"]))
            panel = decklist_html(d["main"], d["side"], diff["unusual_names"])
            missing = ""
            if diff["missing_main"] or diff["missing_side"]:
                bits = []
                if diff["missing_main"]:
                    bits.append("MD: " + ", ".join(
                        f"{n}× {esc(nm)}" for nm, n in diff["missing_main"]))
                if diff["missing_side"]:
                    bits.append("SB: " + ", ".join(esc(nm)
                                for nm in diff["missing_side"]))
                missing = ('<div class="missing">cut from stock — '
                           + " · ".join(bits) + "</div>")
            items.append(f"""
      <li class="deck" data-panel="deck-{row['id']}">
        <div class="row">
          <span class="place">{esc(row['place'])}</span>
          <span class="player"><a href="https://www.mtggoldfish.com/deck/{row['id']}"
             target="_blank" rel="noopener">{esc(row['player'])}</a></span>
          <span class="tourney">{esc(t['name'])}</span>
          <span class="date">{esc(t['date'])}</span>
          <span class="badge {'zero' if n_unusual == 0 else ''}">{n_unusual}</span>
        </div>
        <div class="chips">{chip_html(diff)}</div>
        {missing}
        <template class="paneltpl" data-id="deck-{row['id']}">{panel}</template>
      </li>""")

    stock_chips = "".join(
        f'<span class="stk">{n} {esc(nm)}</span>'
        for nm, n in sorted(bucket_fetchlands(stock_main).items()))
    stock_sb = ", ".join(esc(nm) for nm in sorted(stock_side))

    return TEMPLATE.format(
        url=esc(url),
        count=len(items),
        items="".join(items),
        stock_chips=stock_chips,
        stock_sb=stock_sb,
    )


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Izzet Prowess — unusual card scan</title>
<style>
:root {{
  --bg:#0f1216; --card:#171c22; --line:#252c34; --ink:#e6e9ee; --dim:#8b95a1;
  --hot:#ffb454; --main:#7ee081; --side:#6cc4ff; --count:#c9a3ff; --accent:#ff6b6b;
}}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }}
a {{ color:inherit; }}
header {{ padding:18px 24px; border-bottom:1px solid var(--line); }}
header h1 {{ margin:0 0 4px; font-size:18px; }}
header .sub {{ color:var(--dim); font-size:12px; }}
.stockbar {{ padding:10px 24px; border-bottom:1px solid var(--line);
  color:var(--dim); font-size:12px; display:flex; flex-wrap:wrap; gap:6px;
  align-items:center; }}
.stockbar .stk {{ background:#1c2229; border:1px solid var(--line);
  border-radius:4px; padding:1px 6px; color:var(--ink); }}
.layout {{ display:flex; align-items:flex-start; }}
ul.decks {{ list-style:none; margin:0; padding:14px 24px; flex:1; min-width:0; }}
li.deck {{ background:var(--card); border:1px solid var(--line); border-radius:8px;
  padding:10px 12px; margin-bottom:8px; cursor:default; transition:border-color .1s; }}
li.deck:hover {{ border-color:#3a4552; }}
li.deck.active {{ border-color:var(--accent); }}
.row {{ display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }}
.place {{ font-weight:700; min-width:44px; color:var(--dim); }}
.player {{ font-weight:600; min-width:150px; }}
.player a {{ text-decoration:none; }}
.player a:hover {{ text-decoration:underline; }}
.tourney {{ color:var(--dim); flex:1; min-width:150px; }}
.date {{ color:var(--dim); font-variant-numeric:tabular-nums; }}
.badge {{ margin-left:auto; background:var(--accent); color:#fff; font-weight:700;
  border-radius:20px; min-width:22px; text-align:center; padding:1px 7px; font-size:12px; }}
.badge.zero {{ background:#2b333c; color:var(--dim); }}
.chips {{ margin-top:7px; display:flex; flex-wrap:wrap; gap:5px; }}
.chip {{ font-size:12px; border-radius:5px; padding:2px 7px; border:1px solid; }}
.chip em {{ font-style:normal; opacity:.7; }}
.chip.main {{ color:var(--hot); border-color:#5a4626; background:#241d10; }}
.chip.count {{ color:var(--count); border-color:#42355c; background:#1e1826; }}
.chip.side {{ color:var(--side); border-color:#2a4a63; background:#111f2a; }}
.chip.none {{ color:var(--dim); border-color:var(--line); }}
.missing {{ margin-top:6px; font-size:11.5px; color:#6f7883; }}
aside {{ position:sticky; top:0; width:300px; flex:none; height:100vh;
  border-left:1px solid var(--line); padding:16px; overflow:auto; }}
aside .hint {{ color:var(--dim); font-size:12px; }}
aside h2 {{ font-size:13px; margin:0 0 10px; color:var(--dim);
  text-transform:uppercase; letter-spacing:.05em; }}
.secttl {{ margin:12px 0 4px; font-weight:700; color:var(--side); font-size:12px;
  text-transform:uppercase; letter-spacing:.04em; }}
.cardline {{ display:flex; gap:8px; padding:1px 0; }}
.cardline .qty {{ color:var(--dim); min-width:18px; text-align:right;
  font-variant-numeric:tabular-nums; }}
.cardline.hot .cname {{ color:var(--hot); font-weight:700; }}
.cardline.hot .qty {{ color:var(--hot); }}
@media (max-width:820px) {{ aside {{ display:none; }} }}
</style></head>
<body>
<header>
  <h1>Izzet Prowess — unusual card scan</h1>
  <div class="sub">{count} recent decklists ·
    <a href="{url}" target="_blank" rel="noopener">source</a> ·
    hover a deck to see the full list · fetchlands bucketed ·
    <span style="color:var(--hot)">maindeck new</span> /
    <span style="color:var(--count)">count off</span> /
    <span style="color:var(--side)">sideboard new</span></div>
</header>
<div class="stockbar"><strong style="color:var(--ink)">Stock&nbsp;MD:</strong>
  {stock_chips}<span>&nbsp;·&nbsp;<strong style="color:var(--ink)">SB:</strong>
  {stock_sb}</span></div>
<div class="layout">
  <ul class="decks">{items}</ul>
  <aside id="panel"><h2>Decklist</h2><div id="panelbody">
    <div class="hint">Hover a deck on the left to preview its full list here.</div>
  </div></aside>
</div>
<script>
const body = document.getElementById('panelbody');
let pinned = null;
function show(li) {{
  const tpl = li.querySelector('.paneltpl');
  body.innerHTML = tpl.innerHTML;
  document.querySelectorAll('li.deck.active').forEach(e => e.classList.remove('active'));
  li.classList.add('active');
}}
document.querySelectorAll('li.deck').forEach(li => {{
  li.addEventListener('mouseenter', () => {{ if (!pinned) show(li); }});
  li.addEventListener('click', () => {{ pinned = (pinned === li) ? null : li; show(li); }});
}});
</script>
</body></html>"""


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    # MTGGoldfish renamed the archetype "Izzet Prowess" -> "Izzet Cutter" and
    # kept both pages live with disjoint decks, so scan both by default.
    ap.add_argument("--url", action="append", dest="urls", default=None,
                    help="archetype page (repeatable)")
    ap.add_argument("--stock", default="stock-prowess.deck")
    ap.add_argument("--out", default="prowess_report.html")
    ap.add_argument("--cache", default=".prowess_cache")
    args = ap.parse_args()
    if not args.urls:
        args.urls = [
            "https://www.mtggoldfish.com/archetype/modern-izzet-prowess",
            "https://www.mtggoldfish.com/archetype/modern-izzet-cutter",
        ]

    os.makedirs(args.cache, exist_ok=True)

    with open(args.stock, "r", encoding="utf-8") as fh:
        stock_text = fh.read()
    # stock-prowess.deck has an "About/Name/Deck/.../Sideboard/..." layout.
    stock_main, stock_side, cur = {}, {}, None
    for line in stock_text.splitlines():
        s = line.strip()
        if s.lower() in ("deck",):
            cur = stock_main; continue
        if s.lower() in ("sideboard",):
            cur = stock_side; continue
        if cur is None:
            continue
        m = re.match(r"^(\d+)\s+(.*\S)$", s)
        if m:
            cur[m.group(2).strip()] = int(m.group(1))
    stock_side_set = set(stock_side)
    print(f"stock: {sum(stock_main.values())} main / {sum(stock_side.values())} SB",
          file=sys.stderr)

    # Merge the pages: a tournament can appear under both archetype names with
    # different decks, so union the rows per tournament id.
    merged = {}
    for i, url in enumerate(args.urls):
        html_text = get(url, os.path.join(args.cache, f"archetype-{i}.html"))
        for t in parse_archetype(html_text):
            prev = merged.get(t["id"])
            if prev is None:
                merged[t["id"]] = dict(t, decks=list(t["decks"]))
                continue
            seen = {d["id"] for d in prev["decks"]}
            prev["decks"].extend(d for d in t["decks"] if d["id"] not in seen)
    tournaments = sorted(merged.values(), key=lambda t: t["date"], reverse=True)
    n_decks = sum(len(t["decks"]) for t in tournaments)
    print(f"parsed {len(tournaments)} tournaments, {n_decks} decks", file=sys.stderr)

    decks = {}
    for t in tournaments:
        for row in t["decks"]:
            did = row["id"]
            if did in decks:
                continue
            txt = get(f"https://www.mtggoldfish.com/deck/download/{did}",
                      os.path.join(args.cache, f"{did}.txt"))
            main, side = parse_deck_text(txt)
            if not main:
                print(f"  warn: deck {did} empty", file=sys.stderr)
                continue
            decks[did] = {
                "main": main, "side": side,
                "diff": diff_deck(main, side, stock_main, stock_side_set),
            }
            print(f"  deck {did}: {row['player']}", file=sys.stderr)

    out = render(tournaments, decks, stock_main, stock_side_set, args.urls[0])
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(out)
    print(f"wrote {args.out} ({len(decks)} decks)", file=sys.stderr)


if __name__ == "__main__":
    main()
