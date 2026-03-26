#!/usr/bin/env python3
"""
Patent Family Tracker

Fetches patent details and family members from Google Patents.
No API key required.

Usage:
    python tracker.py "US 12,178,560"
    python tracker.py US12178560B2
"""

import sys
import re
import os
import base64
import json as _json
import time as _time
import calendar
import random
import webbrowser
import requests
from datetime import date as _date
from typing import Optional

W = 72  # output width

# Rotate across several realistic browser strings so repeated Cloud Run requests
# don't all look identical to Google's bot-detection layer.
_UA_POOL = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
]
# Kept for any legacy callers
UA = _UA_POOL[0]

# ── Normalization ────────────────────────────────────────────────────────────

def normalize(raw: str) -> str:
    """Strip spaces/commas/periods; keep letters and digits."""
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def build_url(patent_id: str) -> str:
    """
    Build a Google Patents URL from a raw patent string.
    Handles numbers given without a country code (e.g. bare "12178560" or
    "12178560B2" — Google Patents citation_patent_number often omits the CC).
    Defaults to US when the cleaned string starts with a digit.
    """
    clean = normalize(patent_id)
    # If no country-code prefix (starts with a digit), assume US.
    # This covers bare numbers like "12178560" or kind-coded "12178560B2".
    if clean and clean[0].isdigit():
        clean = "US" + clean
    # Already has a kind code (ends letter+digit, e.g. B2, A1, T2)?
    if re.search(r"[A-Z]\d$", clean):
        pub_num = clean
    elif clean.startswith("US") and clean[2:].isdigit():
        # Pure US number without kind code — try B2 first (most common utility grant)
        pub_num = clean + "B2"
    else:
        pub_num = clean
    return f"https://patents.google.com/patent/{pub_num}/en"


# ── Fetching + Parsing ───────────────────────────────────────────────────────

def fetch_page(url: str, *, max_retries: int = 3) -> str:
    """
    Fetch a Google Patents page with full browser-like headers and
    exponential-backoff retry on 429 / 503 (rate-limit / transient errors).
    Raises the last HTTPError if all attempts are exhausted.
    """
    headers = {
        "User-Agent":                random.choice(_UA_POOL),
        "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language":           "en-US,en;q=0.9",
        "Accept-Encoding":           "gzip, deflate, br",
        "Connection":                "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest":            "document",
        "Sec-Fetch-Mode":            "navigate",
        "Sec-Fetch-Site":            "none",
        "Sec-Fetch-User":            "?1",
        "Cache-Control":             "max-age=0",
    }
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            resp = requests.get(url, headers=headers, timeout=25)
            resp.raise_for_status()
            return resp.text
        except requests.HTTPError as exc:
            sc = exc.response.status_code
            if sc in (429, 503) and attempt < max_retries:
                wait = (2 ** attempt) + random.uniform(0.5, 2.5)
                print(f"  [fetch] HTTP {sc} on attempt {attempt + 1}/{max_retries + 1} "
                      f"— retrying in {wait:.1f}s …")
                _time.sleep(wait)
                last_exc = exc
                # Rotate UA on retry to reduce fingerprint consistency
                headers["User-Agent"] = random.choice(_UA_POOL)
            else:
                raise
    raise last_exc  # type: ignore[misc]


def get_metas(html: str) -> dict[str, list[str]]:
    """Return all <meta name="..." content="..."> values grouped by name."""
    result: dict[str, list[str]] = {}
    for name, val in re.findall(
        r'<meta\s+name="([^"]+)"\s+content="([^"]*)"', html
    ):
        result.setdefault(name, []).append(val.strip())
    return result


def parse_family(html: str) -> list[dict]:
    """
    Parse the 'Similar Documents' (patent family) table.
    Returns list of {pub_num, date, title, lang, href}.
    """
    family_match = re.search(
        r"Similar Documents(.*?)(?:<h2|<section)", html, re.DOTALL
    )
    if not family_match:
        return []

    section = family_match.group(1)
    members = []

    for row in re.split(r'itemprop="similarDocuments"', section)[1:]:
        pub_num = _first(re.findall(r'itemprop="publicationNumber">(.*?)</span>', row))
        lang    = _first(re.findall(r'itemprop="primaryLanguage">(.*?)</span>', row))
        href    = _first(re.findall(r'href="(/patent/[^"]+)"', row))
        date    = _first(re.findall(r'<time[^>]+datetime="([^"]+)"', row))
        title   = _first(re.findall(r'<td itemprop="title">(.*?)</td>', row, re.DOTALL))

        if pub_num:
            members.append({
                "pub_num": pub_num,
                "lang": lang or "",
                "href": ("https://patents.google.com" + href) if href else "",
                "date": date or "",
                "title": title.strip() if title else "",
            })

    return members


_DEP_PAT = re.compile(
    r'^The\s+\S[\S\s]{0,60}?\s+(?:of|according\s+to)\s+claim\s+\d+',
    re.IGNORECASE,
)


def parse_claims(html: str) -> list[dict]:
    """
    Parse patent claims from Google Patents HTML.
    Returns list of {num, text, independent}.
    """
    cm = re.search(r'itemprop="claims"[^>]*>(.*?)</section', html, re.DOTALL)
    if not cm:
        return []
    raw_blocks = re.findall(
        r'<div[^>]+class="claim"[^>]*>(.*?)(?=<div[^>]+class="claim"|$)',
        cm.group(1), re.DOTALL,
    )

    def _clean(s: str) -> str:
        s = re.sub(r'<[^>]+>', ' ', s)
        return re.sub(r'\s+', ' ', s).strip()

    claims = []
    for block in raw_blocks:
        text = _clean(block)
        m = re.match(r'^(\d+)\.\s+(.*)', text, re.DOTALL)
        if not m:
            continue
        body = m.group(2).strip()
        claims.append({
            "num": int(m.group(1)),
            "text": body,
            "independent": not _DEP_PAT.match(body),
        })
    return claims


def _first(lst: list) -> Optional[str]:
    return lst[0] if lst else None


# ── Display ──────────────────────────────────────────────────────────────────

def bar(char="═"):
    print(char * W)

def rule():
    print("─" * W)

def display(metas: dict, family: list, url: str):
    bar()
    print("  PATENT FAMILY TRACKER".center(W))
    bar()

    # ── Core fields ──
    number   = _first(metas.get("citation_patent_number", []))
    app_num  = _first(metas.get("citation_patent_application_number", []))
    title    = _first(metas.get("DC.title", []))
    abstract = _first(metas.get("DC.description", []))
    pdf      = _first(metas.get("citation_pdf_url", []))

    dates        = metas.get("DC.date", [])
    filing_date  = dates[0] if len(dates) > 0 else "N/A"
    grant_date   = dates[1] if len(dates) > 1 else "N/A"

    contributors = metas.get("DC.contributor", [])

    # Heuristic: last contributor entry is typically the assignee (org name)
    # Inventors tend to be "First Last"; assignees look like multi-word org names.
    inventors  = []
    assignees  = []
    for c in contributors:
        # Simple heuristic: if it contains common corp words or no comma → org
        words = c.strip().split()
        if len(words) >= 3 or any(
            kw in c for kw in ("LLC", "Inc", "Corp", "Ltd", "Company", "Institute", "University")
        ):
            assignees.append(c.strip())
        else:
            inventors.append(c.strip())

    print(f"\n  Patent   : {number or 'N/A'}")
    if title:
        print(f"  Title    : {title.strip()}")
    print(f"  Filed    : {filing_date}")
    print(f"  Granted  : {grant_date}")
    if app_num:
        print(f"  App No   : {app_num}")
    if assignees:
        print(f"  Assignee : {'; '.join(assignees)}")
    if inventors:
        inv_str = "; ".join(inventors[:6])
        if len(inventors) > 6:
            inv_str += f" (+{len(inventors)-6} more)"
        print(f"  Inventors: {inv_str}")
    if pdf:
        print(f"  PDF      : {pdf}")
    print(f"  Source   : {url}")

    if abstract:
        short = abstract.strip()[:500]
        if len(abstract.strip()) > 500:
            short = short.rsplit(" ", 1)[0] + " …"
        print(f"\n  Abstract :\n  {short}")

    # ── Citations / relations ──
    relations = metas.get("DC.relation", [])
    if relations:
        rule()
        print(f"  Cited Prior Art / Related Publications  ({len(relations)})")
        rule()
        for r in relations:
            print(f"    {r}")

    # ── Patent family ──
    rule()
    if family:
        print(f"  Patent Family  ({len(family)} members)")
        rule()
        # Group by language/jurisdiction
        for m in sorted(family, key=lambda x: x["date"] or ""):
            lang  = f" ({m['lang']})" if m['lang'] else ""
            date  = m['date']
            pnum  = m['pub_num']
            mtitle = (m['title'] or "—")[:60]
            print(f"  {pnum:<22} {date:<12}{lang}")
            print(f"    └─ {mtitle}")
    else:
        print("  No family members found in Similar Documents table.")

    bar()
    print(f"  {len(family)} family member(s)  |  {len(relations)} prior art citation(s)")
    bar()
    print()


# ── HTML Dashboard ───────────────────────────────────────────────────────────

def generate_html(metas: dict, family: list, url: str, patent_input: str) -> str:
    number   = _first(metas.get("citation_patent_number", [])) or "N/A"
    app_num  = _first(metas.get("citation_patent_application_number", []))
    title    = (_first(metas.get("DC.title", [])) or "").strip()
    abstract = (_first(metas.get("DC.description", [])) or "").strip()
    pdf      = _first(metas.get("citation_pdf_url", []))
    relations = metas.get("DC.relation", [])

    dates       = metas.get("DC.date", [])
    filing_date = dates[0] if len(dates) > 0 else "N/A"
    grant_date  = dates[1] if len(dates) > 1 else "N/A"

    contributors = metas.get("DC.contributor", [])
    inventors, assignees = [], []
    for c in contributors:
        words = c.strip().split()
        if len(words) >= 3 or any(
            kw in c for kw in ("LLC", "Inc", "Corp", "Ltd", "Company", "Institute", "University")
        ):
            assignees.append(c.strip())
        else:
            inventors.append(c.strip())

    def tag(label, value, href=None):
        if not value:
            return ""
        val_html = f'<a href="{href}" target="_blank">{value}</a>' if href else value
        return f'<tr><th>{label}</th><td>{val_html}</td></tr>\n'

    core_rows = (
        tag("Patent", number)
        + tag("Application", app_num)
        + tag("Filed", filing_date)
        + tag("Granted", grant_date)
        + tag("Assignee", "; ".join(assignees) if assignees else None)
        + tag("Inventors", "; ".join(inventors) if inventors else None)
        + tag("PDF", "Download PDF", href=pdf)
        + tag("Google Patents", url, href=url)
    )

    family_rows = ""
    for m in sorted(family, key=lambda x: x["date"] or ""):
        lang  = f" <span class='lang'>({m['lang']})</span>" if m['lang'] else ""
        mtitle = m['title'] or "—"
        link  = f'<a href="{m["href"]}" target="_blank">{m["pub_num"]}</a>' if m["href"] else m["pub_num"]
        family_rows += (
            f"<tr>"
            f"<td>{link}{lang}</td>"
            f"<td>{m['date']}</td>"
            f"<td>{mtitle}</td>"
            f"</tr>\n"
        )

    prior_art_rows = "".join(
        '<tr><td><a href="https://patents.google.com/patent/{}/en" target="_blank">{}</a></td></tr>\n'.format(
            r.replace(":", ""), r
        )
        for r in relations
    )

    family_section = f"""
    <section>
      <h2>Patent Family <span class="badge">{len(family)}</span></h2>
      <table>
        <thead><tr><th>Publication</th><th>Date</th><th>Title</th></tr></thead>
        <tbody>{family_rows or "<tr><td colspan='3'>No family members found.</td></tr>"}</tbody>
      </table>
    </section>""" if True else ""

    prior_art_section = f"""
    <section>
      <h2>Cited Prior Art <span class="badge">{len(relations)}</span></h2>
      <table>
        <thead><tr><th>Publication Number</th></tr></thead>
        <tbody>{prior_art_rows}</tbody>
      </table>
    </section>""" if relations else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Patent {number}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f0f2f5; color: #1a1a2e; line-height: 1.6; padding: 2rem; }}
    header {{ background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
              color: #fff; border-radius: 12px; padding: 2rem 2.5rem; margin-bottom: 1.5rem; }}
    header h1 {{ font-size: 1.1rem; font-weight: 500; opacity: .7; letter-spacing: .05em; text-transform: uppercase; }}
    header h2 {{ font-size: 1.6rem; font-weight: 700; margin-top: .4rem; }}
    header .meta {{ margin-top: 1rem; display: flex; gap: 1.5rem; flex-wrap: wrap; font-size: .9rem; opacity: .85; }}
    header .meta span {{ background: rgba(255,255,255,.1); border-radius: 6px; padding: .2rem .7rem; }}
    section {{ background: #fff; border-radius: 12px; padding: 1.5rem 2rem;
               margin-bottom: 1.5rem; box-shadow: 0 1px 4px rgba(0,0,0,.06); }}
    section h2 {{ font-size: 1rem; font-weight: 600; text-transform: uppercase;
                  letter-spacing: .07em; color: #0f3460; margin-bottom: 1rem;
                  display: flex; align-items: center; gap: .6rem; }}
    .badge {{ background: #e8f0fe; color: #1a73e8; border-radius: 20px;
              padding: .1rem .6rem; font-size: .8rem; font-weight: 700; }}
    table {{ width: 100%; border-collapse: collapse; font-size: .92rem; }}
    th, td {{ padding: .55rem .75rem; text-align: left; border-bottom: 1px solid #f0f0f0; }}
    thead th {{ background: #f8f9fa; font-weight: 600; color: #555; font-size: .8rem;
                text-transform: uppercase; letter-spacing: .05em; }}
    tbody tr:last-child td {{ border-bottom: none; }}
    tbody tr:hover td {{ background: #fafbff; }}
    table.core th {{ width: 130px; color: #666; font-weight: 500; }}
    a {{ color: #1a73e8; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .lang {{ color: #888; font-size: .85em; }}
    .abstract {{ background: #f8f9fa; border-left: 3px solid #0f3460;
                 border-radius: 0 8px 8px 0; padding: 1rem 1.25rem;
                 font-size: .93rem; color: #333; line-height: 1.7; }}
    footer {{ text-align: center; font-size: .8rem; color: #999; margin-top: 1rem; }}
  </style>
</head>
<body>
  <header>
    <h1>Patent Family Tracker</h1>
    <h2>{title or number}</h2>
    <div class="meta">
      <span>&#128196; {number}</span>
      <span>&#128197; Filed {filing_date}</span>
      <span>&#9989; Granted {grant_date}</span>
      {f'<span>&#127970; {"; ".join(assignees)}</span>' if assignees else ""}
    </div>
  </header>

  <section>
    <h2>Core Details</h2>
    <table class="core"><tbody>{core_rows}</tbody></table>
  </section>

  {f'''<section>
    <h2>Abstract</h2>
    <div class="abstract">{abstract}</div>
  </section>''' if abstract else ""}

  {family_section}

  {prior_art_section}

  <footer>Generated by patent-research-tool &mdash; {patent_input}</footer>
</body>
</html>"""


def save_and_open_html(html: str, number: str) -> str:
    safe = re.sub(r"[^A-Z0-9]", "", number.upper()) or "patent"
    out_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(out_dir, f"patent_{safe}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


# ── Prosecution Dashboard ────────────────────────────────────────────────────

COUNTRY_NAMES = {
    "US": "United States",  "WO": "Int'l (PCT)",    "EP": "Europe (EPO)",
    "CN": "China",          "JP": "Japan",           "KR": "South Korea",
    "AU": "Australia",      "CA": "Canada",          "GB": "United Kingdom",
    "DE": "Germany",        "FR": "France",          "IT": "Italy",
    "ES": "Spain",          "NL": "Netherlands",     "SE": "Sweden",
    "CH": "Switzerland",    "BE": "Belgium",         "AT": "Austria",
    "DK": "Denmark",        "FI": "Finland",         "NO": "Norway",
    "PL": "Poland",         "PT": "Portugal",        "CZ": "Czechia",
    "RO": "Romania",        "HU": "Hungary",         "IE": "Ireland",
    "GR": "Greece",         "BG": "Bulgaria",        "SK": "Slovakia",
    "HR": "Croatia",        "SI": "Slovenia",        "LT": "Lithuania",
    "LV": "Latvia",         "EE": "Estonia",         "LU": "Luxembourg",
    "MT": "Malta",          "CY": "Cyprus",          "IS": "Iceland",
    "LI": "Liechtenstein",  "MC": "Monaco",          "SM": "San Marino",
    "TR": "Türkiye",        "AL": "Albania",         "RS": "Serbia",
    "ME": "Montenegro",     "MK": "N. Macedonia",
    "IN": "India",          "BR": "Brazil",          "MX": "Mexico",
    "RU": "Russia",         "ZA": "South Africa",    "IL": "Israel",
    "SG": "Singapore",      "MY": "Malaysia",        "TW": "Taiwan",
    "NZ": "New Zealand",    "AR": "Argentina",       "CL": "Chile",
    "CO": "Colombia",       "EG": "Egypt",           "MA": "Morocco",
    "SA": "Saudi Arabia",   "AE": "UAE",             "UA": "Ukraine",
}
COUNTRY_FLAGS = {
    "US": "🇺🇸", "WO": "🌍", "EP": "🇪🇺", "CN": "🇨🇳", "JP": "🇯🇵",
    "KR": "🇰🇷", "AU": "🇦🇺", "CA": "🇨🇦", "GB": "🇬🇧", "DE": "🇩🇪",
    "FR": "🇫🇷", "IT": "🇮🇹", "ES": "🇪🇸", "NL": "🇳🇱", "SE": "🇸🇪",
    "CH": "🇨🇭", "BE": "🇧🇪", "AT": "🇦🇹", "DK": "🇩🇰", "FI": "🇫🇮",
    "NO": "🇳🇴", "PL": "🇵🇱", "PT": "🇵🇹", "CZ": "🇨🇿", "RO": "🇷🇴",
    "HU": "🇭🇺", "IE": "🇮🇪", "GR": "🇬🇷", "BG": "🇧🇬", "SK": "🇸🇰",
    "HR": "🇭🇷", "SI": "🇸🇮", "LT": "🇱🇹", "LV": "🇱🇻", "EE": "🇪🇪",
    "LU": "🇱🇺", "MT": "🇲🇹", "CY": "🇨🇾", "IS": "🇮🇸", "LI": "🇱🇮",
    "MC": "🇲🇨", "TR": "🇹🇷", "IN": "🇮🇳", "BR": "🇧🇷", "MX": "🇲🇽",
    "RU": "🇷🇺", "ZA": "🇿🇦", "IL": "🇮🇱", "SG": "🇸🇬", "MY": "🇲🇾",
    "TW": "🇹🇼", "NZ": "🇳🇿", "AR": "🇦🇷", "CL": "🇨🇱", "CO": "🇨🇴",
    "EG": "🇪🇬", "MA": "🇲🇦", "SA": "🇸🇦", "AE": "🇦🇪", "UA": "🇺🇦",
}

# EPO-designated European jurisdictions: the EP regional patent itself plus all
# EPC full member states (38 countries, all geographically in Europe).
# Any EPO INPADOC member whose country code is NOT in this set is treated as a
# non-European filing and rendered as a first-class tile in the main dashboard.
_EUROPEAN_COUNTRY_CODES: frozenset[str] = frozenset({
    "EP",
    "AL", "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE",
    "ES", "FI", "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT",
    "LI", "LT", "LU", "LV", "MC", "ME", "MK", "MT", "NL", "NO",
    "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "TR",
})
STATUS_META = {
    "granted":   {"label": "Granted",   "bg": "#d1fae5", "fg": "#065f46", "border": "#34d399"},
    "pending":   {"label": "Pending",   "bg": "#dbeafe", "fg": "#1e40af", "border": "#60a5fa"},
    "abandoned": {"label": "Abandoned", "bg": "#f3f4f6", "fg": "#374151", "border": "#9ca3af"},
    "rejected":  {"label": "Rejected",  "bg": "#fee2e2", "fg": "#991b1b", "border": "#f87171"},
    "expired":   {"label": "Expired",   "bg": "#fef3c7", "fg": "#92400e", "border": "#fbbf24"},
    "unknown":   {"label": "Unknown",   "bg": "#f9fafb", "fg": "#6b7280", "border": "#d1d5db"},
}
_PREFERRED_COUNTRIES = ["US", "WO", "EP", "JP", "CN", "KR", "AU", "CA", "GB", "DE", "FR"]


def country_code(pub_num: str) -> str:
    m = re.match(r"^([A-Z]{2})", re.sub(r"[^A-Z0-9]", "", pub_num.upper()))
    return m.group(1) if m else "??"


def infer_status(pub_num: str, html: str = "") -> str:
    clean = re.sub(r"[^A-Z0-9]", "", pub_num.upper())
    m = re.search(r"([A-Z])(\d?)$", clean)
    base = "unknown"
    if m:
        letter = m.group(1)
        base = "granted" if letter == "B" else ("pending" if letter == "A" else "unknown")
    if html:
        if re.search(r"(?:status|legal)[^<]{0,60}(?:Abandoned|Lapsed)", html[:20000], re.IGNORECASE):
            return "abandoned"
        if re.search(r"(?:status|legal)[^<]{0,60}Expired", html[:20000], re.IGNORECASE):
            return "expired"
    return base


def parse_legal_events(html: str) -> list[dict]:
    events: list[dict] = []

    # Strategy 1: itemprop="legalEvents" table rows (primary Google Patents structure)
    for row in re.findall(
        r'<tr[^>]*itemprop="legalEvents"[^>]*>(.*?)</tr>', html, re.DOTALL
    ):
        date  = _first(re.findall(r'datetime="([^"]+)"', row))
        code  = _first(re.findall(r'itemprop="code"[^>]*>([^<]+)', row))
        title = _first(re.findall(r'itemprop="title"[^>]*>([^<]+)', row))
        value = _first(re.findall(r'itemprop="value"[^>]*>([^<]+)', row))
        if date or title:
            events.append({
                "date":  (date  or "").strip(),
                "code":  (code  or "").strip(),
                "title": (title or "").strip(),
                "value": (value or "").strip(),
            })

    if events:
        return sorted(events, key=lambda x: x.get("date") or "")

    # Strategy 2: JSON-LD embedded data
    for jtext in re.findall(
        r'<script[^>]*application/ld\+json[^>]*>\s*(.*?)\s*</script>', html, re.DOTALL
    ):
        try:
            data = _json.loads(jtext)
            if not isinstance(data, dict):
                continue
            for key in ("events", "legalEvents", "prosecutionHistory", "applicationEvents"):
                for e in data.get(key, []):
                    if isinstance(e, dict):
                        events.append({
                            "date":  e.get("date", e.get("datePublished", "")),
                            "code":  e.get("eventCode", e.get("code", e.get("type", ""))),
                            "title": e.get("title", e.get("name", e.get("description", ""))),
                            "value": "",
                        })
        except Exception:
            pass

    if events:
        return sorted(events, key=lambda x: x.get("date") or "")

    # Strategy 3: itemprop="event" blocks (older schema)
    for bm in re.finditer(
        r'itemprop="event"[^>]*>(.*?)(?=itemprop="event"|</(?:section|div)>)',
        html, re.DOTALL
    ):
        seg = bm.group(1)
        date  = _first(re.findall(r'datetime="([^"]+)"', seg))
        code  = _first(re.findall(r'itemprop="(?:code|eventCode)"[^>]*>([^<]+)', seg))
        title = _first(re.findall(r'itemprop="(?:title|name)"[^>]*>([^<]+)', seg))
        if date or title:
            events.append({"date": date or "", "code": code or "", "title": title or "", "value": ""})

    if events:
        return sorted(events, key=lambda x: x.get("date") or "")

    # Strategy 4: table inside id="legal" / id="events" section
    lm = re.search(
        r'id="(?:legal|legalEvents|events)"[^>]*>(.*?)(?:</section>|<h[123])',
        html, re.DOTALL
    )
    if lm:
        for row in re.findall(r"<tr[^>]*>(.*?)</tr>", lm.group(1), re.DOTALL):
            cells = [
                re.sub(r"<[^>]+>", "", c).strip()
                for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
            ]
            if len(cells) >= 2:
                dm = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2})", cells[0])
                if dm:
                    events.append({
                        "date":  dm.group(1),
                        "code":  cells[1] if len(cells) > 1 else "",
                        "title": cells[2] if len(cells) > 2 else "",
                        "value": "",
                    })

    return sorted(events, key=lambda x: x.get("date") or "")


def parse_rejections(html: str) -> list[str]:
    seen: set[str] = set()
    results: list[str] = []
    for m in re.finditer(
        r"(?:35 U\.S\.C\.?\s*[§Ss]?\s*\d+[\w()]*"
        r"|rejection under\s+[§Ss]?\s*\d+"
        r"|(?:final|non-final)\s+(?:office action|rejection))",
        html, re.IGNORECASE
    ):
        text = re.sub(r"\s+", " ", m.group()).strip()
        key = text.lower()
        if key not in seen:
            seen.add(key)
            results.append(text)
        if len(results) >= 5:
            break
    return results


def parse_backward_refs(html: str) -> list[dict]:
    """Parse examiner-cited prior art from Google Patents HTML."""
    refs = []
    for row in re.findall(
        r'<tr[^>]*itemprop="backwardReferences"[^>]*>(.*?)</tr>', html, re.DOTALL
    ):
        pub      = _first(re.findall(r'itemprop="publicationNumber"[^>]*>\s*([^<]+)', row))
        date     = _first(re.findall(r'itemprop="publicationDate"[^>]*>\s*([^<]+)', row))
        assignee = _first(re.findall(r'itemprop="assignee"[^>]*>\s*([^<]+)', row))
        title    = _first(re.findall(r'itemprop="title"[^>]*>\s*([^<]+)', row))
        href     = _first(re.findall(r'href="(/patent/[^"]+)"', row))
        # "Cited by examiner" marker — appears as ✱ or a superscript asterisk in the cell
        is_examiner = bool(re.search(r'Cited by examiner|✱|\*\s*$', row, re.IGNORECASE))
        if pub:
            refs.append({
                "pub":      pub.strip(),
                "date":     (date     or "").strip(),
                "assignee": (assignee or "").strip(),
                "title":    (title    or "").strip(),
                "href":     ("https://patents.google.com" + href if href else ""),
                "examiner": is_examiner,
            })
    return refs


# ── Rejection summary constants ───────────────────────────────────────────────

# USPTO STPP free-format text → human-readable action
_US_OA_EVENTS: dict[str, str] = {
    "NON FINAL ACTION MAILED":        "Non-Final Rejection issued",
    "NON-FINAL ACTION MAILED":        "Non-Final Rejection issued",
    "FINAL ACTION MAILED":            "Final Rejection issued",
    "FINAL REJECTION MAILED":         "Final Rejection issued",
    "ADVISORY ACTION MAILED":         "Advisory Action issued",
    "NOTICE OF ALLOWANCE MAILED":     "Notice of Allowance issued",
    "NOTICE OF ALLOWANCE":            "Notice of Allowance issued",
    "ISSUE FEE PAYMENT VERIFIED":     "Issue fee paid — patent pending issuance",
    "RESPONSE TO NON-FINAL":          "Response to Non-Final Rejection filed",
    "RESPONSE TO FINAL":              "Response to Final Rejection filed",
    "APPEAL BRIEF":                   "Appeal Brief filed",
    "EXAMINER'S ANSWER":              "Examiner's Answer to Appeal",
    "RESTRICTION REQUIREMENT MAILED": "Restriction / Election Requirement issued",
    "ELECTION":                       "Restriction / Election response filed",
}

# §35 U.S.C. section → rejection ground info
_REJECTION_GROUNDS: dict[str, dict] = {
    "101": {
        "title":   "§101 Subject Matter Eligibility",
        "summary": "Claims are directed to patent-ineligible subject matter "
                   "(abstract ideas, laws of nature, or natural phenomena) "
                   "without a meaningful inventive concept beyond the judicial exception.",
    },
    "102": {
        "title":   "§102 Anticipation",
        "summary": "Each claim element is disclosed in a single prior art reference, "
                   "which anticipates the claimed invention.",
    },
    "103": {
        "title":   "§103 Obviousness",
        "summary": "A combination of prior art references renders the claimed invention "
                   "obvious to a person of ordinary skill in the art at the time of filing.",
    },
    "112a": {
        "title":   "§112(a) Written Description",
        "summary": "The specification does not reasonably convey that the inventor "
                   "possessed the full scope of the claimed invention as of the filing date.",
    },
    "112b": {
        "title":   "§112(b) Indefiniteness",
        "summary": "One or more claim terms fail to inform those skilled in the art "
                   "with reasonable certainty about the scope of the invention.",
    },
    "112f": {
        "title":   "§112(f) Means-Plus-Function",
        "summary": "A means-plus-function limitation lacks adequate corresponding "
                   "structure, material, or acts in the specification.",
    },
    "116":  {
        "title":   "§116 Oath or Declaration",
        "summary": "The oath or declaration of inventorship is deficient or missing.",
    },
}

# Foreign office systems for linking
_FOREIGN_SYSTEMS: dict[str, tuple[str, str]] = {
    "EP": ("EPO Register",  "https://register.epo.org/application?number="),
    "JP": ("J-PlatPat",     "https://www.j-platpat.inpit.go.jp/"),
    "CN": ("CNIPA CPQUERY", "https://cpquery.cponline.cnipa.gov.cn/"),
    "KR": ("KIPRIS",        "https://www.kipris.or.kr/"),
    "AU": ("AusPat",        "https://www.ipaustralia.gov.au/tools-resources/search-patent"),
    "CA": ("CIPO",          "https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/patents"),
    "GB": ("IPO",           "https://www.ipo.gov.uk/p-ipsum.htm"),
}


def _classify_oa_event(value: str, title: str) -> Optional[str]:
    """Map a legal event free-format text or title to a human-readable OA label."""
    combined = (value + " " + title).upper()
    for key, label in _US_OA_EVENTS.items():
        if key in combined:
            return label
    return None


def extract_rejection_summary(m: dict) -> Optional[dict]:
    """
    Build a rejection summary dict from a member's fetched data.
    Returns None if no rejection evidence is found.
    """
    cc      = country_code(m["pub_num"])
    events  = m.get("events", [])
    raw_rej = m.get("rejections", [])
    b_refs  = m.get("backward_refs", [])
    app_num = (m.get("app_num") or "").strip()

    if cc == "US":
        # Find office-action events
        oa_events: list[dict] = []
        for e in events:
            label = _classify_oa_event(e.get("value", ""), e.get("title", ""))
            if label:
                oa_events.append({"date": e["date"], "label": label,
                                   "code": e.get("code", ""), "raw": e.get("value", "")})

        has_rejection = any(
            "rejection" in ev["label"].lower() or "action" in ev["label"].lower()
            for ev in oa_events
        ) or bool(raw_rej)

        if not has_rejection:
            return None

        # Map §35 U.S.C. citations to grounds
        grounds: list[dict] = []
        seen_sec: set[str] = set()
        for r in raw_rej:
            sm = re.search(r'(\d+)\(([a-z])\)', r, re.IGNORECASE)
            sec  = re.search(r'(\d+)', r).group(1) if re.search(r'(\d+)', r) else ""
            sub  = sm.group(2).lower() if sm else ""
            key  = f"{sec}{sub}" if sub else sec
            info = _REJECTION_GROUNDS.get(key) or _REJECTION_GROUNDS.get(sec)
            if info and key not in seen_sec:
                seen_sec.add(key)
                grounds.append(info)

        # Examiner-cited references
        examiner_refs = [r for r in b_refs if r.get("examiner")]
        all_refs      = b_refs  # show all; examiner-cited flagged separately

        # Patent Center link
        clean_app = re.sub(r"[^0-9]", "", app_num)
        pc_url = (
            f"https://patentcenter.uspto.gov/applications/{clean_app}"
            if clean_app else "https://patentcenter.uspto.gov"
        )

        return {
            "cc":          "US",
            "oa_events":   oa_events,
            "grounds":     grounds,
            "refs":        all_refs,
            "examiner_refs": examiner_refs,
            "has_grounds_in_html": bool(grounds),
            "pc_url":      pc_url,
            "app_num":     app_num,
        }

    else:
        # Non-US: show available events and link to foreign office
        oa_events = [
            e for e in events
            if re.search(r'reject|office.?action|refusal|examiner',
                         e.get("title","") + e.get("value",""), re.IGNORECASE)
        ]
        if not oa_events and not raw_rej:
            return None

        system_name, system_base = _FOREIGN_SYSTEMS.get(cc, ("foreign patent office", ""))
        return {
            "cc":          cc,
            "oa_events":   oa_events,
            "grounds":     [],
            "refs":        b_refs,
            "examiner_refs": [],
            "system_name": system_name,
            "system_url":  system_base,
        }


# ── USPTO Open Data Portal (ODP) helpers ─────────────────────────────────────

def _clean_app_num(s: str) -> str:
    """Strip non-digits so '17/508,065' → '17508065'."""
    return re.sub(r"[^\d]", "", s or "")


def _odp_status_to_standard(status_text: str) -> str:
    """Map ODP applicationStatusDescriptionText to our standard status values."""
    s = (status_text or "").lower()
    if "patent" in s:      return "granted"    # "Patented Case", "Patent in Issue"
    if "abandon" in s:     return "abandoned"
    if s:                  return "pending"
    return "unknown"


def _odp_events_to_standard(event_bag: list) -> list:
    """Convert ODP eventDataBag to the same dict format as parse_legal_events."""
    events = [
        {
            "date":  e.get("eventDate",  ""),
            "code":  e.get("eventCode",  ""),
            "title": e.get("eventDescriptionText", ""),
            "value": "",
        }
        for e in (event_bag or [])
        if e.get("eventDate") or e.get("eventDescriptionText")
    ]
    return sorted(events, key=lambda x: x.get("date") or "")


def fetch_us_member_via_odp(member: dict, api_key: str) -> dict | None:
    """
    Fetch US patent family member details from the USPTO Open Data Portal
    instead of Google Patents.  Returns a result dict in the same format as
    fetch_member_details, or None if app_num is missing (caller should fall
    back to Google Patents).
    """
    app_num = _clean_app_num(member.get("app_num", ""))
    if not app_num:
        return None   # no app number stored → must fall back to GP

    result = {
        **member,
        "status":        infer_status(member.get("pub_num", "")),
        "events":        [],
        "rejections":    [],
        "backward_refs": [],
        "filing_date":   "",
        "grant_date":    "",
        "member_title":  member.get("member_title", "") or member.get("title", ""),
        "fetch_error":   None,
    }
    try:
        resp = requests.get(
            f"https://api.uspto.gov/api/v1/patent/applications/{app_num}",
            headers={"X-API-Key": api_key},
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        bag  = data["patentFileWrapperDataBag"][0]
        meta = bag.get("applicationMetaData", {})

        result["filing_date"]  = meta.get("filingDate",  "") or ""
        result["grant_date"]   = meta.get("grantDate",   "") or ""
        result["app_num"]      = _clean_app_num(bag.get("applicationNumberText") or app_num)
        result["member_title"] = (meta.get("inventionTitle") or "").strip() or result["member_title"]
        result["status"]       = _odp_status_to_standard(
                                     meta.get("applicationStatusDescriptionText", ""))
        result["events"]       = _odp_events_to_standard(bag.get("eventDataBag", []))
        # Rejections are inferred from event codes (CTNF / CTFR) rather than GP HTML
        rej_codes = {"CTNF", "CTFR", "MCTNF", "MCTFR"}
        result["rejections"] = [
            e["title"] for e in result["events"] if e.get("code") in rej_codes
        ]
    except Exception as exc:
        result["fetch_error"] = str(exc)[:80]

    return result


def fetch_member_details(member: dict, idx: int, total: int,
                         odp_api_key: str = "") -> dict:
    """
    Fetch details for one family member.

    For US patents when odp_api_key is set and the member already has an
    app_num (refresh path), this uses the USPTO Open Data Portal — zero
    Google Patents requests.  Falls back to Google Patents for non-US members
    or when app_num is unavailable (initial search path).
    """
    pub_num = member.get("pub_num", "")

    # ── Fast / reliable path: USPTO ODP for US patents ──────────────────────
    if odp_api_key and pub_num.startswith("US") and member.get("app_num"):
        print(f"  [{idx:>2}/{total}] {pub_num:<22} … (ODP) ", end="", flush=True)
        odp_result = fetch_us_member_via_odp(member, odp_api_key)
        if odp_result is not None and not odp_result.get("fetch_error"):
            print("ok")
            _time.sleep(0.05)   # tiny courtesy delay
            return odp_result
        err = (odp_result or {}).get("fetch_error", "unknown")
        print(f"ODP-err({err[:40]}), falling back to GP")

    # ── Standard path: Google Patents ───────────────────────────────────────
    result = {
        **member,
        "status":        infer_status(pub_num),
        "events":        [],
        "rejections":    [],
        "backward_refs": [],
        "filing_date":   "",
        "grant_date":    "",
        "member_title":  member.get("title", ""),
        "fetch_error":   None,
    }
    if not member.get("href"):
        return result

    print(f"  [{idx:>2}/{total}] {pub_num:<22} … ", end="", flush=True)
    try:
        page  = fetch_page(member["href"])
        metas = get_metas(page)
        dates = metas.get("DC.date", [])
        result["filing_date"]   = dates[0] if dates else ""
        result["grant_date"]    = dates[1] if len(dates) > 1 else ""
        result["app_num"]       = _first(metas.get("citation_patent_application_number", [])) or ""
        result["member_title"]  = (metas.get("DC.title", [""])[0] or member.get("title", "")).strip()
        result["status"]        = infer_status(pub_num, page)
        result["events"]        = parse_legal_events(page)
        result["backward_refs"] = parse_backward_refs(page)
        result["rejections"]    = (
            parse_rejections(page) if result["status"] in ("pending", "unknown") else []
        )
        print("ok")
    except requests.HTTPError as e:
        result["fetch_error"] = f"HTTP {e.response.status_code}"
        if e.response.status_code == 404:
            result["status"] = "unknown"
        print(f"HTTP {e.response.status_code}")
    except Exception as e:
        result["fetch_error"] = str(e)[:60]
        print("error")

    _time.sleep(0.5)
    return result


# ── Rejection summary renderer ───────────────────────────────────────────────

def _render_rejection_summary(summary: dict) -> str:
    if not summary:
        return ""

    cc = summary["cc"]

    # ── Office action timeline ──
    oa_rows = ""
    for ev in summary.get("oa_events", []):
        oa_rows += (
            f'<tr>'
            f'<td class="rej-date">{ev["date"]}</td>'
            f'<td>{ev.get("label") or ev.get("title") or ev.get("value", "")}</td>'
            f'</tr>'
        )
    oa_table = (
        f'<table class="rej-table">'
        f'<thead><tr><th>Date</th><th>Event</th></tr></thead>'
        f'<tbody>{oa_rows}</tbody>'
        f'</table>'
    ) if oa_rows else '<p class="rej-none">No office action events found in page source.</p>'

    # ── Rejection grounds (US only, from HTML patterns) ──
    grounds_html = ""
    if summary.get("grounds"):
        items = "".join(
            f'<div class="rej-ground">'
            f'  <div class="rej-ground-title">{g["title"]}</div>'
            f'  <div class="rej-ground-summary">{g["summary"]}</div>'
            f'</div>'
            for g in summary["grounds"]
        )
        grounds_html = (
            f'<div class="rej-grounds-section">'
            f'  <div class="rej-sub-label">Rejection Grounds (inferred from page text)</div>'
            f'  {items}'
            f'</div>'
        )
    elif cc == "US":
        pc_url = summary.get("pc_url", "https://patentcenter.uspto.gov")
        grounds_html = (
            f'<p class="rej-grounds-note">'
            f'  Specific grounds (§101 / §102 / §103 / §112) are in the office action '
            f'  document. '
            f'  <a href="{pc_url}" target="_blank">View full prosecution history in USPTO Patent Center ↗</a>'
            f'</p>'
        )
    else:
        sys_name = summary.get("system_name", "the foreign patent office")
        sys_url  = summary.get("system_url", "")
        sys_link = f'<a href="{sys_url}" target="_blank">{sys_name} ↗</a>' if sys_url else sys_name
        grounds_html = (
            f'<p class="rej-grounds-note">'
            f'  Detailed rejection reasons require access to {sys_link}.'
            f'</p>'
        )

    # ── Prior art references ──
    refs_html = ""
    if summary.get("refs"):
        ref_rows = ""
        for r in summary["refs"]:
            examiner_badge = '<span class="examiner-badge">Examiner</span>' if r.get("examiner") else ""
            pub_link = (
                f'<a href="{r["href"]}" target="_blank">{r["pub"]}</a>'
                if r.get("href") else r["pub"]
            )
            ref_rows += (
                f'<tr>'
                f'<td>{pub_link} {examiner_badge}</td>'
                f'<td>{r.get("date","")}</td>'
                f'<td>{r.get("assignee","")}</td>'
                f'<td class="ref-title">{r.get("title","")}</td>'
                f'</tr>'
            )
        refs_html = (
            f'<details class="history rej-refs-details">'
            f'<summary>Prior Art References <span class="ev-count">{len(summary["refs"])}</span></summary>'
            f'<table class="hist-table">'
            f'<thead><tr><th>Publication</th><th>Date</th><th>Assignee</th><th>Title</th></tr></thead>'
            f'<tbody>{ref_rows}</tbody>'
            f'</table>'
            f'</details>'
        )

    return (
        f'<div class="rej-summary">'
        f'  <div class="rej-summary-label">Rejection Summary</div>'
        f'  {oa_table}'
        f'  {grounds_html}'
        f'  {refs_html}'
        f'</div>'
    )


# ── EPO OPS Integration ───────────────────────────────────────────────────────

def _load_dotenv() -> None:
    """Load .env file from script directory into os.environ (no external deps)."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


# ── DeepL translation ────────────────────────────────────────────────────────

_DEEPL_FREE_URL = "https://api-free.deepl.com/v2/translate"
# Languages that are natively English — skip translation for these
_ENGLISH_LANGS   = {"en", "en-us", "en-gb", "en-au", "en-ca"}


def deepl_translate(texts: list[str], target_lang: str = "EN-US") -> list[dict] | None:
    """
    Translate a batch of texts with the DeepL free API.
    Source language is auto-detected per text.
    Returns list of {text, detected_source_language} or None on error/missing key.
    Filters out texts that are already English before sending.
    """
    api_key = os.environ.get("DEEPL_API_KEY", "").strip()
    if not api_key:
        return None
    texts = [t.strip() for t in texts]
    if not any(texts):
        return None
    try:
        resp = requests.post(
            _DEEPL_FREE_URL,
            headers={"Authorization": f"DeepL-Auth-Key {api_key}",
                     "Content-Type": "application/json"},
            json={"text": texts, "target_lang": target_lang},
            timeout=20,
        )
        resp.raise_for_status()
        return resp.json().get("translations", [])
    except Exception as exc:
        print(f"  DeepL error: {exc}")
        return None


# Country codes whose primary official language is not English
_NON_ENGLISH_COUNTRIES = {
    "CN", "JP", "KR", "DE", "FR", "IT", "ES", "RU", "NL", "PT",
    "PL", "SE", "FI", "NO", "DK", "CZ", "SK", "HU", "RO", "BG",
    "HR", "SI", "LT", "LV", "EE", "TR", "UA", "TW", "BR", "MX",
    "AR", "CL", "CO",
}


def needs_translation(lang: str, cc: str = "") -> bool:
    """
    Return True if text likely needs translating to English.
    Uses explicit lang tag when set, falls back to country code.
    """
    if lang and lang.lower() not in _ENGLISH_LANGS:
        return True
    if not lang and cc.upper() in _NON_ENGLISH_COUNTRIES:
        return True
    return False


def patent_to_docdb(patent_id: str) -> Optional[str]:
    """
    Convert a raw patent ID to EPO OPS docdb format CC.NNNNNNNN.KK.
    e.g. 'US 12,178,560 B2' → 'US.12178560.B2'
         'US12178560'       → 'US.12178560.B2'  (assumes B2)
    """
    clean = normalize(patent_id)
    m = re.match(r'^([A-Z]{2})(\d+)([A-Z]\d?)$', clean)
    if m:
        return f"{m.group(1)}.{m.group(2)}.{m.group(3)}"
    m = re.match(r'^([A-Z]{2})(\d+)$', clean)
    if m:
        default_kind = "B2" if m.group(1) == "US" else "B1"
        return f"{m.group(1)}.{m.group(2)}.{default_kind}"
    return None


def epo_get_token(consumer_key: str, consumer_secret: str) -> Optional[str]:
    """Obtain an OAuth2 access token from EPO OPS."""
    creds = base64.b64encode(f"{consumer_key}:{consumer_secret}".encode()).decode()
    try:
        resp = requests.post(
            "https://ops.epo.org/3.2/auth/accesstoken",
            headers={
                "Authorization": f"Basic {creds}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials"},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json().get("access_token")
    except Exception as exc:
        print(f"  EPO auth error: {exc}")
        return None


def _fmt_epo_date(d: str) -> str:
    """Convert YYYYMMDD → YYYY-MM-DD; pass through anything else."""
    d = (d or "").strip()
    if len(d) == 8 and d.isdigit():
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d


def fetch_epo_family(docdb: str, token: str) -> Optional[str]:
    """GET the INPADOC family XML from EPO OPS for a docdb publication number."""
    url = f"https://ops.epo.org/3.2/rest-services/family/publication/docdb/{docdb}"
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/xml"},
            timeout=20,
        )
        resp.raise_for_status()
        return resp.text
    except requests.HTTPError as exc:
        print(f"  EPO family HTTP {exc.response.status_code}")
        return None
    except Exception as exc:
        print(f"  EPO family error: {exc}")
        return None


def parse_epo_family(xml: str) -> list[dict]:
    """
    Parse EPO OPS INPADOC family XML.
    Returns list of dicts: country, pub_num, app_num, pub_date, app_date, kind.
    """
    members: list[dict] = []
    for member_xml in re.findall(
        r'<ops:family-member[^>]*>(.*?)</ops:family-member>', xml, re.DOTALL
    ):
        # ── Publication references ──
        pub_docs: list[dict] = []
        for pub_ref in re.findall(
            r'<publication-reference[^>]*>(.*?)</publication-reference>',
            member_xml, re.DOTALL,
        ):
            for doc_id in re.findall(
                r'<document-id[^>]*>(.*?)</document-id>', pub_ref, re.DOTALL
            ):
                cc  = _first(re.findall(r'<country>\s*([^<]+?)\s*</country>', doc_id))
                num = _first(re.findall(r'<doc-number>\s*([^<]+?)\s*</doc-number>', doc_id))
                knd = _first(re.findall(r'<kind>\s*([^<]+?)\s*</kind>', doc_id))
                dt  = _first(re.findall(r'<date>\s*([^<]+?)\s*</date>', doc_id))
                if cc and num:
                    pub_docs.append({"cc": cc, "num": num.strip(), "kind": knd or "", "date": dt or ""})

        # ── Application references ──
        app_docs: list[dict] = []
        for app_ref in re.findall(
            r'<application-reference[^>]*>(.*?)</application-reference>',
            member_xml, re.DOTALL,
        ):
            for doc_id in re.findall(
                r'<document-id[^>]*>(.*?)</document-id>', app_ref, re.DOTALL
            ):
                cc  = _first(re.findall(r'<country>\s*([^<]+?)\s*</country>', doc_id))
                num = _first(re.findall(r'<doc-number>\s*([^<]+?)\s*</doc-number>', doc_id))
                dt  = _first(re.findall(r'<date>\s*([^<]+?)\s*</date>', doc_id))
                if cc and num:
                    app_docs.append({"cc": cc, "num": num.strip(), "date": dt or ""})

        if not pub_docs:
            continue

        pub = pub_docs[0]
        app = app_docs[0] if app_docs else {}
        pub_num = f"{pub['cc']}{pub['num']}{pub['kind']}" if pub['kind'] else f"{pub['cc']}{pub['num']}"
        app_num = f"{app.get('cc','')}{app.get('num','')}" if app else ""

        members.append({
            "country":  pub["cc"],
            "pub_num":  pub_num,
            "app_num":  app_num,
            "pub_date": _fmt_epo_date(pub["date"]),
            "app_date": _fmt_epo_date(app.get("date", "")),
            "kind":     pub["kind"],
        })
    return members


def merge_epo_with_google(
    google_details: list[dict], epo_members: list[dict]
) -> tuple[list[dict], list[dict]]:
    """
    Compare EPO INPADOC family with Google Patents family members.
    Returns:
        epo_only      — EPO members whose country is absent from Google data
        discrepancies — same country in both sources with differing pub numbers
    """
    google_countries  = {country_code(m["pub_num"]) for m in google_details}
    google_pub_norms  = {normalize(m["pub_num"]) for m in google_details}
    epo_only:      list[dict] = []
    discrepancies: list[dict] = []
    seen_epo_countries: set[str] = set()

    for em in epo_members:
        cc       = em["country"]
        norm_pub = normalize(em["pub_num"])
        if cc in seen_epo_countries:
            continue
        if cc not in google_countries:
            epo_only.append(em)
        elif norm_pub not in google_pub_norms:
            for gm in google_details:
                if country_code(gm["pub_num"]) == cc and normalize(gm["pub_num"]) != norm_pub:
                    discrepancies.append({
                        "country":    cc,
                        "epo_pub":    em["pub_num"],
                        "epo_app":    em["app_num"],
                        "google_pub": gm["pub_num"],
                        "google_app": gm.get("app_num", ""),
                        "note": (
                            f"{COUNTRY_NAMES.get(cc, cc)}: EPO lists {em['pub_num']} "
                            f"but Google Patents shows {gm['pub_num']}"
                        ),
                    })
        seen_epo_countries.add(cc)

    return epo_only, discrepancies


def _epo_member_status(kind: str) -> str:
    """Infer patent status from EPO kind code."""
    if not kind:
        return "unknown"
    if kind.startswith("B"):
        return "granted"
    if kind.startswith("A"):
        return "pending"
    return "unknown"


def _epo_to_family_member(em: dict) -> dict:
    """
    Convert an EPO INPADOC member dict (from parse_epo_family) to the
    family_details format expected by _render_card and generate_dashboard_html.
    Used to promote non-European EPO members into first-class dashboard tiles.
    """
    status = _epo_member_status(em["kind"])
    return {
        "pub_num":      em["pub_num"],
        "app_num":      em.get("app_num", ""),
        "status":       status,
        "filing_date":  em.get("app_date", ""),
        "grant_date":   em.get("pub_date", "") if status == "granted" else "",
        "date":         em.get("pub_date", "") or em.get("app_date", ""),
        "title":        "",
        "abstract":     "",
        "events":       [],
        "backward_refs": [],
    }


def _render_epo_section(
    epo_only: Optional[list], discrepancies: Optional[list]
) -> str:
    """
    Render EPO-only family members and consistency check sections.
    Pass None for both args if EPO integration was not configured/run.
    """
    if epo_only is None:
        return ""

    # ── EPO-only cards ──
    cards_html = ""
    for em in sorted(epo_only, key=lambda x: x["country"]):
        cc     = em["country"]
        status = _epo_member_status(em["kind"])
        s      = STATUS_META.get(status, STATUS_META["unknown"])
        badge  = (
            f'<span class="status-badge" style="background:{s["bg"]};color:{s["fg"]};'
            f'border:1.5px solid {s["border"]}">{s["label"]}</span>'
        )
        norm_pub = normalize(em["pub_num"])
        gp_url   = f"https://patents.google.com/patent/{norm_pub}/en"
        pub_link = f'<a href="{gp_url}" target="_blank">{em["pub_num"]}</a>'

        expiry_html = ""
        if em.get("app_date"):
            try:
                fd     = _date.fromisoformat(em["app_date"])
                expiry = _add_months(fd, 240)
                expiry_html = (
                    f'<div class="ann-expiry">Est. expiry: <b>{expiry.isoformat()}</b></div>'
                )
            except (ValueError, TypeError):
                pass

        dates_html = ""
        if em.get("app_date"):
            dates_html += f'<span>Filed: <b>{em["app_date"]}</b></span>'
        if em.get("pub_date"):
            second_label = "Granted" if status == "granted" else "Published"
            dates_html += f'<span>{second_label}: <b>{em["pub_date"]}</b></span>'

        cards_html += (
            f'<div class="card epo-card" style="border-top:4px solid {s["border"]}">'
            f'  <div class="card-head">'
            f'    <span class="card-pnum">{pub_link}</span>'
            f'    {badge}'
            f'  </div>'
            f'  <div class="card-dates epo-meta">'
            f'    <span class="epo-source-badge">EPO OPS</span>'
            + (f'    <span>App: <b>{em["app_num"]}</b></span>' if em.get("app_num") else '')
            + f'  </div>'
            + (f'  <div class="card-dates">{dates_html}</div>' if dates_html else '')
            + expiry_html
            + '</div>'
        )

    epo_section = ""
    if epo_only:
        epo_section = (
            f'<section class="country-section epo-only-section">'
            f'  <h2 class="country-h epo-section-h">'
            f'    &#127760; EPO-Only Family Members'
            f'    <span class="country-count">{len(epo_only)}</span>'
            f'    <span class="epo-source-label">via INPADOC</span>'
            f'  </h2>'
            f'  <p class="epo-note">These jurisdictions appear in the EPO INPADOC family '
            f'but are not reflected in Google Patents\' Similar Documents table.</p>'
            f'  <div class="cards-grid">{cards_html}</div>'
            f'</section>'
        )

    # ── Consistency check ──
    check_html = ""
    if discrepancies:
        rows = ""
        for d in discrepancies:
            flag  = COUNTRY_FLAGS.get(d["country"], "")
            cname = COUNTRY_NAMES.get(d["country"], d["country"])
            rows += (
                f'<tr>'
                f'<td>{flag} {cname}</td>'
                f'<td>{d["epo_pub"]}</td>'
                f'<td>{d["epo_app"] or "—"}</td>'
                f'<td>{d["google_pub"]}</td>'
                f'<td>{d["google_app"] or "—"}</td>'
                f'<td class="disc-note">{d["note"]}</td>'
                f'</tr>'
            )
        check_html = (
            f'<section class="info-section consistency-section">'
            f'  <h2 class="section-h">&#9888; Consistency Check'
            f'    <span class="cnt-badge">{len(discrepancies)} '
            f'flag{"s" if len(discrepancies) != 1 else ""}</span>'
            f'  </h2>'
            f'  <p class="cons-note">Discrepancies found between EPO INPADOC and '
            f'Google Patents data for the same jurisdiction.</p>'
            f'  <div class="ps-scroll">'
            f'  <table class="prior-table cons-table">'
            f'  <thead><tr>'
            f'    <th>Country</th><th>EPO Pub</th><th>EPO App</th>'
            f'    <th>Google Pub</th><th>Google App</th><th>Note</th>'
            f'  </tr></thead>'
            f'  <tbody>{rows}</tbody>'
            f'  </table></div>'
            f'</section>'
        )
    else:
        # EPO ran successfully, no discrepancies
        check_html = (
            f'<section class="info-section consistency-section">'
            f'  <h2 class="section-h">&#10003; Consistency Check</h2>'
            f'  <p class="cons-note cons-ok">No discrepancies found between EPO INPADOC '
            f'and Google Patents family data for overlapping jurisdictions.</p>'
            f'</section>'
        )

    return epo_section + check_html


# ── Maintenance fee calculations ─────────────────────────────────────────────

# USPTO small entity maintenance fees (months-from-grant, label, amount)
_MAINT_MILESTONES = [
    (42,  "3.5-year",  800),
    (90,  "7.5-year",  1_800),
    (138, "11.5-year", 3_700),
]


def _add_months(d: _date, months: int) -> _date:
    m = d.month - 1 + months
    year  = d.year + m // 12
    month = m % 12 + 1
    day   = min(d.day, calendar.monthrange(year, month)[1])
    return _date(year, month, day)


def calc_maintenance_fees(grant_date_str: str) -> list[dict]:
    """Return USPTO small-entity maintenance fee milestones for a grant date."""
    try:
        gd = _date.fromisoformat(grant_date_str)
    except (ValueError, TypeError):
        return []
    today = _date.today()
    rows = []
    for months, label, amount in _MAINT_MILESTONES:
        due        = _add_months(gd, months)
        grace_end  = _add_months(due, 6)
        days_until = (due - today).days
        if today > grace_end:
            status = "paid"          # past grace window; assume paid if patent active
        elif today > due:
            status = "grace"         # past due, still in 6-month grace period
        elif days_until <= 180:
            status = "due_soon"      # within 6 months
        else:
            status = "upcoming"
        rows.append({
            "label":     label,
            "due":       due.isoformat(),
            "grace_end": grace_end.isoformat(),
            "amount":    amount,
            "status":    status,
        })
    return rows


# ── Annuity schedules ────────────────────────────────────────────────────────

_ANNUITY_SCHEDULES: dict[str, dict] = {
    "EP": {
        "currency": "EUR", "symbol": "€", "rate": 1.08,
        "fees": {
            3: 520, 4: 620, 5: 760, 6: 980, 7: 1_100, 8: 1_250,
            9: 1_450, 10: 1_610, 11: 1_840, 12: 2_060, 13: 2_280,
            14: 2_420, 15: 2_560, 16: 2_660, 17: 2_760, 18: 2_870,
            19: 2_960, 20: 3_060,
        },
        "note": (
            "EPO official renewal fees. "
            "After grant, national validation fees also apply per country."
        ),
    },
    "JP": {
        "currency": "JPY", "symbol": "¥", "rate": 0.0067,
        "fees": (
            {yr: 6_600  for yr in range(1,  4)} |
            {yr: 16_500 for yr in range(4,  7)} |
            {yr: 33_000 for yr in range(7, 10)} |
            {yr: 66_000 for yr in range(10, 21)}
        ),
        "note": "Japan Patent Office annual fees (approximate official fees only).",
    },
    "CN": {
        "currency": "CNY", "symbol": "¥", "rate": 0.14,
        "fees": (
            {yr: 900   for yr in range(1,  4)} |
            {yr: 1_200 for yr in range(4,  7)} |
            {yr: 2_000 for yr in range(7, 10)} |
            {yr: 4_000 for yr in range(10, 16)} |
            {yr: 6_000 for yr in range(16, 21)}
        ),
        "note": "CNIPA official annual fees (approximate official fees only).",
    },
}


def calc_annuities(filing_date_str: str, cc: str) -> Optional[dict]:
    """
    Return remaining annuity data for EP/JP/CN, or a WO expiry stub.
    Returns None for US or unknown jurisdictions.
    """
    if cc == "WO":
        try:
            fd = _date.fromisoformat(filing_date_str)
            return {"wo": True, "expiry": _add_months(fd, 240).isoformat()}
        except (ValueError, TypeError):
            return None

    sched = _ANNUITY_SCHEDULES.get(cc)
    if not sched or not filing_date_str:
        return None
    try:
        fd = _date.fromisoformat(filing_date_str)
    except (ValueError, TypeError):
        return None

    today  = _date.today()
    expiry = _add_months(fd, 240)

    if today >= expiry:
        return {
            "cc": cc, "expired": True, "expiry": expiry.isoformat(),
            "currency": sched["currency"], "symbol": sched["symbol"],
        }

    current_year = max(1, int((today - fd).days / 365.25) + 1)
    rows: list[dict] = []
    total_local = total_usd = 0
    for yr in range(current_year, 21):
        fee_local = sched["fees"].get(yr, 0)
        if not fee_local:
            continue
        fee_usd     = round(fee_local * sched["rate"])
        total_local += fee_local
        total_usd   += fee_usd
        rows.append({
            "year": yr, "fee_local": fee_local,
            "fee_usd": fee_usd, "is_current": yr == current_year,
        })

    return {
        "cc": cc, "expired": False, "wo": False,
        "expiry": expiry.isoformat(),
        "currency": sched["currency"], "symbol": sched["symbol"],
        "rate": sched["rate"], "rows": rows,
        "total_local": total_local, "total_usd": total_usd,
        "note": sched["note"],
    }


# ── Professional fee estimates ───────────────────────────────────────────────
# Approximate professional/agent fees (USD) — used in portfolio fee schedule.
# These are estimates only; actual fees vary by firm and jurisdiction.
_PRO_FEES: dict[str, dict] = {
    "EP": {"annuity_agent": 300,  "oa_response": 3_500,
           "note": "EP annuity agent ~$300/yr; OA response ~$3,500"},
    "JP": {"annuity_agent": 350,  "oa_response": 3_000,
           "note": "JP annuity agent ~$350/yr; OA response ~$3,000"},
    "CN": {"annuity_agent": 200,  "oa_response": 2_000,
           "note": "CN annuity agent ~$200/yr; OA response ~$2,000"},
}


# ── IDS disclosure check ──────────────────────────────────────────────────────

_IDS_CODES = frozenset({"IDS", "IDSMAIN", "IDS.IDS", "ISS.IDS"})


def _has_ids_event(events: list[dict]) -> tuple[bool, list[dict]]:
    """Return (found, matching_events) for IDS events in prosecution history."""
    matches = []
    for e in events:
        code  = (e.get("code")  or "").upper().replace("-", "").replace(" ", "")
        title = (e.get("title") or "").upper()
        value = (e.get("value") or "").upper()
        if (any(c in code for c in _IDS_CODES) or
                "INFORMATION DISCLOSURE" in title or
                "INFORMATION DISCLOSURE" in value):
            matches.append(e)
    return bool(matches), matches


def check_ids_disclosure(
    family_details: list[dict], granted_refs: list[dict]
) -> list[dict]:
    """
    For each co-pending / unknown US application in the family, check whether
    an IDS was filed based on prosecution history events.

    Returns a list of result dicts — one per qualifying application.
    """
    results: list[dict] = []
    ref_count = len(granted_refs)

    for m in family_details:
        cc     = country_code(m["pub_num"])
        status = m.get("status", "unknown")
        if cc != "US" or status not in ("pending", "unknown"):
            continue

        has_ids, ids_events = _has_ids_event(m.get("events", []))
        latest_ids = ids_events[-1] if ids_events else None

        if has_ids:
            note = (
                f"IDS filed ({latest_ids['date']}) — "
                f"verify that all {ref_count} cited reference{'s' if ref_count != 1 else ''} "
                f"are disclosed"
            ) if latest_ids else "IDS event found — verify reference disclosure"
            flag = False
        else:
            note = (
                f"No IDS event found in page source — review recommended. "
                f"({ref_count} reference{'s' if ref_count != 1 else ''} cited in granted patent)"
            )
            flag = True

        results.append({
            "pub_num":    m["pub_num"],
            "app_num":    m.get("app_num", ""),
            "href":       m.get("href", ""),
            "has_ids":    has_ids,
            "ids_events": ids_events,
            "flag":       flag,
            "note":       note,
        })

    return results


def _render_ids_check(ids_results: list[dict]) -> str:
    if not ids_results:
        return ""

    rows = ""
    for r in ids_results:
        icon  = "&#9888;" if r["flag"] else "&#10003;"
        color = "#991b1b" if r["flag"] else "#065f46"
        bg    = "#fee2e2" if r["flag"] else "#d1fae5"
        label = "Review recommended" if r["flag"] else "IDS found"
        pub_link = (
            f'<a href="{r["href"]}" target="_blank">{r["pub_num"]}</a>'
            if r["href"] else r["pub_num"]
        )
        app_display = r["app_num"] or "—"
        rows += (
            f'<tr>'
            f'<td>{pub_link}</td>'
            f'<td>{app_display}</td>'
            f'<td style="background:{bg};color:{color};font-weight:600;white-space:nowrap">'
            f'  {icon} {label}'
            f'</td>'
            f'<td class="ids-note">{r["note"]}</td>'
            f'</tr>'
        )

    return (
        f'<section class="info-section ids-section">'
        f'  <h2 class="section-h">Prior Art IDS Disclosure Check'
        f'    <span class="cnt-badge">{len(ids_results)} co-pending</span>'
        f'  </h2>'
        f'  <p class="ids-disclaimer">'
        f'    &#9432;&nbsp; Automated check based on prosecution history events in page source. '
        f'    Absence of an IDS event does not confirm non-disclosure. '
        f'    <strong>Results must be verified by qualified patent counsel.</strong>'
        f'  </p>'
        f'  <div class="ps-scroll">'
        f'  <table class="prior-table ids-table">'
        f'  <thead><tr>'
        f'    <th>Application</th><th>App No</th><th>IDS Status</th><th>Note</th>'
        f'  </tr></thead>'
        f'  <tbody>{rows}</tbody>'
        f'  </table></div>'
        f'</section>'
    )


# ── Portfolio fee schedule ────────────────────────────────────────────────────

def calc_portfolio_schedule(family_details: list) -> list[dict]:
    """Build a year-by-year fee schedule across the entire patent portfolio."""
    by_year: dict[int, dict] = {}

    def _ensure(yr: int) -> dict:
        if yr not in by_year:
            by_year[yr] = {
                "events": [], "EUR": 0, "JPY": 0, "CNY": 0,
                "USD_maint": 0, "total_usd": 0,
            }
        return by_year[yr]

    for m in family_details:
        cc  = country_code(m["pub_num"])
        idn = (m.get("app_num") or "").strip() or m["pub_num"]

        if cc == "US" and m.get("status") == "granted" and m.get("grant_date"):
            for fee in calc_maintenance_fees(m["grant_date"]):
                if fee["status"] == "paid":
                    continue
                yr  = int(fee["due"][:4])
                row = _ensure(yr)
                row["events"].append({
                    "id": idn, "pub": m["pub_num"], "cc": "US",
                    "cur": "USD", "sym": "$",
                    "local": fee["amount"], "usd": fee["amount"],
                    "label": fee["label"] + " maint.",
                })
                row["USD_maint"] += fee["amount"]
                row["total_usd"] += fee["amount"]

        elif cc in _ANNUITY_SCHEDULES:
            filing = m.get("filing_date") or m.get("date") or ""
            ann    = calc_annuities(filing, cc)
            if not ann or ann.get("wo") or ann.get("expired"):
                continue
            sched = _ANNUITY_SCHEDULES[cc]
            try:
                fd = _date.fromisoformat(filing)
            except (ValueError, TypeError):
                continue
            for r in ann.get("rows", []):
                yr  = _add_months(fd, r["year"] * 12).year
                row = _ensure(yr)
                row["events"].append({
                    "id": idn, "pub": m["pub_num"], "cc": cc,
                    "cur": sched["currency"], "sym": sched["symbol"],
                    "local": r["fee_local"], "usd": r["fee_usd"],
                    "label": f"Yr {r['year']}",
                })
                row[sched["currency"]] += r["fee_local"]
                row["total_usd"]       += r["fee_usd"]

    return [{"year": yr, **by_year[yr]} for yr in sorted(by_year)]


def _render_portfolio_summary(schedule: list) -> str:
    if not schedule:
        return ""

    grand_usd   = sum(r["total_usd"]  for r in schedule)
    grand_eur   = sum(r["EUR"]        for r in schedule)
    grand_jpy   = sum(r["JPY"]        for r in schedule)
    grand_cny   = sum(r["CNY"]        for r in schedule)
    grand_maint = sum(r["USD_maint"]  for r in schedule)

    # Estimate professional fees per year based on jurisdictions active that year
    def _pro_fee_for_year(row: dict) -> int:
        ccs = {ev["cc"] for ev in row["events"]}
        total = 0
        for cc, pf in _PRO_FEES.items():
            if cc in ccs:
                total += pf["annuity_agent"]
        return total

    grand_pro = sum(_pro_fee_for_year(r) for r in schedule)

    def _fmt(sym: str, val: int) -> str:
        return f"{sym}{val:,}" if val else "—"

    rows_html = ""
    for row in schedule:
        apps: dict[str, list[str]] = {}
        for ev in row["events"]:
            apps.setdefault(ev["id"], []).append(f"{ev['label']} ({ev['cc']})")
        apps_html = " &nbsp;·&nbsp; ".join(
            f'<span class="ps-app" title="{", ".join(labels)}">{pid}</span>'
            for pid, labels in apps.items()
        )
        pro_est = _pro_fee_for_year(row)
        total_with_pro = row["total_usd"] + pro_est
        # data- attributes for live FX JS update
        rows_html += (
            f'<tr>'
            f'<td class="ps-year">{row["year"]}</td>'
            f'<td class="ps-apps">{apps_html}</td>'
            f'<td class="ps-cur" data-eur="{row["EUR"]}">{_fmt("€", row["EUR"])}</td>'
            f'<td class="ps-cur" data-jpy="{row["JPY"]}">{_fmt("¥", row["JPY"])}</td>'
            f'<td class="ps-cur" data-cny="{row["CNY"]}">{_fmt("¥", row["CNY"])}</td>'
            f'<td class="ps-cur">{_fmt("$", row["USD_maint"])}</td>'
            f'<td class="ps-cur ps-official">~${row["total_usd"]:,}</td>'
            f'<td class="ps-cur ps-pro">~${pro_est:,}</td>'
            f'<td class="ps-total">~${total_with_pro:,}</td>'
            f'</tr>'
        )
    rows_html += (
        f'<tr class="ps-grand-row">'
        f'<td colspan="2"><strong>Grand Total</strong></td>'
        f'<td class="ps-cur" data-eur="{grand_eur}">{_fmt("€", grand_eur)}</td>'
        f'<td class="ps-cur" data-jpy="{grand_jpy}">{_fmt("¥", grand_jpy)}</td>'
        f'<td class="ps-cur" data-cny="{grand_cny}">{_fmt("¥", grand_cny)}</td>'
        f'<td class="ps-cur">{_fmt("$", grand_maint)}</td>'
        f'<td class="ps-cur ps-official"><strong>~${grand_usd:,}</strong></td>'
        f'<td class="ps-cur ps-pro"><strong>~${grand_pro:,}</strong></td>'
        f'<td class="ps-total"><strong>~${grand_usd + grand_pro:,}</strong></td>'
        f'</tr>'
    )

    pro_notes = " &nbsp;|&nbsp; ".join(pf["note"] for pf in _PRO_FEES.values())

    return (
        f'<details class="info-section ps-section" id="fee-schedule-tab">'
        f'  <summary class="section-h ps-summary">'
        f'    &#128197; Portfolio Fee Schedule'
        f'    <span class="cnt-badge">click to expand</span>'
        f'    <span id="fx-rate-badge" class="fx-badge" style="display:none"></span>'
        f'  </summary>'
        f'  <p class="ps-disclaimer">'
        f'    &#9888;&nbsp; Official fees shown at static rates'
        f'    (EUR&times;1.08 &nbsp;|&nbsp; JPY&times;0.0067 &nbsp;|&nbsp; CNY&times;0.14). '
        f'    Live exchange rates update USD columns when available.'
        f'  </p>'
        f'  <p class="ps-pro-note">'
        f'    &#9432;&nbsp; Est. professional fees: {pro_notes}. '
        f'    <em>All figures are estimates — verify with counsel.</em>'
        f'  </p>'
        f'  <div class="ps-scroll">'
        f'  <table class="ps-table" id="fee-table">'
        f'  <thead><tr>'
        f'    <th>Year</th><th>Applications</th>'
        f'    <th>EUR (EPO)</th><th>JPY (JP)</th><th>CNY (CN)</th>'
        f'    <th>USD (US&nbsp;maint.)</th>'
        f'    <th>Official ~USD</th>'
        f'    <th>Est. Prof. Fees</th>'
        f'    <th>Total ~USD</th>'
        f'  </tr></thead>'
        f'  <tbody>{rows_html}</tbody>'
        f'  </table></div>'
        f'</details>'
    )


# ── Dashboard HTML rendering ──────────────────────────────────────────────────

def _status_badge(status: str) -> str:
    s = STATUS_META.get(status, STATUS_META["unknown"])
    return (
        f'<span class="status-badge" '
        f'style="background:{s["bg"]};color:{s["fg"]};'
        f'border:1.5px solid {s["border"]}">'
        f'{s["label"]}</span>'
    )


def _pending_app_deadline(m: dict) -> tuple[str, str]:
    """
    For pending applications, compute the upcoming response deadline from
    prosecution events. Returns (human-readable label, ISO due-date string).
    E.g. ("Response to Non-Final Office Action due April 15, 2026", "2026-04-15")
    """
    from datetime import date as _dt
    events = m.get("events", [])
    if not events:
        return "", ""
    last_ev   = events[-1]
    ev_title  = (last_ev.get("title") or last_ev.get("value") or "").upper()
    date_str  = last_ev.get("date", "")

    _OA_DEADLINES: dict[str, tuple[str, int]] = {
        "NON FINAL ACTION MAILED":        ("Response to Non-Final Office Action", 3),
        "NON-FINAL ACTION MAILED":        ("Response to Non-Final Office Action", 3),
        "FINAL ACTION MAILED":            ("Response to Final Office Action", 2),
        "FINAL REJECTION MAILED":         ("Response to Final Rejection", 2),
        "RESTRICTION REQUIREMENT MAILED": ("Response to Restriction Requirement", 2),
        "NOTICE OF ALLOWANCE MAILED":     ("Issue fee payment", 3),
        "NOTICE OF ALLOWANCE":            ("Issue fee payment", 3),
    }
    for key, (label, months) in _OA_DEADLINES.items():
        if key in ev_title:
            if date_str:
                try:
                    oa_date   = _dt.fromisoformat(date_str)
                    due_month = oa_date.month + months
                    due_year  = oa_date.year + (due_month - 1) // 12
                    due_month = ((due_month - 1) % 12) + 1
                    due_date  = oa_date.replace(year=due_year, month=due_month)
                    due_str   = due_date.strftime("%B %-d, %Y")
                    return f"{label} due {due_str}", due_date.isoformat()
                except (ValueError, TypeError, OverflowError):
                    pass
            return label, ""
    # Fall back to human-readable last event label
    label = _classify_oa_event(last_ev.get("value", ""), last_ev.get("title", ""))
    return (label or ""), ""


def _pending_app_status(m: dict) -> str:
    """Backward-compat wrapper — returns just the display string."""
    return _pending_app_deadline(m)[0]


def _get_next_deadline(m: dict) -> dict | None:
    """
    Return the single most important upcoming deadline for any family member tile.
    Works for pending US/foreign apps (OA response), granted US (maintenance fee),
    and foreign grants (annuity). Returns {"label", "date", "type"} or None.
    """
    from datetime import date as _dt
    code   = country_code(m["pub_num"])
    status = m.get("status", "unknown")

    # Pending: office action / prosecution response deadline
    if status in ("pending", "unknown"):
        label, iso = _pending_app_deadline(m)
        if label:
            return {"label": label, "date": iso, "type": "response"}
        return None

    # Granted US: next unpaid maintenance fee
    if code == "US" and status == "granted":
        grant = m.get("grant_date", "")
        if grant:
            fees = calc_maintenance_fees(grant)
            for f in fees:
                if f["status"] not in ("paid",):
                    return {
                        "label": f"Maintenance fee – {f['label']} due {f['due']}",
                        "date":  f["due"],
                        "type":  "maintenance",
                    }
        return None

    # Foreign granted/pending: next annuity
    filing_raw = m.get("filing_date") or m.get("date") or ""
    if code in _ANNUITY_SCHEDULES and filing_raw and code != "WO":
        ann = calc_annuities(filing_raw, code)
        if ann and not ann.get("expired") and not ann.get("wo"):
            for r in ann.get("rows", []):
                if r.get("is_current"):
                    try:
                        fd     = _dt.fromisoformat(filing_raw)
                        due_dt = _add_months(fd, r["year"] * 12)
                        lbl    = f"Year {r['year']} annuity due {due_dt.strftime('%B %-d, %Y')}"
                        return {"label": lbl, "date": due_dt.isoformat(), "type": "annuity"}
                    except Exception:
                        pass
    return None


def _render_card(m: dict) -> str:
    code   = country_code(m["pub_num"])
    status = m.get("status", "unknown")
    border = STATUS_META.get(status, STATUS_META["unknown"])["border"]
    href    = m.get("href", "")
    app_num = m.get("app_num", "").strip()
    # Granted patents → show patent publication number; pending/other → show application number
    display = m["pub_num"] if status == "granted" else (app_num if app_num else m["pub_num"])
    # Normalize PCT application number format: "PCT/US2020/066580" not "PC:T/..." variants
    if code == "WO" and display and not display.upper().startswith("WO"):
        display = re.sub(r'\bPC\s*[:\s]*T\s*[:/\s]+', 'PCT/', display, flags=re.IGNORECASE)
    # Viewer pills: Espacenet (always) + ODP (US only).  GP removed — blocked on many networks.
    _esp_url = f"https://worldwide.espacenet.com/patent/search?q=pn%3D{m['pub_num'].replace(' ','')}"
    _vl = [f'<a href="{_esp_url}" class="vl vl-esn" target="_blank" title="Espacenet">ESN</a>']
    if code == "US":
        _c_app = re.sub(r"[^\d]", "", app_num) if app_num else ""
        _odp_url = (
            f"https://data.uspto.gov/patent-file-wrapper/details/{_c_app}/documents"
            if _c_app else "https://data.uspto.gov/patent-file-wrapper"
        )
        _vl.append(f'<a href="{_odp_url}" class="vl vl-usp" target="_blank" title="USPTO Open Data Portal">ODP</a>')
    pnum = f'{display}<span class="vl-row">{"".join(_vl)}</span>'
    title = (m.get("member_title") or m.get("title") or "").strip()
    filing = m.get("filing_date") or m.get("date") or "—"
    grant  = m.get("grant_date", "")
    flag  = COUNTRY_FLAGS.get(code, "")
    cname = COUNTRY_NAMES.get(code, code)

    # Dates row — label second date as "Granted" only when actually granted
    date_items = f'<span>Filed: <b>{filing}</b></span>'
    if grant:
        second_label = "Granted" if status == "granted" else "Published"
        date_items += f'<span>{second_label}: <b>{grant}</b></span>'

    # Next deadline banner — visible for all tile types (OA response, maintenance, annuity)
    next_deadline_html = ""
    next_dl = _get_next_deadline(m)
    if next_dl:
        dl_label = next_dl["label"]
        dl_date  = next_dl["date"]
        dl_type  = next_dl["type"]
        # Urgency-aware color
        bg, fg, bdr = "#eff6ff", "#1e40af", "#bfdbfe"   # default: blue
        if dl_date:
            try:
                from datetime import date as _dt2
                days_left = (_dt2.fromisoformat(dl_date) - _dt2.today()).days
                if days_left < 0:
                    bg, fg, bdr = "#fef2f2", "#991b1b", "#fecaca"   # overdue: red
                elif days_left <= 30:
                    bg, fg, bdr = "#fff1f2", "#c62828", "#fca5a5"   # urgent: red
                elif days_left <= 90:
                    bg, fg, bdr = "#fff7ed", "#c2410c", "#fed7aa"   # soon: orange
            except Exception:
                pass
        icon = "&#128203;" if dl_type == "response" else "&#128197;"
        next_deadline_html = (
            f'<div class="next-deadline" style="'
            f'background:{bg};color:{fg};border:1px solid {bdr}">'
            f'{icon} <strong>Next deadline:</strong> {dl_label}'
            f'</div>'
        )

    # Maintenance fees (granted patents only)
    maint_html = ""
    if status == "granted" and grant:
        fees = calc_maintenance_fees(grant)
        if fees:
            _status_styles = {
                "paid":     ("✓ Paid",        "#6b7280", "#f3f4f6"),
                "grace":    ("⚠ Grace Period", "#92400e", "#fef3c7"),
                "due_soon": ("⚠ Due Soon",     "#92400e", "#fef3c7"),
                "upcoming": ("Upcoming",        "#1e40af", "#dbeafe"),
            }
            fee_rows = ""
            for f in fees:
                lbl, fg, bg = _status_styles.get(f["status"], ("—", "#6b7280", "#f9fafb"))
                fee_rows += (
                    f'<tr>'
                    f'<td>{f["label"]}</td>'
                    f'<td>{f["due"]}</td>'
                    f'<td>${f["amount"]:,}</td>'
                    f'<td><span class="mf-status" style="color:{fg};background:{bg}">{lbl}</span></td>'
                    f'</tr>'
                )
            unpaid_total = sum(
                f["amount"] for f in fees if f["status"] != "paid"
            )
            total_tag = (
                f' &nbsp;·&nbsp; ~${unpaid_total:,} remaining'
                if unpaid_total > 0 else " &nbsp;·&nbsp; all paid"
            )
            maint_html = (
                f'<details class="history maint-fees">'
                f'<summary>Maintenance fees'
                f'  <span class="ev-count">Small Entity{total_tag}</span>'
                f'</summary>'
                f'<table class="hist-table">'
                f'<thead><tr><th>Window</th><th>Due</th><th>Fee</th><th>Status</th></tr></thead>'
                f'<tbody>{fee_rows}</tbody>'
                f'</table>'
                f'</details>'
            )

    # Expiry date + annuity schedule (non-US foreign patents)
    annuity_html = ""
    filing_raw = m.get("filing_date") or m.get("date") or ""
    if code == "WO" and filing_raw:
        ann = calc_annuities(filing_raw, "WO")
        if ann:
            annuity_html = (
                f'<div class="ann-expiry">Expires (est.): <b>{ann["expiry"]}</b></div>'
                f'<div class="wo-note">PCT/WO: No annuities at WO stage &mdash; '
                f'fees are paid during national phase entry per country.</div>'
            )
    elif code in _ANNUITY_SCHEDULES and filing_raw:
        ann = calc_annuities(filing_raw, code)
        if ann and ann.get("expired"):
            annuity_html = f'<div class="ann-expiry">Expired: <b>{ann["expiry"]}</b></div>'
        elif ann and not ann.get("expired"):
            sym = ann["symbol"]
            cur = ann["currency"]
            fee_rows = ""
            for r in ann["rows"]:
                cls = ' class="ann-cur-row"' if r["is_current"] else ""
                fee_rows += (
                    f'<tr{cls}>'
                    f'<td>Yr {r["year"]}</td>'
                    f'<td>{sym}{r["fee_local"]:,}</td>'
                    f'<td>(~${r["fee_usd"]:,})</td>'
                    f'</tr>'
                )
            annuity_html = (
                f'<div class="ann-expiry">Expires (est.): <b>{ann["expiry"]}</b></div>'
                f'<details class="history">'
                f'<summary>Annual renewal fees '
                f'<span class="ev-count">{cur} &nbsp;·&nbsp; ~${ann["total_usd"]:,} remaining</span>'
                f'</summary>'
                f'<table class="hist-table">'
                f'<thead><tr><th>Year</th><th>Fee</th><th>USD equiv.</th></tr></thead>'
                f'<tbody>{fee_rows}</tbody>'
                f'<tfoot><tr><td colspan="2"><strong>Remaining total</strong></td>'
                f'<td><strong>~${ann["total_usd"]:,}</strong></td></tr></tfoot>'
                f'</table>'
                f'<p class="ann-note">&#9888; {ann["note"]} Does not include professional fees.</p>'
                f'</details>'
            )

    # Latest prosecution event
    events = m.get("events", [])
    latest_html = ""
    if events:
        ev = events[-1]
        ev_title = ev.get("title") or ev.get("code") or ""
        latest_html = (
            f'<div class="latest-event">'
            f'<span class="ev-chip">Latest</span>'
            f'<span class="ev-date">{ev.get("date","")}</span>'
            f'<span class="ev-title">{ev_title}</span>'
            f'</div>'
        )

    # Rejection reasons (pills) + full rejection summary — only for pending/unknown apps.
    # Issued patents already overcame all rejections; showing them is misleading.
    rejections = m.get("rejections", [])
    rej_html = ""
    rej_summary_html = ""
    if status in ("pending", "unknown"):
        if rejections:
            pills = "".join(f'<span class="rej-pill">{r}</span>' for r in rejections)
            rej_html = f'<div class="rejections"><div class="rej-label">Rejections</div>{pills}</div>'
        rej_summary = extract_rejection_summary(m)
        if rej_summary:
            rej_summary_html = _render_rejection_summary(rej_summary)

    # Fetch error notice
    err_html = ""
    if m.get("fetch_error"):
        err_html = (
            f'<div class="fetch-error">'
            f'Could not fetch details: {m["fetch_error"]}'
            f'</div>'
        )

    # Build rejection grounds lookup for annotating rejection events in history
    grounds_lookup: dict[str, str] = {}
    for r in m.get("rejections", []):
        sm    = re.search(r'(\d+)\(([a-z])\)', r, re.IGNORECASE)
        sec_m = re.search(r'(\d+)', r)
        sec   = sec_m.group(1) if sec_m else ""
        sub   = sm.group(2).lower() if sm else ""
        key   = f"{sec}{sub}" if sub else sec
        info  = _REJECTION_GROUNDS.get(key) or _REJECTION_GROUNDS.get(sec)
        if info and key not in grounds_lookup:
            grounds_lookup[key] = info["title"]

    def _ev_desc(e: dict) -> str:
        raw_title = e.get("title", "")
        label     = _classify_oa_event(e.get("value", ""), raw_title)
        desc      = label or raw_title
        if grounds_lookup and label and (
            "rejection" in label.lower() or "action" in label.lower()
        ):
            grounds_str = "; ".join(grounds_lookup.values())
            desc = f'{desc} <span class="ev-grounds">({grounds_str})</span>'
        return desc

    # Collapsible prosecution history
    if events:
        rows = "".join(
            f'<tr>'
            f'<td class="ev-date-col">{e.get("date","")}</td>'
            f'<td>{_ev_desc(e)}</td>'
            f'</tr>'
            for e in events
        )
        history_html = (
            f'<details class="history">'
            f'<summary>Prosecution history <span class="ev-count">{len(events)} events</span></summary>'
            f'<table class="hist-table">'
            f'<thead><tr><th>Date</th><th>Event</th></tr></thead>'
            f'<tbody>{rows}</tbody>'
            f'</table>'
            f'</details>'
        )
    else:
        history_html = (
            '<details class="history">'
            '<summary>Prosecution history</summary>'
            '<p class="no-hist">No events found in page source. '
            'Check USPTO PAIR / EPO Register / J-PlatPat for full history.</p>'
            '</details>'
        )

    translated = (m.get("translated_title") or "").strip()
    translated_html = (
        f'  <div class="card-translated">&#127760; {translated}</div>'
        if translated and translated.lower() != title.lower() else ""
    )

    # Notes textarea — value filled by parent via direct DOM access after iframe load
    pub_num_key = m["pub_num"]   # stable key used by Portfolio.jsx for notes storage
    notes_html = (
        f'<div class="card-notes">'
        f'  <div class="notes-label">&#128221; Notes</div>'
        f'  <textarea class="notes-ta" data-pub-num="{pub_num_key}"'
        f'   rows="2" placeholder="Add notes for this application…"></textarea>'
        f'</div>'
    )

    # Per-tile Files button — sends postMessage to the parent Portfolio.jsx so it can
    # open the DocumentsPanel scoped to this specific tile (pub_num).
    _pub_esc = pub_num_key.replace("'", "\\'")
    tile_files_html = (
        f'<button class="tile-files-btn" '
        f"onclick=\"window.parent.postMessage({{type:'open-tile-files',pubNum:'{_pub_esc}'}},'*')\">"
        f'&#128206; Files</button>'
    )

    return (
        f'<div class="card" style="border-top:4px solid {border}">'
        f'  <div class="card-head">'
        f'    <span class="card-pnum">{pnum}</span>'
        f'    <div style="display:flex;align-items:center;gap:5px;flex-shrink:0">'
        f'      <span class="card-country-chip">{flag} {cname}</span>'
        f'      {_status_badge(status)}'
        f'    </div>'
        f'  </div>'
        + (f'  <div class="card-title">{title}</div>' if title else '')
        + translated_html
        + f'  <div class="card-dates">{date_items}</div>'
        + next_deadline_html
        + maint_html + annuity_html + latest_html + rej_html + rej_summary_html + err_html + history_html
        + notes_html
        + tile_files_html
        + '</div>'
    )


def generate_dashboard_html(
    main_metas: dict, family_details: list, url: str, patent_input: str,
    claims: list | None = None,
    epo_only: list | None = None,
    discrepancies: list | None = None,
    translated_title: str | None = None,
    translated_abstract: str | None = None,
) -> str:
    number   = _first(main_metas.get("citation_patent_number", [])) or "N/A"
    title    = (_first(main_metas.get("DC.title", [])) or "").strip()
    abstract = (_first(main_metas.get("DC.description", [])) or "").strip()
    relations = main_metas.get("DC.relation", [])
    dates       = main_metas.get("DC.date", [])
    filing_date = dates[0] if dates else "N/A"
    grant_date  = dates[1] if len(dates) > 1 else "N/A"

    contributors = main_metas.get("DC.contributor", [])
    assignees = [
        c.strip() for c in contributors
        if len(c.strip().split()) >= 3
        or any(kw in c for kw in ("LLC", "Inc", "Corp", "Ltd", "Company", "Institute", "University"))
    ]

    # Group by country (for jurisdictions count in stats bar)
    by_country: dict[str, list] = {}
    for m in family_details:
        by_country.setdefault(country_code(m["pub_num"]), []).append(m)

    # ── Split EPO-only members into European (stay in EPO section) vs non-European
    #    (promoted to first-class tiles in the main status-grouped sections).
    if epo_only:
        epo_european     = [em for em in epo_only if em["country"] in _EUROPEAN_COUNTRY_CODES]
        epo_non_european = [em for em in epo_only if em["country"] not in _EUROPEAN_COUNTRY_CODES]
        # Promote non-European EPO members — convert to family_details format
        existing_countries = {country_code(m["pub_num"]) for m in family_details}
        for em in epo_non_european:
            if em["country"] not in existing_countries:
                family_details = list(family_details) + [_epo_to_family_member(em)]
                existing_countries.add(em["country"])
        # Only pass European members to the EPO section renderer
        epo_only = epo_european if epo_european else None

    # Portfolio fee schedule (rendered at bottom)
    portfolio_html = _render_portfolio_summary(calc_portfolio_schedule(family_details))

    # Summary counts
    granted = sum(1 for m in family_details if m["status"] == "granted")
    pending = sum(1 for m in family_details if m["status"] == "pending")
    other   = len(family_details) - granted - pending

    # Status-grouped sections: Issued → Pending (oldest filing first) → Abandoned
    granted_members   = sorted(
        [m for m in family_details if m.get("status") == "granted"],
        key=lambda m: m.get("grant_date") or m.get("filing_date") or m.get("date") or "",
    )
    pending_members   = sorted(
        [m for m in family_details if m.get("status") in ("pending", "unknown")],
        key=lambda m: (
            0 if country_code(m["pub_num"]) == "US" else 1,   # US apps first
            m.get("filing_date") or m.get("date") or "",       # then oldest filing
        ),
    )
    abandoned_members = sorted(
        [m for m in family_details if m.get("status") in ("abandoned", "expired", "rejected")],
        key=lambda m: m.get("filing_date") or m.get("date") or "",
    )
    country_html = ""
    for group_label, members, icon in [
        ("Issued Patents",       granted_members,   "✅"),
        ("Pending Applications", pending_members,   "🔄"),
        ("Abandoned / Lapsed",   abandoned_members, "❌"),
    ]:
        if not members:
            continue
        cards = "".join(_render_card(m) for m in members)
        country_html += (
            f'<section class="country-section">'
            f'  <h2 class="country-h">{icon} {group_label}'
            f'    <span class="country-count">{len(members)}</span>'
            f'  </h2>'
            f'  <div class="cards-grid">{cards}</div>'
            f'</section>'
        )

    # IDS disclosure check
    granted_us = next(
        (m for m in family_details
         if country_code(m["pub_num"]) == "US" and m.get("status") == "granted"),
        None,
    )
    granted_refs = granted_us.get("backward_refs", []) if granted_us else []
    ids_results  = check_ids_disclosure(family_details, granted_refs)
    ids_html     = _render_ids_check(ids_results)

    # Granted US Claims — collapsible tab
    indep_claims = [c for c in (claims or []) if c["independent"]]
    if indep_claims:
        def _render_claim(c: dict) -> str:
            return (
                f'<div class="claim-block">'
                f'<span class="claim-num">Claim {c["num"]}</span>'
                f'<p class="claim-body">{c["text"]}</p>'
                f'</div>'
            )
        all_claims_html = "".join(_render_claim(c) for c in indep_claims)
        claims_html = (
            f'<details class="info-section claims-tab">'
            f'  <summary class="section-h">'
            f'    &#128196; Granted US Claims'
            f'    <span class="cnt-badge">{len(indep_claims)} independent — click to expand</span>'
            f'  </summary>'
            + all_claims_html
            + '</details>'
        )
    else:
        claims_html = ""

    prior_rows = "".join(
        '<tr><td><a href="https://patents.google.com/patent/{}/en" target="_blank">{}</a></td></tr>'.format(
            r.replace(":", ""), r
        )
        for r in relations
    )
    prior_html = (
        f'<section class="info-section">'
        f'  <h2 class="section-h">Cited Prior Art <span class="cnt-badge">{len(relations)}</span></h2>'
        f'  <table class="prior-table"><tbody>{prior_rows}</tbody></table>'
        f'</section>'
    ) if relations else ""

    assignee_str = "; ".join(assignees) if assignees else "N/A"

    # Alternative patent viewer URLs for the hero section (GP removed — often blocked).
    _hero_norm = number.replace(" ", "").replace(",", "")
    _hero_esp  = f"https://worldwide.espacenet.com/patent/search?q=pn%3D{_hero_norm}"
    # ODP link: find the US family member's application number for the file-wrapper URL
    _hero_us_m   = next((m for m in family_details if country_code(m["pub_num"]) == "US"), None)
    _hero_us_app = re.sub(r"[^\d]", "", _hero_us_m.get("app_num", "")) if _hero_us_m else ""
    _hero_odp    = (
        f"https://data.uspto.gov/patent-file-wrapper/details/{_hero_us_app}/documents"
        if _hero_us_app else ""
    )

    epo_section_html = _render_epo_section(epo_only, discrepancies)

    # Abstract section — pre-computed to avoid nested f-string quoting issues
    if abstract:
        tr_abstract_html = ""
        if translated_abstract:
            tr_abstract_html = (
                '<div class="abstract-translated">'
                '<span class="translated-label">&#127760; Machine translation (DeepL)</span>'
                f'{translated_abstract}'
                '</div>'
            )
        abstract_section_html = (
            '<details class="info-section abstract-details" open>'
            '<summary class="section-h abstract-summary">&#128196; Abstract</summary>'
            f'<div class="abstract">{abstract}</div>'
            f'{tr_abstract_html}'
            '</details>'
        )
    else:
        abstract_section_html = ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Patent Dashboard — {number}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #eef0f4; color: #111827; line-height: 1.55; padding: 1.5rem;
    }}
    a {{ color: #2563eb; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}

    /* ── Hero header ── */
    .hero {{
      background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 60%, #1d4ed8 100%);
      color: #fff; border-radius: 14px; padding: 2rem 2.5rem; margin-bottom: 1.25rem;
    }}
    .hero-eyebrow {{
      font-size: .75rem; font-weight: 600; letter-spacing: .1em;
      text-transform: uppercase; opacity: .6; margin-bottom: .4rem;
    }}
    .hero-title {{ font-size: 1.45rem; font-weight: 700; line-height: 1.3; }}
    .hero-sub {{
      margin-top: .9rem; display: flex; gap: 1rem; flex-wrap: wrap; font-size: .85rem;
    }}
    .hero-chip {{
      background: rgba(255,255,255,.12); border-radius: 6px;
      padding: .2rem .75rem; white-space: nowrap;
    }}

    /* ── Stats bar ── */
    .stats-bar {{
      display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.25rem;
    }}
    .stat-card {{
      background: #fff; border-radius: 10px; padding: .85rem 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,.07); flex: 1; min-width: 130px;
    }}
    .stat-label {{ font-size: .7rem; font-weight: 600; text-transform: uppercase;
                   letter-spacing: .08em; color: #6b7280; }}
    .stat-value {{ font-size: 1.6rem; font-weight: 700; color: #111827; margin-top: .15rem; }}

    /* ── Info sections (abstract / prior art) ── */
    .info-section {{
      background: #fff; border-radius: 12px; padding: 1.25rem 1.75rem;
      margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.06);
    }}
    .section-h {{
      font-size: .8rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .09em; color: #1e40af; margin-bottom: .85rem;
      display: flex; align-items: center; gap: .5rem;
    }}
    .cnt-badge {{
      background: #dbeafe; color: #1e40af; border-radius: 20px;
      padding: .05rem .55rem; font-size: .75rem; font-weight: 700;
    }}
    .abstract {{
      background: #f8fafc; border-left: 3px solid #2563eb;
      border-radius: 0 8px 8px 0; padding: .9rem 1.1rem;
      font-size: .92rem; color: #374151; line-height: 1.7;
    }}
    .abstract-translated {{
      margin-top: .75rem; padding: .75rem 1.1rem;
      background: #f0fdf4; border-left: 3px solid #22c55e;
      border-radius: 0 8px 8px 0; font-size: .9rem; color: #374151; line-height: 1.7;
    }}
    .translated-label {{
      display: block; font-size: .72rem; font-weight: 700; color: #16a34a;
      text-transform: uppercase; letter-spacing: .04em; margin-bottom: .35rem;
    }}
    .card-translated {{
      font-size: .78rem; color: #16a34a; font-style: italic;
      margin: .15rem .75rem .35rem; line-height: 1.4;
    }}
    .hero-translated {{
      font-size: .95rem; color: #86efac; font-style: italic;
      margin-top: .35rem; margin-bottom: .1rem;
    }}
    .prior-table {{ width: 100%; border-collapse: collapse; font-size: .88rem; }}
    .prior-table td {{ padding: .35rem .5rem; border-bottom: 1px solid #f0f0f0; }}
    .prior-table tr:last-child td {{ border-bottom: none; }}

    /* ── Country sections ── */
    .country-section {{ margin-bottom: 2rem; }}
    .country-h {{
      font-size: 1rem; font-weight: 700; color: #0f172a;
      margin-bottom: .75rem; display: flex; align-items: center; gap: .5rem;
    }}
    .country-count {{
      background: #e0e7ff; color: #3730a3; border-radius: 20px;
      padding: .05rem .55rem; font-size: .75rem; font-weight: 700;
    }}

    /* ── Cards grid ── */
    .cards-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
    }}
    .card {{
      background: #fff; border-radius: 10px;
      box-shadow: 0 1px 4px rgba(0,0,0,.07);
      padding: 1.1rem 1.25rem; display: flex; flex-direction: column; gap: .6rem;
    }}
    .card-head {{
      display: flex; justify-content: space-between; align-items: flex-start;
    }}
    .card-pnum {{ font-size: 1rem; font-weight: 700; }}
    .vl-row {{ display:inline-flex; gap:3px; margin-left:6px; flex-wrap:wrap; vertical-align:middle; }}
    .vl {{ font-size:.58rem; font-weight:700; padding:1px 5px; border-radius:3px;
           text-decoration:none; border:1px solid; line-height:1.6; }}
    .vl-esn {{ background:#e8f5e9; color:#2e7d32; border-color:#c8e6c9; }}
    .vl-usp {{ background:#fff3e0; color:#e65100; border-color:#ffe0b2; }}
    .tile-files-btn {{
      margin-top:.6rem; padding:5px 12px; border-radius:6px; cursor:pointer;
      background:#f0f4f8; border:1px solid #d0d7de; font-size:.75rem;
      color:#1a1a2e; font-weight:600; display:inline-flex; align-items:center; gap:4px;
    }}
    .tile-files-btn:hover {{ background:#e2e8f0; }}
    .status-badge {{
      font-size: .7rem; font-weight: 700; border-radius: 20px;
      padding: .2rem .65rem; white-space: nowrap; flex-shrink: 0;
    }}
    .card-title {{ font-size: .85rem; color: #374151; line-height: 1.4; }}
    .card-dates {{
      display: flex; gap: 1rem; flex-wrap: wrap;
      font-size: .8rem; color: #6b7280;
    }}
    .card-dates b {{ color: #111827; }}

    /* ── Latest event ── */
    .latest-event {{
      display: flex; align-items: baseline; gap: .4rem;
      font-size: .8rem; flex-wrap: wrap;
    }}
    .ev-chip {{
      background: #f0f9ff; color: #0369a1; border: 1px solid #bae6fd;
      border-radius: 4px; padding: .05rem .4rem; font-size: .68rem; font-weight: 700;
      white-space: nowrap;
    }}
    .ev-date {{ color: #6b7280; white-space: nowrap; }}
    .ev-title {{ color: #111827; }}

    /* ── Rejections ── */
    .rejections {{ font-size: .8rem; }}
    .rej-label {{
      font-size: .68rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .07em; color: #991b1b; margin-bottom: .3rem;
    }}
    .rej-pill {{
      display: inline-block; background: #fee2e2; color: #991b1b;
      border-radius: 4px; padding: .15rem .5rem;
      margin: .15rem .2rem .15rem 0; font-size: .75rem;
    }}

    /* ── Prosecution history ── */
    .history {{
      margin-top: .2rem; border-top: 1px solid #f3f4f6; padding-top: .6rem;
    }}
    .history summary {{
      cursor: pointer; font-size: .8rem; font-weight: 600; color: #4b5563;
      user-select: none; list-style: none; display: flex; align-items: center; gap: .4rem;
    }}
    .history summary::-webkit-details-marker {{ display: none; }}
    .history summary::before {{
      content: "▶"; font-size: .6rem; transition: transform .15s;
      display: inline-block;
    }}
    details[open] > summary::before {{ transform: rotate(90deg); }}
    .ev-count {{
      background: #f3f4f6; color: #6b7280; border-radius: 20px;
      padding: .05rem .45rem; font-size: .7rem; font-weight: 600;
    }}
    .hist-table {{
      width: 100%; border-collapse: collapse; font-size: .78rem;
      margin-top: .6rem;
    }}
    .hist-table th {{
      background: #f8f9fa; text-align: left; padding: .35rem .5rem;
      font-size: .7rem; text-transform: uppercase; letter-spacing: .05em;
      color: #6b7280; border-bottom: 1px solid #e5e7eb;
    }}
    .hist-table td {{ padding: .35rem .5rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }}
    .hist-table tr:last-child td {{ border-bottom: none; }}
    .hist-table tr:hover td {{ background: #fafbff; }}
    .hist-table code {{
      background: #f1f5f9; border-radius: 3px; padding: .05rem .3rem;
      font-size: .75rem; color: #0f172a;
    }}
    .no-hist {{ font-size: .8rem; color: #9ca3af; padding: .5rem 0; }}
    .mf-status {{
      font-size: .7rem; font-weight: 700; border-radius: 4px;
      padding: .15rem .45rem; white-space: nowrap;
    }}
    .ann-expiry {{ font-size: .82rem; color: #374151; }}
    .ann-expiry b {{ color: #111827; }}
    .wo-note {{ font-size: .74rem; color: #6b7280; font-style: italic; margin-top: .1rem; }}
    .ann-cur-row td {{ background: #fefce8 !important; font-weight: 600; }}
    .hist-table tfoot td {{
      border-top: 2px solid #e5e7eb; font-weight: 600;
      background: #f8f9fa; padding: .35rem .5rem;
    }}
    .ann-note {{ font-size: .72rem; color: #9ca3af; padding: .4rem 0 0; font-style: italic; }}
    .ps-section {{ }}
    .ps-disclaimer {{
      font-size: .78rem; color: #92400e; background: #fef3c7;
      border-radius: 6px; padding: .5rem .75rem; margin-bottom: .85rem;
    }}
    .ps-scroll {{ overflow-x: auto; }}
    .ps-table {{
      width: 100%; border-collapse: collapse; font-size: .82rem; min-width: 680px;
    }}
    .ps-table th {{
      background: #f8f9fa; text-align: left; padding: .4rem .6rem;
      font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
      color: #6b7280; border-bottom: 2px solid #e5e7eb; white-space: nowrap;
    }}
    .ps-table td {{ padding: .4rem .6rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }}
    .ps-table tr:hover td {{ background: #fafbff; }}
    .ps-year {{ font-weight: 700; white-space: nowrap; color: #0f172a; }}
    .ps-apps {{ font-size: .8rem; line-height: 1.8; }}
    .ps-app {{
      display: inline-block; background: #e0e7ff; color: #3730a3;
      border-radius: 4px; padding: .1rem .4rem; margin: .1rem .15rem .1rem 0;
      font-size: .73rem; white-space: nowrap; cursor: default;
    }}
    .ps-cur {{ text-align: right; white-space: nowrap; color: #374151; font-size: .8rem; }}
    .ps-total {{ text-align: right; white-space: nowrap; font-weight: 600; color: #0f172a; }}
    .ps-grand-row td {{
      background: #f8f9fa; border-top: 2px solid #e5e7eb; font-size: .85rem;
    }}
    .rej-summary {{
      border: 1.5px solid #fca5a5; border-radius: 8px;
      padding: .75rem 1rem; background: #fff5f5; margin-top: .2rem;
    }}
    .rej-summary-label {{
      font-size: .7rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: #991b1b; margin-bottom: .5rem;
    }}
    .rej-table {{ width: 100%; border-collapse: collapse; font-size: .78rem; margin-bottom: .5rem; }}
    .rej-table th {{
      background: #fee2e2; text-align: left; padding: .3rem .45rem;
      font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
      color: #991b1b; border-bottom: 1px solid #fca5a5;
    }}
    .rej-table td {{ padding: .3rem .45rem; border-bottom: 1px solid #fef2f2; vertical-align: top; }}
    .rej-table tr:last-child td {{ border-bottom: none; }}
    .rej-date {{ white-space: nowrap; color: #6b7280; }}
    .rej-code {{
      background: #fee2e2; color: #991b1b; border-radius: 3px;
      padding: .05rem .3rem; font-size: .7rem; font-family: monospace;
    }}
    .rej-none {{ font-size: .78rem; color: #9ca3af; font-style: italic; }}
    .rej-grounds-section {{ margin: .5rem 0; }}
    .rej-sub-label {{
      font-size: .68rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .06em; color: #374151; margin-bottom: .35rem;
    }}
    .rej-ground {{ margin-bottom: .45rem; padding-bottom: .45rem; border-bottom: 1px solid #fef2f2; }}
    .rej-ground:last-child {{ border-bottom: none; margin-bottom: 0; }}
    .rej-ground-title {{ font-size: .78rem; font-weight: 700; color: #7f1d1d; }}
    .rej-ground-summary {{ font-size: .75rem; color: #374151; line-height: 1.5; margin-top: .1rem; }}
    .rej-grounds-note {{
      font-size: .75rem; color: #6b7280; font-style: italic; margin: .4rem 0;
    }}
    .rej-refs-details {{ margin-top: .4rem; }}
    .ref-title {{ max-width: 180px; font-size: .75rem; color: #374151; }}
    .examiner-badge {{
      background: #fef3c7; color: #92400e; border-radius: 3px;
      padding: .05rem .3rem; font-size: .65rem; font-weight: 700; margin-left: .2rem;
    }}
    .fetch-error {{ font-size: .75rem; color: #b45309; background: #fef3c7;
                    border-radius: 4px; padding: .3rem .6rem; }}

    /* ── Country chip on each card ── */
    .card-country-chip {{
      font-size: .68rem; font-weight: 700; background: #f1f5f9;
      color: #475569; border-radius: 4px; padding: .1rem .4rem;
      white-space: nowrap;
    }}

    /* ── Next deadline banner (all tile types) ── */
    .next-deadline {{
      font-size: .78rem; font-weight: 600;
      border-radius: 6px; padding: .3rem .65rem; margin: .4rem 0 .1rem;
    }}
    /* keep legacy rule in case old cached HTML is rendered */
    .pending-status {{
      font-size: .78rem; font-weight: 600; color: #1e40af;
      background: #eff6ff; border: 1px solid #bfdbfe;
      border-radius: 6px; padding: .3rem .65rem;
    }}

    /* ── Per-tile notes textarea ── */
    .card-notes {{
      margin-top: .7rem; border-top: 1px solid #e8edf2; padding-top: .55rem;
    }}
    .notes-label {{
      font-size: .7rem; font-weight: 700; color: #9ca3af;
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: .3rem;
    }}
    .notes-ta {{
      width: 100%; min-height: 54px; border: 1px solid #d1d5db; border-radius: 6px;
      padding: .4rem .55rem; font-size: .82rem; font-family: inherit;
      resize: vertical; color: #374151; background: #fafafa; box-sizing: border-box;
    }}
    .notes-ta:focus {{ outline: none; border-color: #1a73e8; background: #fff; }}

    /* ── Rejection grounds annotation in history table ── */
    .ev-grounds {{
      font-size: .72rem; color: #6b7280; font-style: italic;
    }}
    .ev-date-col {{ white-space: nowrap; color: #6b7280; }}

    /* ── Abstract collapsible ── */
    .abstract-details {{ cursor: default; }}
    .abstract-summary {{
      cursor: pointer; list-style: none; user-select: none;
      display: flex; align-items: center; gap: .5rem;
    }}
    .abstract-summary::-webkit-details-marker {{ display: none; }}
    .abstract-summary::after {{
      content: "▲"; font-size: .6rem; margin-left: auto; color: #9ca3af;
      transition: transform .15s;
    }}
    details.abstract-details:not([open]) .abstract-summary::after {{
      content: "▼";
    }}

    /* ── Mobile responsive ── */
    @media (max-width: 640px) {{
      body {{ padding: .75rem; }}
      .hero {{ padding: 1.1rem 1.25rem; border-radius: 10px; }}
      .hero-title {{ font-size: 1.15rem; }}
      .hero-sub {{ gap: .5rem; }}
      .stats-bar {{
        display: grid; grid-template-columns: 1fr 1fr; gap: .5rem;
      }}
      .stat-card {{ padding: .65rem .9rem; min-width: 0; }}
      .stat-value {{ font-size: 1.25rem; }}
      .cards-grid {{
        grid-template-columns: 1fr;
      }}
      .card {{ padding: .9rem 1rem; }}
      .info-section {{ padding: 1rem 1.1rem; }}
      .card-head {{ flex-wrap: wrap; gap: .35rem; }}
      .card-dates {{ flex-direction: column; gap: .25rem; }}
      .hist-table, .ps-table, .cons-table, .ids-table, .rej-table {{
        font-size: .74rem;
      }}
      .ps-summary {{ padding: 1rem 1.1rem; }}
      .ps-section > .ps-disclaimer,
      .ps-section > .ps-pro-note,
      .ps-section > .ps-scroll {{ padding-left: 1.1rem; padding-right: 1.1rem; }}
      .ps-section > .ps-scroll {{ padding-bottom: 1rem; }}
      .ps-pro-note {{ margin-left: 1.1rem; margin-right: 1.1rem; }}
      .claims-tab > summary {{ padding: .9rem 1.1rem; }}
      .claims-tab .claim-block {{ margin: .75rem 1.1rem; }}
      footer {{ margin-top: 1.5rem; }}
    }}

    @media print {{
      .no-print {{ display: none !important; }}
      .print-hide {{ display: none !important; }}
      body {{ background: #fff; padding: .5rem; }}
      .card {{ break-inside: avoid; }}
      .history {{ display: block; }}
      details {{ display: block; }}
      details > summary {{ display: none; }}
    }}

    .claim-block {{ margin-bottom: .9rem; padding-bottom: .9rem; border-bottom: 1px solid #f3f4f6; }}
    .claim-block:last-child {{ border-bottom: none; margin-bottom: 0; }}
    .claim-num {{
      display: inline-block; background: #e0e7ff; color: #3730a3;
      border-radius: 4px; padding: .1rem .5rem; font-size: .72rem;
      font-weight: 700; margin-bottom: .35rem;
    }}
    .claim-body {{ font-size: .88rem; color: #374151; line-height: 1.65; }}
    .claims-more summary {{
      cursor: pointer; font-size: .82rem; font-weight: 600; color: #2563eb;
      user-select: none; list-style: none; padding: .4rem 0;
    }}
    .claims-more summary::-webkit-details-marker {{ display: none; }}
    .claims-more[open] summary {{ margin-bottom: .6rem; }}
    footer {{ text-align: center; font-size: .75rem; color: #9ca3af; margin-top: 2rem; }}

    /* ── EPO OPS section ── */
    .epo-only-section {{
      border: 1.5px dashed #93c5fd; border-radius: 12px;
      padding: 1rem 1.25rem; background: #f0f9ff; margin-bottom: 2rem;
    }}
    .epo-section-h {{ color: #1e40af; }}
    .epo-source-label {{
      font-size: .65rem; background: #dbeafe; color: #1e40af;
      border-radius: 4px; padding: .1rem .4rem; margin-left: .5rem; font-weight: 700;
    }}
    .epo-note {{ font-size: .8rem; color: #4b5563; margin-bottom: .75rem; font-style: italic; }}
    .epo-source-badge {{
      background: #dbeafe; color: #1e40af; border-radius: 4px;
      padding: .1rem .4rem; font-size: .68rem; font-weight: 700;
    }}
    .epo-meta {{ flex-wrap: wrap; gap: .5rem; }}
    .epo-card {{ border: 1px solid #bae6fd; }}

    /* ── Consistency check ── */
    .consistency-section {{ }}
    .cons-note {{ font-size: .82rem; color: #4b5563; margin-bottom: .6rem; }}
    .cons-ok {{ color: #065f46; font-weight: 500; }}
    .cons-table {{ width: 100%; border-collapse: collapse; font-size: .82rem; min-width: 600px; }}
    .cons-table th {{
      background: #f8f9fa; text-align: left; padding: .35rem .5rem;
      font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
      color: #6b7280; border-bottom: 1px solid #e5e7eb;
    }}
    .cons-table td {{ padding: .35rem .5rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }}
    .cons-table tr:last-child td {{ border-bottom: none; }}
    .disc-note {{ font-size: .78rem; color: #92400e; font-style: italic; }}



    /* ── Fee schedule collapsible ── */
    .ps-section {{ padding: 0; overflow: hidden; }}
    .ps-summary {{
      cursor: pointer; padding: 1.25rem 1.75rem; list-style: none;
      user-select: none; display: flex; align-items: center; gap: .5rem;
    }}
    .ps-summary::-webkit-details-marker {{ display: none; }}
    details[open] > .ps-summary {{ border-bottom: 1px solid #f3f4f6; }}
    .ps-section > .ps-disclaimer,
    .ps-section > .ps-pro-note,
    .ps-section > .ps-scroll {{ padding-left: 1.75rem; padding-right: 1.75rem; }}
    .ps-section > .ps-disclaimer {{ padding-top: .75rem; }}
    .ps-section > .ps-scroll {{ padding-bottom: 1.25rem; }}
    .ps-pro-note {{
      font-size: .78rem; color: #1e40af; background: #eff6ff;
      border-radius: 6px; padding: .45rem .75rem; margin: .5rem 1.75rem;
    }}
    .ps-official {{ color: #374151; }}
    .ps-pro {{ color: #1e40af; }}
    .fx-badge {{
      background: #d1fae5; color: #065f46; border-radius: 4px;
      padding: .1rem .5rem; font-size: .68rem; font-weight: 700; margin-left: auto;
    }}

    /* ── Claims collapsible tab ── */
    .claims-tab {{ padding: 0; overflow: hidden; }}
    .claims-tab > summary {{
      cursor: pointer; padding: 1.1rem 1.75rem; list-style: none; user-select: none;
      display: flex; align-items: center; gap: .5rem;
    }}
    .claims-tab > summary::-webkit-details-marker {{ display: none; }}
    details[open].claims-tab > summary {{ border-bottom: 1px solid #f3f4f6; }}
    .claims-tab .claim-block {{ margin: .9rem 1.75rem; padding-bottom: .9rem;
      border-bottom: 1px solid #f3f4f6; }}
    .claims-tab .claim-block:last-child {{ border-bottom: none; }}

    /* ── IDS check ── */
    .ids-section {{ }}
    .ids-disclaimer {{
      font-size: .78rem; background: #fef3c7; color: #92400e;
      border-radius: 6px; padding: .5rem .75rem; margin-bottom: .75rem;
    }}
    .ids-table {{ width: 100%; border-collapse: collapse; font-size: .82rem; min-width: 520px; }}
    .ids-table th {{
      background: #f8f9fa; text-align: left; padding: .35rem .5rem;
      font-size: .72rem; text-transform: uppercase; letter-spacing: .05em;
      color: #6b7280; border-bottom: 1px solid #e5e7eb;
    }}
    .ids-table td {{ padding: .4rem .5rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }}
    .ids-table tr:last-child td {{ border-bottom: none; }}
    .ids-note {{ font-size: .78rem; color: #4b5563; font-style: italic; }}
  </style>
</head>
<body>

  <div class="hero">
    <div class="hero-eyebrow">Patent Family Dashboard</div>
    <div class="hero-title">{title or number}</div>
    {f'<div class="hero-translated">&#127760; {translated_title}</div>' if translated_title and translated_title.lower() != (title or "").lower() else ""}
    <div class="hero-sub">
      <span class="hero-chip">&#128196; {number}</span>
      <span class="hero-chip">&#128197; Filed {filing_date}</span>
      <span class="hero-chip">&#9989; Granted {grant_date}</span>
      {'<span class="hero-chip">&#127970; ' + assignee_str + '</span>' if assignees else ''}
      <span class="hero-chip"><a href="{_hero_esp}" target="_blank" style="color:#93c5fd">Espacenet &#8599;</a></span>
      {f'<span class="hero-chip"><a href="{_hero_odp}" target="_blank" style="color:#93c5fd">USPTO ODP &#8599;</a></span>' if _hero_odp else ''}
    </div>
  </div>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="stat-label">Family Size</div>
      <div class="stat-value">{len(family_details)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Jurisdictions</div>
      <div class="stat-value">{len(by_country)}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #34d399">
      <div class="stat-label">Granted</div>
      <div class="stat-value" style="color:#065f46">{granted}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #60a5fa">
      <div class="stat-label">Pending</div>
      <div class="stat-value" style="color:#1e40af">{pending}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #d1d5db">
      <div class="stat-label">Other</div>
      <div class="stat-value" style="color:#374151">{other}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Prior Art Citations</div>
      <div class="stat-value">{len(relations)}</div>
    </div>
  </div>

  {abstract_section_html}

  {claims_html}

  {country_html}

  {epo_section_html}

  {ids_html}

  {prior_html}

  <div id="portfolio-fees-section">{portfolio_html}</div>

  <footer>Generated by PatentQ &mdash; {patent_input}</footer>

<script>
// ── Notes: accept prefill from parent and report changes back ──────────────
(function() {{
  // Parent calls iframeEl.contentDocument directly to fill textareas (same-origin),
  // but also support postMessage for environments where that's cleaner.
  window.addEventListener('message', function(e) {{
    if (!e.data || e.data.type !== 'prefillNotes') return;
    var notes = e.data.notes || {{}};
    Object.keys(notes).forEach(function(pubNum) {{
      var ta = document.querySelector('.notes-ta[data-pub-num="' + pubNum + '"]');
      if (ta && !ta.value) ta.value = notes[pubNum] || '';
    }});
  }});
  document.addEventListener('input', function(e) {{
    if (e.target && e.target.classList.contains('notes-ta')) {{
      try {{
        window.parent.postMessage({{
          type: 'noteChanged',
          pubNum: e.target.dataset.pubNum,
          text: e.target.value
        }}, '*');
      }} catch(ex) {{}}
    }}
  }}, true);
}})();

// ── Live FX rates ──────────────────────────────────────────────────────────
(function() {{
  fetch('https://api.exchangerate-api.com/v4/latest/USD')
    .then(r => r.json())
    .then(data => {{
      const rates = data.rates || {{}};
      const EUR = rates['EUR'] || 0, JPY = rates['JPY'] || 0, CNY = rates['CNY'] || 0;
      if (!EUR || !JPY || !CNY) return;
      document.querySelectorAll('[data-eur]').forEach(td => {{
        const v = parseFloat(td.dataset.eur);
        if (v) td.textContent = '\u20ac' + v.toLocaleString() + ' (~$' + Math.round(v/EUR).toLocaleString() + ')';
      }});
      document.querySelectorAll('[data-jpy]').forEach(td => {{
        const v = parseFloat(td.dataset.jpy);
        if (v) td.textContent = '\u00a5' + v.toLocaleString() + ' (~$' + Math.round(v/JPY).toLocaleString() + ')';
      }});
      document.querySelectorAll('[data-cny]').forEach(td => {{
        const v = parseFloat(td.dataset.cny);
        if (v) td.textContent = '\u00a5' + v.toLocaleString() + ' (~$' + Math.round(v/CNY).toLocaleString() + ')';
      }});
      const badge = document.getElementById('fx-rate-badge');
      if (badge) {{
        const d = new Date().toLocaleDateString();
        badge.textContent = 'Live FX ' + d + ' \u00b7 \u20ac1=$' + (1/EUR).toFixed(2) + ' \u00b7 \u00a51=$' + (1/JPY).toFixed(4) + '(JPY) \u00b7 \u00a51=$' + (1/CNY).toFixed(3) + '(CNY)';
        badge.style.display = '';
      }}
    }}).catch(() => {{}});
}})();

</script>
</body>
</html>"""


def save_dashboard(html: str, number: str) -> str:
    safe = re.sub(r"[^A-Z0-9]", "", number.upper()) or "patent"
    out_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(out_dir, f"patent_dashboard_{safe}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python tracker.py <patent_number>")
        print("  e.g. python tracker.py 'US 12,178,560'")
        sys.exit(1)

    patent_input = " ".join(sys.argv[1:])
    url = build_url(patent_input)

    print(f"\nLooking up: {patent_input}")
    print(f"URL: {url}")
    print("Fetching … ", end="", flush=True)

    try:
        html = fetch_page(url)
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            # Try B1 kind code
            alt_url = url.replace("B2/en", "B1/en")
            print(f"not found (B2). Trying B1 …", end="", flush=True)
            try:
                html = fetch_page(alt_url)
                url = alt_url
            except requests.HTTPError:
                print("not found.")
                print(f"\n  Patent '{patent_input}' not found on Google Patents.")
                sys.exit(1)
        else:
            raise

    print("done.")

    metas  = get_metas(html)
    family = parse_family(html)
    claims = parse_claims(html)

    if not metas.get("citation_patent_number"):
        print(f"\n  No patent data found for '{patent_input}'.")
        print(f"  Check manually: {url}")
        sys.exit(1)

    display(metas, family, url)

    html_simple = generate_html(metas, family, url, patent_input)
    simple_path = save_and_open_html(html_simple, metas.get("citation_patent_number", [patent_input])[0])
    print(f"  Summary HTML : {simple_path}")

    # ── Prosecution dashboard ──
    number = metas.get("citation_patent_number", [patent_input])[0]
    total  = len(family)
    print(f"\nFetching prosecution data for {total} family members …")
    family_details = [
        fetch_member_details(m, i + 1, total)
        for i, m in enumerate(family)
    ]

    # ── EPO OPS Integration ──
    _load_dotenv()
    epo_key    = os.environ.get("EPO_CONSUMER_KEY", "").strip()
    epo_secret = os.environ.get("EPO_CONSUMER_SECRET", "").strip()
    epo_only:      Optional[list] = None
    discrepancies: Optional[list] = None

    if epo_key and epo_secret:
        docdb = patent_to_docdb(patent_input)
        if docdb:
            print(f"\nEPO OPS: fetching INPADOC family for {docdb} … ", end="", flush=True)
            token = epo_get_token(epo_key, epo_secret)
            if token:
                xml = fetch_epo_family(docdb, token)
                if xml:
                    epo_members = parse_epo_family(xml)
                    print(f"{len(epo_members)} family members.")
                    epo_only, discrepancies = merge_epo_with_google(family_details, epo_members)
                    print(
                        f"  EPO-only jurisdictions : {len(epo_only)}"
                        + (f"\n  Consistency flags      : {len(discrepancies)}" if discrepancies else "")
                    )
                else:
                    print("no data returned.")
                    epo_only, discrepancies = [], []
            else:
                print("token request failed.")
                epo_only, discrepancies = [], []
        else:
            print("\nEPO OPS: could not parse patent number into docdb format — skipping.")
            epo_only, discrepancies = [], []
    else:
        print("\nEPO OPS credentials not set — skipping EPO integration.")

    dash_html = generate_dashboard_html(
        metas, family_details, url, patent_input, claims,
        epo_only=epo_only, discrepancies=discrepancies,
    )
    dash_path = save_dashboard(dash_html, number)
    print(f"\n  Dashboard HTML: {dash_path}")
    webbrowser.open(f"file://{dash_path}")


if __name__ == "__main__":
    main()
