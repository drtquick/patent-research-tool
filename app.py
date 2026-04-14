#!/usr/bin/env python3
"""
Patent Research Tool — Flask API

Firebase Auth-protected REST API wrapping tracker.py.

Endpoints:
  POST   /api/search                — run tracker for a patent number
  GET    /api/portfolios            — list user's saved portfolios
  POST   /api/portfolios            — save a patent to portfolio
  GET    /api/portfolios/<id>       — get single portfolio entry (incl. dashboard HTML)
  DELETE /api/portfolios/<id>       — remove a patent from portfolio
  GET    /api/alerts                — all upcoming deadlines across portfolio

Auth: every protected endpoint reads Authorization: Bearer <firebase-id-token>
"""

import os
import sys
import traceback
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import auth as fb_auth, credentials, firestore

# tracker.py lives next to this file
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tracker

# ── Bootstrap ─────────────────────────────────────────────────────────────────

tracker._load_dotenv()          # load .env before anything reads os.environ

app = Flask(__name__)
CORS(app)                       # allow React dev server (and Firebase Hosting)


def _init_firebase() -> None:
    if firebase_admin._apps:
        return
    # Cloud Run: pass entire JSON as env var FIREBASE_SERVICE_ACCOUNT_JSON
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if sa_json:
        import json as _json
        cred = credentials.Certificate(_json.loads(sa_json))
    else:
        # Local dev: path to the JSON file
        key_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY", "").strip()
        if key_path and os.path.exists(key_path):
            cred = credentials.Certificate(key_path)
        else:
            cred = credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred)


_init_firebase()
db = firestore.client()


# ── Auth decorator ────────────────────────────────────────────────────────────

def require_auth(f):
    """Verify Firebase ID token from Authorization: Bearer <token> header."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "Missing Authorization header"}), 401
        id_token = header[7:]
        try:
            decoded = fb_auth.verify_id_token(id_token)
            request.uid         = decoded["uid"]
            request.user_email  = decoded.get("email", "")
        except fb_auth.ExpiredIdTokenError:
            return jsonify({"error": "Token expired"}), 401
        except (fb_auth.InvalidIdTokenError, fb_auth.CertificateFetchError,
                ValueError) as exc:
            return jsonify({"error": f"Invalid token: {exc}"}), 401
        except Exception as exc:
            return jsonify({"error": f"Auth error: {exc}"}), 401
        return f(*args, **kwargs)
    return wrapper


# ── Core search logic ─────────────────────────────────────────────────────────

def _is_us_app_num(raw: str) -> bool:
    """Return True if raw looks like a bare US application number (8 digits, XX/XXX,XXX, etc.)."""
    import re as _re
    clean = _re.sub(r"[^\d]", "", raw)
    return bool(
        len(clean) == 8
        and (_re.fullmatch(r"\d{8}", raw.strip()) or "/" in raw)
    )


def _run_search_from_odp(app_num_raw: str) -> dict:
    """
    Build a complete search result directly from the USPTO Open Data Portal,
    bypassing Google Patents entirely.  Used for bare US application number
    inputs and as a fallback when the resolved pub number isn't on GP yet.
    """
    import requests as _rq
    import re as _re

    clean   = _re.sub(r"[^\d]", "", app_num_raw)
    api_key = os.environ.get("USPTO_ODP_API_KEY", "")

    resp = _rq.get(
        f"https://api.uspto.gov/api/v1/patent/applications/{clean}",
        headers={"X-API-Key": api_key},
        timeout=20,
    )
    resp.raise_for_status()
    bag  = resp.json()["patentFileWrapperDataBag"][0]
    meta = bag.get("applicationMetaData", {})

    # Canonical publication/patent number
    patent_num = meta.get("patentNumber")
    pg_pub     = meta.get("earliestPublicationNumber") or ""
    if patent_num:
        pub_num = f"US{patent_num}B2"
    elif pg_pub:
        pub_num = pg_pub
    else:
        pub_num = f"US{clean}"

    title   = (meta.get("inventionTitle") or "").strip()
    filing  = meta.get("filingDate") or ""
    grant   = meta.get("grantDate")  or ""
    investors_raw = meta.get("inventorBag",   [])
    applicants_raw= meta.get("applicantBag",  [])
    inventors = [i.get("inventorNameText", "").strip() for i in investors_raw if i.get("inventorNameText")]
    assignees = [a.get("applicantNameText", "").strip() for a in applicants_raw if a.get("applicantNameText")]

    # Build the single family member directly from the ODP data already fetched above.
    # Do NOT call fetch_us_member_via_odp here — that would make a redundant second
    # ODP request for the same application number and is likely to trigger a 429.
    events    = tracker._odp_events_to_standard(bag.get("eventDataBag", []))
    rej_codes = {"CTNF", "CTFR", "MCTNF", "MCTFR"}
    member = {
        "pub_num": pub_num,
        "app_num": clean,
        "href":    f"https://patents.google.com/patent/{pub_num}/en",
        "title":   title,
        "country": "US",
    }
    oa_documents = tracker.fetch_odp_documents(clean, api_key)

    family_details = [{
        **member,
        "status":        tracker._odp_status_to_standard(
                             meta.get("applicationStatusDescriptionText", "")),
        "events":        events,
        "rejections":    [e["title"] for e in events if e.get("code") in rej_codes],
        "backward_refs": [],
        "filing_date":   filing,
        "grant_date":    grant,
        "member_title":  title,
        "fetch_error":   None,
        "lang":          "",
        "oa_documents":  oa_documents,
    }]

    metas = {
        "DC.title":       [title],
        "DC.description": [],
        "DC.contributor": assignees + inventors,
        "DC.date":        [d for d in [filing, grant] if d],
        "citation_patent_number": [pub_num],
    }

    odp_url = f"https://data.uspto.gov/patent-file-wrapper/details/{clean}/documents"

    # ── Enrich with EPO INPADOC family (foreign counterparts) ────────────────
    # Previously this path returned only the single US family member, so the
    # dashboard never showed DE/JP/CN/WO counterparts when the user searched by
    # US application number.  Now we attempt to pull the INPADOC family via EPO
    # OPS using the resolved US pub number as the docdb key, then fetch details
    # for each non-US member via the normal Google Patents scrape path.
    epo_key    = os.environ.get("EPO_CONSUMER_KEY",    "").strip()
    epo_secret = os.environ.get("EPO_CONSUMER_SECRET", "").strip()
    epo_only:      list = []
    discrepancies: list = []

    if epo_key and epo_secret:
        docdb = tracker.patent_to_docdb(pub_num)
        if docdb:
            token = tracker.epo_get_token(epo_key, epo_secret)
            if token:
                family_xml = tracker.fetch_epo_family(docdb, token)
                if family_xml:
                    epo_members = tracker.parse_epo_family(family_xml)
                    if epo_members:
                        # Build a family list of non-US members; fetch details
                        # via GP/EPO for each so they render as normal tiles.
                        non_us = [em for em in epo_members if em.get("country") != "US"]
                        extra_family_raw = []
                        for em in non_us:
                            norm_pub = tracker.normalize(em["pub_num"])
                            extra_family_raw.append({
                                "pub_num": em["pub_num"],
                                "app_num": em.get("app_num", ""),
                                "href":    f"https://patents.google.com/patent/{norm_pub}/en",
                                "title":   "",
                                "country": em["country"],
                                "date":    em.get("pub_date", "") or em.get("app_date", ""),
                                "lang":    "",
                            })

                        total = len(extra_family_raw)
                        for i, m in enumerate(extra_family_raw):
                            try:
                                details = tracker.fetch_member_details(
                                    m, i + 1, total, odp_api_key=api_key
                                )
                                family_details.append(details)
                            except Exception as exc:
                                print(f"  family enrichment skipped {m.get('pub_num')}: {exc}")

                        # Discrepancy / epo-only merge (same as _run_search path)
                        try:
                            epo_only_raw, pub_discrepancies = tracker.merge_epo_with_google(
                                family_details, epo_members
                            )
                            epo_only      = epo_only_raw or []
                            discrepancies = list(pub_discrepancies or [])
                        except Exception as exc:
                            print(f"  family merge skipped: {exc}")

    # ── Continuity: pull in abandoned/unpublished US continuations via ODP ──
    # Mirrors the _run_search logic — see that function for rationale.
    if api_key:
        known = {tracker._clean_app_num(m.get("app_num", "")) for m in family_details}
        known.discard("")
        extras_seen: set = set()
        extras: list = []
        for m in list(family_details):
            for rel in (m.get("related_us_apps") or []):
                rel_app = rel.get("app_num", "")
                if not rel_app or rel_app in known or rel_app in extras_seen:
                    continue
                extras_seen.add(rel_app)
                extras.append({
                    "pub_num": rel.get("patent") and f"US{rel['patent']}B2" or f"US{rel_app}",
                    "app_num": rel_app,
                    "href":    "",
                    "title":   "",
                    "country": "US",
                    "date":    rel.get("filing", ""),
                    "lang":    "",
                })
        for j, stub in enumerate(extras):
            try:
                det = tracker.fetch_member_details(
                    stub, j + 1, len(extras), odp_api_key=api_key
                )
                family_details.append(det)
            except Exception as exc:
                print(f"  continuity merge (odp path) skipped {stub.get('app_num')}: {exc}")

    # ── Build summaries + dashboard from (possibly enriched) family ──────────
    dashboard_html = tracker.generate_dashboard_html(
        metas, family_details, odp_url, pub_num,
        epo_only=epo_only or None,
        discrepancies=discrepancies or None,
    )

    family_summary = []
    for m in family_details:
        dl_ = tracker._get_next_deadline(m)
        family_summary.append({
            "pub_num":             m.get("pub_num", ""),
            "country":             tracker.country_code(m.get("pub_num", "")),
            "status":              m.get("status", "unknown"),
            "filing_date":         m.get("filing_date") or m.get("date") or "",
            "grant_date":          m.get("grant_date", ""),
            "app_num":             m.get("app_num", ""),
            "title":               m.get("member_title", "") or m.get("title", ""),
            "href":                m.get("href", ""),
            "next_deadline_label": dl_["label"] if dl_ else "",
            "next_deadline_date":  dl_["date"]  if dl_ else "",
            "next_deadline_type":  dl_["type"]  if dl_ else "",
        })

    return {
        "patent_number":       pub_num,
        "title":               title,
        "translated_title":    "",
        "translated_abstract": "",
        "filing_date":         filing,
        "grant_date":          grant,
        "assignees":           assignees,
        "inventors":           inventors,
        "family_size":         len(family_details),
        "jurisdictions":       len({tracker.country_code(m.get("pub_num", "")) for m in family_details}),
        "granted_count":       sum(1 for m in family_details if m.get("status") == "granted"),
        "pending_count":       sum(1 for m in family_details if m.get("status") == "pending"),
        "family":              family_summary,
        "epo_only":            epo_only,
        "discrepancies":       discrepancies,
        "dashboard_html":      dashboard_html,
        "google_patents_url":  odp_url,
        "main_metas":          metas,
        "claims":              [],
    }


def _run_search(patent_input: str, search_type: str = "auto") -> dict:
    """
    Orchestrate a full search and return all results as a dict.

    search_type lets callers disambiguate inputs that could parse either as an
    application number or a granted patent number.  Values:
      "auto"               — heuristic routing (legacy behavior, below)
      "patent_number"      — treat input as a granted patent (e.g. US10123456 B2)
                             → EPO biblio → ODP (no ODP-as-app-num attempt)
      "application_number" — treat input as a US application serial
                             → ODP directly
      "publication_number" — treat input as a US publication (e.g. US20200123456A1)
                             → EPO biblio → ODP app resolution

    Data-source priority for "auto" (β 1.14):
      1. 8-digit bare number         → try ODP as application number first
                                       → if ODP 404, fall through to EPO as patent number
      2. 11-digit bare US pub serial → prepend 'US' + 'A1', EPO biblio → ODP
      3. Slash-format app number     → ODP directly (e.g. 18/383,898)
      4. Full pub/patent number      → EPO biblio (to resolve app number) → ODP
      5. Non-US                      → EPO OPS (biblio + family), ODP for US members
         GP only as absolute last resort when EPO fails entirely
    """
    import requests as _req
    import re as _re2

    _stripped = patent_input.strip()
    search_type = (search_type or "auto").strip().lower()

    # ── Explicit search_type: bypass heuristics entirely ─────────────────────
    # application_number: caller knows this is an application serial; go to ODP.
    if search_type == "application_number":
        return _run_search_from_odp(_stripped)

    # patent_number: caller knows this is a granted patent. Force the EPO
    # biblio path with an explicit country+kind prefix so we never mis-route to
    # ODP-as-app-num and return a different patent that happens to share digits.
    if search_type == "patent_number":
        norm = _re2.sub(r"[^\w]", "", _stripped).upper()
        if _re2.fullmatch(r"\d+", norm):
            patent_input = "US" + norm
        else:
            patent_input = _stripped
        # fall through to EPO path below (skip all auto-routing branches)

    # publication_number: explicit US publication. Prepend US+A1 when bare.
    elif search_type == "publication_number":
        norm = _re2.sub(r"[^\w]", "", _stripped).upper()
        if _re2.fullmatch(r"\d{11}", norm) or _re2.fullmatch(r"\d+", norm):
            patent_input = "US" + norm + "A1"
        else:
            patent_input = _stripped
        # fall through to EPO path below

    # ── Auto routing (legacy heuristics) ─────────────────────────────────────
    elif _re2.fullmatch(r"\d{8}", _stripped):
        # 8-digit bare number: ambiguous (could be app number OR patent number).
        # Try ODP as an application number first; if ODP returns 404 the digits
        # are a patent number (not an app number) — fall through to the EPO path
        # below treating the input as "US{num}" (a granted patent).
        try:
            return _run_search_from_odp(_stripped)
        except _req.HTTPError as _odp_exc:
            if _odp_exc.response.status_code != 404:
                raise
            print(f"  ODP 404 for '{_stripped}' — not an app number, routing as US patent via EPO")
            patent_input = "US" + _stripped   # re-route to EPO as a US patent number
        # fall through to EPO path below

    elif _re2.fullmatch(r"\d{11}", _stripped) and _stripped.startswith("2"):
        # 11-digit bare US publication serial (e.g. 20260059078)
        patent_input = "US" + _stripped + "A1"

    elif _is_us_app_num(patent_input):
        # Slash-format US application number (e.g. 18/383,898) → ODP directly
        return _run_search_from_odp(patent_input)

    # ── Credentials ───────────────────────────────────────────────────────────
    epo_key    = os.environ.get("EPO_CONSUMER_KEY",    "").strip()
    epo_secret = os.environ.get("EPO_CONSUMER_SECRET", "").strip()
    odp_key    = os.environ.get("USPTO_ODP_API_KEY",   "").strip()

    # ── Try EPO OPS as primary source ─────────────────────────────────────────
    epo_metas:   dict       = {}
    epo_family:  list       = []
    epo_members: list       = []
    epo_ran:     bool       = False
    docdb:       str | None = None

    if epo_key and epo_secret:
        docdb = tracker.patent_to_docdb(patent_input)
        if docdb:
            token = tracker.epo_get_token(epo_key, epo_secret)
            if token:
                # Biblio + abstract → metas dict
                biblio_xml   = tracker.fetch_epo_biblio(docdb, token)
                abstract_xml = tracker.fetch_epo_abstract(docdb, token)
                if biblio_xml:
                    epo_metas = tracker.parse_epo_biblio(biblio_xml, abstract_xml)
                    epo_ran   = True

                    # ── US pub number: resolve app number from EPO biblio → ODP ──
                    # EPO biblio's document-id-type="original" gives the clean
                    # 8-digit serial ODP uses (e.g. "18383898"), regardless of
                    # whether INPADOC family has any members yet.
                    if patent_input.upper().startswith("US") and odp_key:
                        us_app_num = tracker.extract_us_app_num_from_biblio(biblio_xml)
                        if us_app_num:
                            print(f"  US pub {patent_input} → app {us_app_num} via EPO biblio → ODP")
                            return _run_search_from_odp(us_app_num)

                # INPADOC family → member list (non-US patents, or US pub fallback)
                family_xml = tracker.fetch_epo_family(docdb, token)
                if family_xml:
                    epo_members = tracker.parse_epo_family(family_xml)
                    for em in epo_members:
                        norm_pub = tracker.normalize(em["pub_num"])
                        epo_family.append({
                            "pub_num": em["pub_num"],
                            "app_num": em.get("app_num", ""),
                            "href":    f"https://patents.google.com/patent/{norm_pub}/en",
                            "title":   "",
                            "country": em["country"],
                            "date":    (em.get("pub_date", "") or em.get("app_date", "")) if em["country"] != "US" else "",
                            "lang":    "",
                        })

    # ── Decide which family list and metas to use ─────────────────────────────
    claims: list = []
    gp_url = f"https://patents.google.com/patent/{tracker.normalize(patent_input)}/en"

    if epo_family:
        # EPO gave us a family — use it.  Try GP just for claims (non-fatal).
        metas  = epo_metas if epo_metas.get("citation_patent_number") else {}
        family = epo_family
        url    = gp_url
        try:
            gp_html = tracker.fetch_page(url)
            claims  = tracker.parse_claims(gp_html)
            # If EPO biblio was empty, fall back to GP metas
            if not metas:
                gp_metas = tracker.get_metas(gp_html)
                if gp_metas.get("citation_patent_number"):
                    metas = gp_metas
        except Exception:
            pass  # claims are nice-to-have; don't fail the whole search

    else:
        # EPO failed entirely — fall back to GP for everything
        url       = tracker.build_url(patent_input)
        html      = None
        last_exc  = None
        candidates = [url]
        if "B2/en" in url:
            candidates += [
                url.replace("B2/en", "B1/en"),
                url.replace("B2/en", "A1/en"),
                url.replace("B2/en", "A2/en"),
            ]
        elif "B1/en" in url:
            candidates += [url.replace("B1/en", "B2/en")]
        bare = f"https://patents.google.com/patent/{tracker.normalize(patent_input)}/en"
        if bare not in candidates:
            candidates.append(bare)

        for candidate in candidates:
            try:
                html = tracker.fetch_page(candidate)
                url  = candidate
                break
            except _req.HTTPError as exc:
                last_exc = exc
                if exc.response.status_code != 404:
                    raise
            except Exception:
                raise

        if html is None:
            raise ValueError(
                f"Patent '{patent_input}' was not found. "
                "EPO OPS and Google Patents both failed to return data for this patent."
            )

        metas  = tracker.get_metas(html)
        family = tracker.parse_family(html)
        claims = tracker.parse_claims(html)

    if not metas.get("citation_patent_number"):
        raise ValueError(f"No patent data found for '{patent_input}'")

    # ── Canonical patent number ───────────────────────────────────────────────
    raw_meta   = tracker._first(metas.get("citation_patent_number", [])) or ""
    norm_input = tracker.normalize(patent_input)
    if norm_input and not norm_input[0].isdigit():
        number = norm_input
    elif raw_meta:
        number = tracker.normalize(raw_meta)
    else:
        number = norm_input or patent_input

    dates = metas.get("DC.date", [])

    # ── Fetch family member prosecution details ───────────────────────────────
    # US members → ODP (resolves app_num via EPO biblio if needed); others → GP
    total          = len(family)
    family_details = [
        tracker.fetch_member_details(m, i + 1, total, odp_api_key=odp_key)
        for i, m in enumerate(family)
    ]

    # ── Pull in abandoned / unpublished US continuations via ODP continuity ──
    # INPADOC family data from EPO frequently misses abandoned continuations,
    # CIPs, and divisionals whose US publications never entered INPADOC.
    #
    # Two paths run here:
    #  (1) per-member walk — every US member we just fetched exposes its own
    #      parent/child continuity bag via result["related_us_apps"]. We add
    #      any referenced US apps we haven't already seen.
    #  (2) primary-app pull — if any US member is in the family, we also look
    #      up the FULL continuity chain seeded from that app's parent/child
    #      bags and again merge any new apps. Catches the common case where
    #      the per-member ODP calls all 404'd (recent unpublished apps).
    if odp_key:
        known = {tracker._clean_app_num(m.get("app_num", "")) for m in family_details}
        known.discard("")
        extras_seen: set[str] = set()
        extras: list[dict] = []

        # (1) per-member walk
        for m in list(family_details):
            for rel in m.get("related_us_apps") or []:
                rel_app = rel.get("app_num", "")
                if not rel_app or rel_app in known or rel_app in extras_seen:
                    continue
                extras_seen.add(rel_app)
                extras.append({
                    "pub_num": f"US{rel['patent']}B2" if rel.get("patent") else f"US{rel_app}",
                    "app_num": rel_app,
                    "href":    "",
                    "title":   "",
                    "country": "US",
                    "date":    rel.get("filing", ""),
                    "lang":    "",
                })

        # (2) primary-app continuity fetch — BFS through parent/child links
        _us_primaries = [m for m in family_details
                         if tracker.country_code(m.get("pub_num", "")) == "US"
                         and m.get("app_num")]
        _seed_apps = [tracker._clean_app_num(m["app_num"]) for m in _us_primaries]
        _visited: set[str] = set(known)
        _queue = [a for a in _seed_apps if a]
        while _queue:
            _app = _queue.pop(0)
            if _app in _visited:
                continue
            _visited.add(_app)
            try:
                stub = {"pub_num": f"US{_app}", "app_num": _app, "country": "US",
                        "href": "", "title": "", "date": "", "lang": ""}
                det = tracker.fetch_us_member_via_odp(stub, odp_key)
                if not det or det.get("fetch_error"):
                    continue
                for rel in det.get("related_us_apps", []) or []:
                    rel_app = rel.get("app_num", "")
                    if rel_app and rel_app not in _visited and rel_app not in extras_seen:
                        _queue.append(rel_app)
                        if rel_app not in known:
                            extras_seen.add(rel_app)
                            extras.append({
                                "pub_num": (f"US{rel['patent']}B2"
                                            if rel.get("patent") else f"US{rel_app}"),
                                "app_num": rel_app,
                                "href":    "",
                                "title":   "",
                                "country": "US",
                                "date":    rel.get("filing", ""),
                                "lang":    "",
                            })
            except Exception as exc:
                print(f"  continuity BFS skipped {_app}: {exc}")

        print(f"  continuity merge: adding {len(extras)} US app(s) discovered via ODP")
        for j, stub in enumerate(extras):
            try:
                det = tracker.fetch_member_details(
                    stub, total + j + 1, total + len(extras), odp_api_key=odp_key
                )
                family_details.append(det)
            except Exception as exc:
                print(f"  continuity merge skipped {stub.get('app_num')}: {exc}")

    # ── ODP ↔ EPO cross-validation for US members ────────────────────────────
    status_discrepancies: list = []
    if epo_ran and epo_members:
        status_discrepancies = tracker.cross_validate_odp_epo(family_details, epo_members)

    # ── DeepL batch translation ───────────────────────────────────────────────
    primary_title    = (tracker._first(metas.get("DC.title", [])) or "").strip()
    primary_abstract = (tracker._first(metas.get("DC.description", [])) or "").strip()

    nonen_indices = [
        i for i, m in enumerate(family_details)
        if tracker.needs_translation(
            m.get("lang", ""),
            tracker.country_code(m.get("pub_num", "")),
        )
    ]

    primary_cc          = tracker.country_code(number)
    deepl_key           = os.environ.get("DEEPL_API_KEY", "").strip()
    translated_title    = None
    translated_abstract = None
    translate_primary   = tracker.needs_translation("", primary_cc)

    if deepl_key:
        primary_texts      = [primary_title, primary_abstract] if translate_primary else []
        member_texts       = [family_details[i].get("member_title", "") for i in nonen_indices]
        texts_to_translate = primary_texts + member_texts

        if texts_to_translate:
            translations = tracker.deepl_translate(texts_to_translate)
        else:
            translations = None

        if translations:
            def _tr(idx: int) -> str:
                if idx >= len(translations):
                    return ""
                t   = translations[idx]
                src = t.get("detected_source_language", "").upper()
                txt = t.get("text", "").strip()
                return txt if src not in ("EN",) else ""

            offset = 0
            if translate_primary:
                translated_title    = _tr(0)
                translated_abstract = _tr(1)
                offset = 2
            for list_pos, family_idx in enumerate(nonen_indices):
                tr = _tr(offset + list_pos)
                if tr:
                    family_details[family_idx]["translated_title"] = tr

    # ── EPO INPADOC merge + ODP/EPO discrepancy consolidation ────────────────
    epo_only:      list = []
    discrepancies: list = []

    if epo_ran and epo_members:
        epo_only_raw, pub_discrepancies = tracker.merge_epo_with_google(
            family_details, epo_members
        )
        epo_only = epo_only_raw or []

        # Combine EPO publication discrepancies + ODP/EPO status discrepancies.
        # Status discrepancies share the same dict shape expected by the dashboard
        # (country, epo_pub, epo_app, google_pub, google_app, note).
        discrepancies = list(pub_discrepancies or [])
        for sd in status_discrepancies:
            discrepancies.append({
                "country":    "US",
                "epo_pub":    sd["pub_num"],
                "epo_app":    "",
                "google_pub": sd["pub_num"],
                "google_app": "",
                "note":       sd["note"],
            })

    dashboard_html = tracker.generate_dashboard_html(
        metas, family_details, url, patent_input, claims,
        epo_only=epo_only or None,
        discrepancies=discrepancies or None,
        translated_title=translated_title or None,
        translated_abstract=translated_abstract or None,
    )

    # ── Split contributors into inventors vs assignees ────────────────────────
    contributors = metas.get("DC.contributor", [])
    assignees = [
        c.strip() for c in contributors
        if len(c.strip().split()) >= 3
        or any(kw in c for kw in ("LLC","Inc","Corp","Ltd","Company","Institute","University"))
    ]
    inventors = [c.strip() for c in contributors if c.strip() not in assignees]

    # ── Compact family summary (Firestore-safe) ───────────────────────────────
    family_summary = []
    for m in family_details:
        dl = tracker._get_next_deadline(m)
        family_summary.append({
            "pub_num":             m["pub_num"],
            "country":             tracker.country_code(m["pub_num"]),
            "status":              m.get("status", "unknown"),
            "filing_date":         m.get("filing_date") or m.get("date") or "",
            "grant_date":          m.get("grant_date", ""),
            "app_num":             m.get("app_num", ""),
            "title":               m.get("member_title", ""),
            "href":                m.get("href", ""),
            "next_deadline_label": dl["label"] if dl else "",
            "next_deadline_date":  dl["date"]  if dl else "",
            "next_deadline_type":  dl["type"]  if dl else "",
        })

    return {
        "patent_number":       number,
        "title":               (tracker._first(metas.get("DC.title", [])) or "").strip(),
        "translated_title":    translated_title or "",
        "translated_abstract": translated_abstract or "",
        "filing_date":         dates[0] if dates else "",
        "grant_date":          dates[1] if len(dates) > 1 else "",
        "assignees":           assignees,
        "inventors":           inventors,
        "family_size":         len(family_details),
        "jurisdictions":       len({tracker.country_code(m["pub_num"]) for m in family_details}),
        "granted_count":       sum(1 for m in family_details if m["status"] == "granted"),
        "pending_count":       sum(1 for m in family_details if m["status"] == "pending"),
        "family":              family_summary,
        "epo_only":            epo_only,
        "discrepancies":       discrepancies,
        "dashboard_html":      dashboard_html,
        "google_patents_url":  url,
        "main_metas":          dict(metas),
        "claims":              claims or [],
    }


# ── Deadline computation ──────────────────────────────────────────────────────

def _compute_deadlines(patent_data: dict) -> list[dict]:
    """Return upcoming maintenance/annuity deadlines for one saved patent."""
    from datetime import date as _dt

    pnum  = patent_data.get("patent_number", "")
    title = patent_data.get("title", "")
    deadlines: list[dict] = []

    for m in patent_data.get("family", []):
        cc          = m.get("country", "")
        grant_date  = m.get("grant_date", "")
        filing_date = m.get("filing_date", "")
        pub_num     = m.get("pub_num", "")

        if cc == "US" and m.get("status") == "granted" and grant_date:
            for fee in tracker.calc_maintenance_fees(grant_date):
                if fee["status"] == "paid":
                    continue
                deadlines.append({
                    "patent_number": pnum,
                    "title":         title,
                    "pub_num":       pub_num,
                    "country":       "US",
                    "type":          "maintenance",
                    "label":         fee["label"],
                    "due_date":      fee["due"],
                    "grace_end":     fee["grace_end"],
                    "amount_usd":    fee["amount"],
                    "currency":      "USD",
                    "status":        fee["status"],
                })

        elif cc in tracker._ANNUITY_SCHEDULES and filing_date:
            ann = tracker.calc_annuities(filing_date, cc)
            if not ann or ann.get("expired") or ann.get("wo"):
                continue
            sched = tracker._ANNUITY_SCHEDULES[cc]
            try:
                fd = _dt.fromisoformat(filing_date)
            except (ValueError, TypeError):
                continue
            for row in ann.get("rows", [])[:3]:   # show next 3 years only
                due_dt = tracker._add_months(fd, row["year"] * 12)
                deadlines.append({
                    "patent_number": pnum,
                    "title":         title,
                    "pub_num":       pub_num,
                    "country":       cc,
                    "type":          "annuity",
                    "label":         f"Year {row['year']} annuity",
                    "due_date":      due_dt.isoformat(),
                    "grace_end":     None,
                    "amount_usd":    row["fee_usd"],
                    "amount_local":  row["fee_local"],
                    "currency":      sched["currency"],
                    "status":        "current" if row["is_current"] else "upcoming",
                })

        # Office action / prosecution response deadlines stored at search time
        ndl_label = m.get("next_deadline_label", "")
        ndl_date  = m.get("next_deadline_date",  "")
        ndl_type  = m.get("next_deadline_type",  "")
        if ndl_type == "response" and ndl_label and ndl_date:
            deadlines.append({
                "patent_number": pnum,
                "title":         title,
                "pub_num":       pub_num,
                "country":       cc,
                "type":          "office_action",
                "label":         ndl_label,
                "due_date":      ndl_date,
                "grace_end":     None,
                "amount_usd":    None,
                "currency":      None,
                "status":        "current",
            })

    return sorted(deadlines, key=lambda x: x["due_date"])


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/search/local", methods=["POST"])
def search_local():
    """
    Unauthenticated search endpoint for the dashboard's built-in search bar.
    Only accepts requests from localhost — not exposed to authenticated users.
    """
    remote = request.remote_addr or ""
    if remote not in ("127.0.0.1", "::1", "localhost"):
        return jsonify({"error": "Local endpoint only"}), 403

    body         = request.get_json(silent=True) or {}
    patent_input = (body.get("patent_number") or "").strip()
    search_type  = (body.get("search_type") or "auto").strip().lower()
    if not patent_input:
        return jsonify({"error": "patent_number is required"}), 400

    try:
        result = _run_search(patent_input, search_type=search_type)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"Search failed: {exc}"}), 500

    return jsonify(result)


@app.route("/api/search", methods=["POST"])
@require_auth
def search():
    """
    Run a full patent search.
    Body: {
        "patent_number": "US 12,178,560",
        "search_type":   "auto" | "patent_number" | "application_number" | "publication_number"
    }
    Returns all patent data including dashboard_html.
    Also saves a compact record to the user's search history in Firestore.
    """
    body         = request.get_json(silent=True) or {}
    patent_input = (body.get("patent_number") or "").strip()
    search_type  = (body.get("search_type") or "auto").strip().lower()
    if not patent_input:
        return jsonify({"error": "patent_number is required"}), 400

    try:
        result = _run_search(patent_input, search_type=search_type)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        traceback.print_exc()
        msg = str(exc)
        # Surface rate-limit / transient Google errors with a friendlier message
        if "503" in msg or "429" in msg:
            msg = (
                "Google Patents is temporarily unavailable (rate limit / 503). "
                "Please wait 30–60 seconds and try again."
            )
        elif "502" in msg or "504" in msg:
            msg = "Google Patents returned a gateway error. Please try again in a moment."
        return jsonify({"error": msg}), 500

    # Save compact record to search history (drop HTML to keep Firestore lean)
    history = {k: v for k, v in result.items() if k != "dashboard_html"}
    history["searched_at"] = datetime.now(timezone.utc)
    history["query"]       = patent_input
    history["search_type"] = search_type
    try:
        db.collection("users").document(request.uid) \
          .collection("searches").add(history)
    except Exception:
        pass  # don't fail the response if Firestore write fails

    return jsonify(result)


@app.route("/api/portfolios", methods=["GET"])
@require_auth
def list_portfolios():
    """List all saved portfolio entries for the current user (no dashboard HTML)."""
    try:
        docs = (
            db.collection("users").document(request.uid)
            .collection("portfolios")
            .order_by("saved_at", direction=firestore.Query.DESCENDING)
            .stream()
        )
        portfolios = []
        for doc in docs:
            entry      = doc.to_dict()
            entry["id"] = doc.id
            entry.pop("dashboard_html", None)
            portfolios.append(entry)
        return jsonify({"portfolios": portfolios})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios", methods=["POST"])
@require_auth
def save_portfolio():
    """
    Save a patent to the user's portfolio.
    Body: the full search result dict (including dashboard_html).
    Returns 409 if patent is already saved.
    """
    body          = request.get_json(silent=True) or {}
    patent_number = (body.get("patent_number") or "").strip()
    if not patent_number:
        return jsonify({"error": "patent_number is required"}), 400

    # Duplicate check
    existing = (
        db.collection("users").document(request.uid)
        .collection("portfolios")
        .where("patent_number", "==", patent_number)
        .limit(1)
        .stream()
    )
    for _ in existing:
        return jsonify({"error": "Patent already in portfolio"}), 409

    entry = {**body, "saved_at": datetime.now(timezone.utc)}
    try:
        _, doc_ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").add(entry)
        )
        return jsonify({"id": doc_ref.id, "patent_number": patent_number}), 201
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>", methods=["GET"])
@require_auth
def get_portfolio(portfolio_id: str):
    """Get a single portfolio entry including its dashboard_html."""
    try:
        doc = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id).get()
        )
        if not doc.exists:
            return jsonify({"error": "Not found"}), 404
        entry       = doc.to_dict()
        entry["id"] = doc.id
        # Serialize Firestore timestamp objects → ISO strings so JSON encoding works
        for k in ("saved_at", "refreshed_at"):
            v = entry.get(k)
            if hasattr(v, "isoformat"):
                entry[k] = v.isoformat()
        return jsonify(entry)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>/dashboard", methods=["PATCH"])
@require_auth
def patch_portfolio_dashboard(portfolio_id: str):
    """
    Persist a freshly-generated dashboard HTML back to Firestore.
    Called after a manual refresh so the next load can serve it from cache.
    Body: { "dashboard_html": "...", "family": [...] }
    """
    body           = request.get_json(silent=True) or {}
    dashboard_html = body.get("dashboard_html", "")
    family         = body.get("family")
    if not dashboard_html:
        return jsonify({"error": "dashboard_html is required"}), 400
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        update: dict = {
            "dashboard_html": dashboard_html,
            "refreshed_at":   datetime.now(timezone.utc),
        }
        if family is not None:
            update["family"] = family
        ref.update(update)
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>/refresh", methods=["POST"])
@require_auth
def refresh_portfolio_data(portfolio_id: str):
    """
    Re-fetch prosecution data using stored app numbers and USPTO ODP — no
    full Google Patents re-scrape needed.  Falls back to GP only for non-US
    members or members whose app_num is missing from stored data.
    """
    try:
        doc = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id).get()
        )
        if not doc.exists:
            return jsonify({"error": "Not found"}), 404
        stored      = doc.to_dict()
        stored["id"] = portfolio_id
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    patent_number = stored.get("patent_number", "")
    stored_family = stored.get("family", [])
    stored_metas  = stored.get("main_metas") or {}
    odp_key       = os.environ.get("USPTO_ODP_API_KEY", "")

    if not stored_family:
        return jsonify({"error": "No stored family data — try Force Re-scrape instead"}), 400

    # Reconstruct member dicts from stored compact family summary
    members = [
        {
            "pub_num": m.get("pub_num", ""),
            "app_num": m.get("app_num", ""),
            "href":    m.get("href") or f"https://patents.google.com/patent/{m.get('pub_num','')}/en",
            "title":   m.get("title", "") or m.get("member_title", ""),
            "country": m.get("country", ""),
        }
        for m in stored_family
    ]

    total = len(members)
    family_details = [
        tracker.fetch_member_details(m, i + 1, total, odp_api_key=odp_key)
        for i, m in enumerate(members)
    ]

    # If we have main_metas from the initial scrape, use those.
    # Otherwise reconstruct a minimal version from stored fields.
    if not stored_metas:
        stored_metas = {
            "DC.title":       [stored.get("title", "")],
            "DC.description": [stored.get("translated_abstract", "")],
            "DC.contributor": stored.get("assignees", []) + stored.get("inventors", []),
            "DC.date":        [stored.get("filing_date", ""), stored.get("grant_date", "")],
            "citation_patent_number": [patent_number],
        }

    dashboard_html = tracker.generate_dashboard_html(
        stored_metas, family_details,
        stored.get("google_patents_url", ""),
        patent_number,
        stored.get("claims") or None,
        epo_only=stored.get("epo_only") or None,
        discrepancies=stored.get("discrepancies") or None,
        translated_title=stored.get("translated_title") or None,
        translated_abstract=stored.get("translated_abstract") or None,
    )

    # Rebuild compact family summary with fresh data
    family_summary = []
    for m in family_details:
        dl = tracker._get_next_deadline(m)
        family_summary.append({
            "pub_num":             m["pub_num"],
            "country":             tracker.country_code(m["pub_num"]),
            "status":              m.get("status", "unknown"),
            "filing_date":         m.get("filing_date") or m.get("date") or "",
            "grant_date":          m.get("grant_date", ""),
            "app_num":             m.get("app_num", ""),
            "title":               m.get("member_title", ""),
            "href":                m.get("href", ""),
            "next_deadline_label": dl["label"] if dl else "",
            "next_deadline_date":  dl["date"]  if dl else "",
            "next_deadline_type":  dl["type"]  if dl else "",
        })

    ref = (
        db.collection("users").document(request.uid)
        .collection("portfolios").document(portfolio_id)
    )
    ref.update({
        "dashboard_html": dashboard_html,
        "family":         family_summary,
        "refreshed_at":   datetime.now(timezone.utc),
    })

    result = {
        **stored,
        "dashboard_html": dashboard_html,
        "family":         family_summary,
    }
    for k in ("saved_at", "refreshed_at"):
        v = result.get(k)
        if hasattr(v, "isoformat"):
            result[k] = v.isoformat()
    result["refreshed_at"] = datetime.now(timezone.utc).isoformat()
    return jsonify(result)


@app.route("/api/portfolios/<portfolio_id>/name", methods=["PATCH"])
@require_auth
def patch_portfolio_name(portfolio_id: str):
    """Set a custom display name for a patent family dashboard."""
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.update({"family_name": name})
        return jsonify({"ok": True, "family_name": name})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>/notes", methods=["PATCH"])
@require_auth
def patch_portfolio_notes(portfolio_id: str):
    """
    Upsert the notes dict for one portfolio entry.
    Body: { "notes": { "<pub_num>": "<text>", … } }
    """
    body = request.get_json(silent=True) or {}
    notes = body.get("notes")
    if not isinstance(notes, dict):
        return jsonify({"error": "notes must be an object"}), 400
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.update({"notes": notes})
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patent-doc", methods=["GET"])
def patent_doc_proxy():
    """
    Public proxy endpoint that fetches a single ODP document PDF and adds the
    required X-API-Key header.  Browsers cannot send custom headers via a plain
    <a href>, so all PDF download buttons in the dashboard route through here.

    Usage: GET /api/patent-doc?url=<encoded-odp-download-url>
    Only allows URLs whose prefix matches https://api.uspto.gov/api/v1/download/
    """
    import requests as _req
    from flask import Response as _Resp
    import urllib.parse as _up

    raw_url = request.args.get("url", "").strip()
    if not raw_url.startswith("https://api.uspto.gov/api/v1/download/"):
        return jsonify({"error": "URL not permitted"}), 400

    odp_key = os.environ.get("USPTO_ODP_API_KEY", "").strip()
    if not odp_key:
        return jsonify({"error": "ODP API key not configured"}), 503

    try:
        upstream = _req.get(
            raw_url,
            headers={"X-API-Key": odp_key, "Accept": "application/pdf"},
            timeout=60,
            stream=True,
        )
        upstream.raise_for_status()
        content_type = upstream.headers.get("Content-Type", "application/pdf")
        # Suggest a filename from the URL for the browser's save-as dialog
        filename = raw_url.rstrip("/").rsplit("/", 1)[-1] or "document.pdf"
        resp = _Resp(
            upstream.content,
            status=200,
            content_type=content_type,
        )
        resp.headers["Content-Disposition"] = f'inline; filename="{filename}"'
        resp.headers["Cache-Control"] = "private, max-age=3600"
        return resp
    except _req.HTTPError as exc:
        return jsonify({"error": f"ODP returned {exc.response.status_code}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)[:120]}), 502


@app.route("/api/uspto/documents/<path:app_num>", methods=["GET"])
@require_auth
def get_uspto_documents(app_num: str):
    """
    Proxy to USPTO Open Data Portal API to fetch IFW prosecution documents
    for a US patent application.
    Returns a document list (if ODP API key is configured) plus the viewer URL.
    """
    import re
    import requests as _req

    # Normalize to pure digits: "16/123,456" → "16123456"
    clean = re.sub(r"[^\d]", "", app_num)
    if not clean:
        return jsonify({"error": "Invalid application number"}), 400

    viewer_url      = f"https://data.uspto.gov/patent-file-wrapper/details/{clean}/documents"
    patent_center   = f"https://data.uspto.gov/patent-file-wrapper/details/{clean}/documents"
    odp_key         = os.environ.get("USPTO_ODP_API_KEY", "").strip()

    if not odp_key:
        return jsonify({
            "documents":     [],
            "viewer_url":    viewer_url,
            "patent_center": patent_center,
            "no_key":        True,
        })

    try:
        resp = _req.get(
            f"https://api.uspto.gov/api/v1/patent/applications/{clean}/documents",
            headers={"X-API-Key": odp_key, "Accept": "application/json"},
            timeout=20,
        )
        resp.raise_for_status()
        raw  = resp.json()
        # ODP response shape varies; normalise into a flat list
        docs = (
            raw.get("patentDocuments")
            or raw.get("documents")
            or raw.get("results")
            or (raw if isinstance(raw, list) else [])
        )
        return jsonify({
            "documents":     docs,
            "viewer_url":    viewer_url,
            "patent_center": patent_center,
        })
    except Exception as exc:
        # Return viewer links even on API error so the UI degrades gracefully
        return jsonify({
            "documents":     [],
            "viewer_url":    viewer_url,
            "patent_center": patent_center,
            "error":         str(exc),
        })


@app.route("/api/portfolios/<portfolio_id>/files", methods=["GET"])
@require_auth
def list_portfolio_files(portfolio_id: str):
    """List uploaded / linked file metadata for a portfolio entry."""
    try:
        docs = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
            .collection("files")
            .order_by("uploaded_at", direction=firestore.Query.DESCENDING)
            .stream()
        )
        files = []
        for doc in docs:
            f        = doc.to_dict()
            f["id"]  = doc.id
            ts       = f.get("uploaded_at")
            if hasattr(ts, "isoformat"):
                f["uploaded_at"] = ts.isoformat()
            files.append(f)
        return jsonify({"files": files})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>/files", methods=["POST"])
@require_auth
def add_portfolio_file(portfolio_id: str):
    """
    Record file metadata after a Firebase Storage upload (or to save a USPTO doc link).
    Body: { name, download_url, storage_path?, size?, type?, source? }
    """
    body = request.get_json(silent=True) or {}
    if not body.get("name") or not body.get("download_url"):
        return jsonify({"error": "name and download_url are required"}), 400
    try:
        port_ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
        )
        if not port_ref.get().exists:
            return jsonify({"error": "Portfolio not found"}), 404
        meta = {
            "name":         body["name"],
            "download_url": body["download_url"],
            "storage_path": body.get("storage_path"),   # None for USPTO links
            "size":         body.get("size", 0),
            "type":         body.get("type", ""),
            "source":       body.get("source", "local"), # "local" | "uspto"
            "tile_pub_num": body.get("tile_pub_num"),    # e.g. "US12178560B2"; None = family-level
            "uploaded_at":  datetime.now(timezone.utc),
        }
        _, doc_ref = port_ref.collection("files").add(meta)
        return jsonify({"id": doc_ref.id, **{k: v for k, v in meta.items() if k != "uploaded_at"}}), 201
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>/files/<file_id>", methods=["DELETE"])
@require_auth
def delete_portfolio_file(portfolio_id: str, file_id: str):
    """Delete file metadata from Firestore. Client handles Storage deletion."""
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
            .collection("files").document(file_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.delete()
        return jsonify({"deleted": file_id})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/portfolios/<portfolio_id>", methods=["DELETE"])
@require_auth
def delete_portfolio(portfolio_id: str):
    """Remove a patent from the user's portfolio."""
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("portfolios").document(portfolio_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.delete()
        return jsonify({"deleted": portfolio_id})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/alerts", methods=["GET"])
@require_auth
def get_alerts():
    """
    Return all upcoming maintenance/annuity deadlines across the user's
    entire portfolio, sorted by due date.
    Optionally filter: ?days=90 (only deadlines within N days).
    """
    try:
        days_filter = request.args.get("days", type=int)
        docs        = (
            db.collection("users").document(request.uid)
            .collection("portfolios").stream()
        )
        all_deadlines: list[dict] = []
        for doc in docs:
            patent_data       = doc.to_dict()
            patent_data["id"] = doc.id
            all_deadlines.extend(_compute_deadlines(patent_data))

        if days_filter:
            from datetime import date as _dt
            cutoff    = _dt.today().isoformat()[:10]
            from datetime import timedelta
            far       = (_dt.today() + timedelta(days=days_filter)).isoformat()
            all_deadlines = [
                d for d in all_deadlines
                if cutoff <= d["due_date"] <= far
            ]

        return jsonify({"alerts": all_deadlines, "count": len(all_deadlines)})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Search history ───────────────────────────────────────────────────────────

@app.route("/api/searches", methods=["GET"])
@require_auth
def list_searches():
    """
    Return the user's most recent patent searches, newest first.
    Optional: ?limit=N (default 8, max 20).
    """
    try:
        limit = min(int(request.args.get("limit", 8)), 20)
        docs  = (
            db.collection("users").document(request.uid)
            .collection("searches")
            .order_by("searched_at", direction=firestore.Query.DESCENDING)
            .limit(limit)
            .stream()
        )
        results = []
        seen_nums: set[str] = set()
        for doc in docs:
            d   = doc.to_dict()
            num = d.get("patent_number", "")
            # Deduplicate: keep only the most recent search per patent number
            if num in seen_nums:
                continue
            seen_nums.add(num)
            sat = d.get("searched_at")
            results.append({
                "id":            doc.id,
                "patent_number": num,
                "title":         d.get("title", ""),
                "family_size":   d.get("family_size", 0),
                "granted_count": d.get("granted_count", 0),
                "pending_count": d.get("pending_count", 0),
                "searched_at":   sat.isoformat() if hasattr(sat, "isoformat") else str(sat or ""),
            })
        return jsonify({"searches": results})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Patentee groups (combined multi-family dashboards) ───────────────────────

def _render_combined_dashboard(group_name: str, members: list[dict]) -> str:
    """
    Stitch together the saved dashboard_html from several portfolio entries
    into one combined view with a sticky table of contents.

    members is a list of dicts from the user's portfolios collection, each
    expected to have: id, patent_number, title, dashboard_html.
    """
    import html as _html

    # Sticky TOC + section separators. Each family's dashboard HTML is wrapped
    # in an isolated <article> with a unique anchor so the TOC can jump there.
    # We intentionally leave the inner dashboard HTML untouched — it's already
    # a self-contained fragment that renders correctly inline.
    toc_items = []
    sections  = []
    for m in members:
        pid   = m.get("id", "")
        pnum  = m.get("patent_number", "") or "—"
        title = (m.get("title", "") or "").strip()
        dash  = m.get("dashboard_html", "") or "<p style=\"color:#888\">No cached dashboard.</p>"
        anchor = f"fam-{_html.escape(pid)}"
        toc_items.append(
            f'<a href="#{anchor}" style="display:inline-block;padding:6px 12px;'
            f'border-radius:16px;background:#e8f0fe;color:#1a73e8;text-decoration:none;'
            f'font-size:13px;font-weight:600;margin:4px;">'
            f'{_html.escape(pnum)}</a>'
        )
        sections.append(
            f'<section id="{anchor}" style="margin-top:24px;border-top:3px solid #1a73e8;'
            f'padding-top:14px;">'
            f'<header style="padding:10px 14px;background:#f8f9fa;border-radius:8px;'
            f'margin-bottom:10px;">'
            f'<h2 style="margin:0;color:#1a1a2e;font-size:18px;">'
            f'{_html.escape(pnum)}'
            f'{(" — " + _html.escape(title)) if title else ""}'
            f'</h2></header>'
            f'{dash}'
            f'</section>'
        )

    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<style>'
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
        'margin:0;background:#fff;color:#1a1a2e;}'
        '.combined-header{position:sticky;top:0;z-index:50;background:#fff;'
        'border-bottom:1px solid #e0e0e0;padding:14px 20px;}'
        '.combined-title{margin:0 0 10px;color:#1a1a2e;font-size:20px;}'
        '.combined-body{padding:0 20px 40px;}'
        '</style></head><body>'
        '<div class="combined-header">'
        f'<h1 class="combined-title">{_html.escape(group_name or "Combined dashboard")}'
        f' <span style="font-weight:400;color:#888;font-size:14px;">'
        f'({len(members)} families)</span></h1>'
        '<div>' + "".join(toc_items) + '</div>'
        '</div>'
        '<div class="combined-body">'
        + "".join(sections) +
        '</div>'
        '</body></html>'
    )


def _load_portfolios_by_ids(uid: str, ids: list[str]) -> list[dict]:
    """Batch-fetch portfolio entries for the combined dashboard renderer."""
    out: list[dict] = []
    coll = db.collection("users").document(uid).collection("portfolios")
    for pid in ids:
        if not pid:
            continue
        snap = coll.document(pid).get()
        if not snap.exists:
            continue
        entry = snap.to_dict() or {}
        entry["id"] = snap.id
        out.append(entry)
    return out


@app.route("/api/patentee-groups", methods=["GET"])
@require_auth
def list_patentee_groups():
    """List all saved patentee groups for the current user."""
    try:
        docs = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups")
            .order_by("updated_at", direction=firestore.Query.DESCENDING)
            .stream()
        )
        groups = []
        for d in docs:
            g = d.to_dict() or {}
            g["id"] = d.id
            groups.append(g)
        return jsonify({"groups": groups})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups", methods=["POST"])
@require_auth
def create_patentee_group():
    """
    Create a new patentee group.
    Body: { "name": "Acme Corp — All Families", "portfolio_ids": ["abc","def"] }
    """
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    pids = body.get("portfolio_ids") or []
    if not name:
        return jsonify({"error": "name is required"}), 400
    if not isinstance(pids, list):
        return jsonify({"error": "portfolio_ids must be an array"}), 400
    pids = [str(p) for p in pids if p]
    now  = datetime.now(timezone.utc)
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups").document()
        )
        ref.set({
            "name":          name,
            "portfolio_ids": pids,
            "created_at":    now,
            "updated_at":    now,
        })
        return jsonify({"id": ref.id, "name": name, "portfolio_ids": pids}), 201
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups/<group_id>", methods=["GET"])
@require_auth
def get_patentee_group(group_id):
    """Return one group's metadata."""
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups").document(group_id)
        )
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "Not found"}), 404
        g = snap.to_dict() or {}
        g["id"] = snap.id
        return jsonify(g)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups/<group_id>", methods=["PATCH"])
@require_auth
def update_patentee_group(group_id):
    """
    Update a patentee group (partial).
    Body may include: { "name": "...", "portfolio_ids": [...] }
    """
    body  = request.get_json(silent=True) or {}
    patch = {}
    if "name" in body:
        nm = (body.get("name") or "").strip()
        if not nm:
            return jsonify({"error": "name cannot be empty"}), 400
        patch["name"] = nm
    if "portfolio_ids" in body:
        pids = body.get("portfolio_ids") or []
        if not isinstance(pids, list):
            return jsonify({"error": "portfolio_ids must be an array"}), 400
        patch["portfolio_ids"] = [str(p) for p in pids if p]
    if not patch:
        return jsonify({"error": "nothing to update"}), 400
    patch["updated_at"] = datetime.now(timezone.utc)
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups").document(group_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.update(patch)
        return jsonify({"id": group_id, **patch})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups/<group_id>", methods=["DELETE"])
@require_auth
def delete_patentee_group(group_id):
    """Delete a patentee group (does not delete the underlying portfolio entries)."""
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups").document(group_id)
        )
        if not ref.get().exists:
            return jsonify({"error": "Not found"}), 404
        ref.delete()
        return jsonify({"deleted": group_id})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups/<group_id>/dashboard", methods=["GET"])
@require_auth
def get_patentee_group_dashboard(group_id):
    """Return the merged dashboard HTML for a saved group."""
    try:
        ref = (
            db.collection("users").document(request.uid)
            .collection("patentee_groups").document(group_id)
        )
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "Not found"}), 404
        g = snap.to_dict() or {}
        ids = g.get("portfolio_ids") or []
        members = _load_portfolios_by_ids(request.uid, ids)
        html = _render_combined_dashboard(g.get("name", "Combined"), members)
        return jsonify({
            "id":             group_id,
            "name":           g.get("name", ""),
            "portfolio_ids":  ids,
            "member_count":   len(members),
            "dashboard_html": html,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/patentee-groups/preview", methods=["POST"])
@require_auth
def preview_patentee_group():
    """
    Ad-hoc combined dashboard: render without persisting.
    Body: { "portfolio_ids": [...], "name": "Preview" }
    """
    body = request.get_json(silent=True) or {}
    pids = body.get("portfolio_ids") or []
    name = (body.get("name") or "Combined preview").strip()
    if not isinstance(pids, list) or not pids:
        return jsonify({"error": "portfolio_ids is required"}), 400
    try:
        members = _load_portfolios_by_ids(request.uid, [str(p) for p in pids if p])
        html    = _render_combined_dashboard(name, members)
        return jsonify({
            "name":           name,
            "portfolio_ids":  [m["id"] for m in members],
            "member_count":   len(members),
            "dashboard_html": html,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── AI prosecution assistant ─────────────────────────────────────────────────

def _find_family_member(portfolio_id: str, pub_num: str) -> tuple[object, dict | None]:
    """Return (portfolio_ref, member_dict) or (portfolio_ref, None) if not found."""
    port_ref = (
        db.collection("users").document(request.uid)
          .collection("portfolios").document(portfolio_id)
    )
    snap = port_ref.get()
    if not snap.exists:
        return port_ref, None
    data = snap.to_dict() or {}
    family = data.get("family", []) or []
    member = next((m for m in family if m.get("pub_num") == pub_num), None)
    return port_ref, member


def _download_oa_text(member: dict) -> tuple[str, dict | None]:
    """
    Download the most recent office-action PDF for this family member via the
    USPTO ODP and extract the text. Returns (text, doc_meta). Empty text
    string if no OA is available or extraction fails.
    """
    import io as _io
    import requests as _rq

    OA_CODES = {"CTNF", "CTFR", "MCTNF", "MCTFR"}
    oa_docs  = member.get("oa_documents") or []
    oa_doc   = next(
        (d for d in sorted(oa_docs, key=lambda x: x.get("date", ""), reverse=True)
         if (d.get("code") or "").upper() in OA_CODES and d.get("download_url")),
        None,
    )
    if not oa_doc:
        return "", None

    try:
        resp = _rq.get(
            oa_doc["download_url"],
            headers={"X-API-Key": os.environ.get("USPTO_ODP_API_KEY", "")},
            timeout=30,
        )
        resp.raise_for_status()
        pdf_bytes = resp.content
    except Exception as exc:
        print(f"  OA PDF download failed: {exc}")
        return "", oa_doc

    # Extract text with pypdf (lightweight, pure-python)
    try:
        from pypdf import PdfReader
        reader = PdfReader(_io.BytesIO(pdf_bytes))
        text   = "\n".join((page.extract_text() or "") for page in reader.pages)
        return text.strip(), oa_doc
    except Exception as exc:
        print(f"  OA PDF text extraction failed: {exc}")
        return "", oa_doc


@app.route("/api/ai/analyze", methods=["POST"])
@require_auth
def ai_analyze():
    """
    Run AI prosecution analysis on one family member.
    Body: { "portfolio_id": "...", "pub_num": "..." }
    Cached at users/{uid}/portfolios/{pid}/ai_analysis/{pub_num}.
    """
    body = request.get_json(silent=True) or {}
    portfolio_id = (body.get("portfolio_id") or "").strip()
    pub_num      = (body.get("pub_num") or "").strip()
    if not portfolio_id or not pub_num:
        return jsonify({"error": "portfolio_id and pub_num are required"}), 400

    try:
        from ai_engine import PatentAI
    except ImportError as exc:
        return jsonify({"error": f"AI engine unavailable: {exc}"}), 500

    port_ref, member = _find_family_member(portfolio_id, pub_num)
    if member is None:
        return jsonify({"error": "portfolio or family member not found"}), 404

    try:
        ai     = PatentAI()
        result = ai.analyze_prosecution(member)
        doc_id = pub_num.replace("/", "_")
        port_ref.collection("ai_analysis").document(doc_id).set({
            **result,
            "analyzed_at": datetime.now(timezone.utc),
            "pub_num":     pub_num,
            "kind":        "prosecution",
        })
        return jsonify(result)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"AI analysis failed: {exc}"}), 500


@app.route("/api/ai/analyze-oa", methods=["POST"])
@require_auth
def ai_analyze_oa():
    """
    Download the most recent office action, extract text, run Claude's OA schema.
    Body: { "portfolio_id": "...", "pub_num": "..." }
    """
    body = request.get_json(silent=True) or {}
    portfolio_id = (body.get("portfolio_id") or "").strip()
    pub_num      = (body.get("pub_num") or "").strip()
    if not portfolio_id or not pub_num:
        return jsonify({"error": "portfolio_id and pub_num are required"}), 400

    try:
        from ai_engine import PatentAI
    except ImportError as exc:
        return jsonify({"error": f"AI engine unavailable: {exc}"}), 500

    port_ref, member = _find_family_member(portfolio_id, pub_num)
    if member is None:
        return jsonify({"error": "portfolio or family member not found"}), 404

    oa_text, oa_doc = _download_oa_text(member)
    if not oa_text:
        return jsonify({"error": "No office action PDF available for analysis"}), 404

    try:
        ai     = PatentAI()
        result = ai.analyze_office_action(member, oa_text, oa_doc)
        doc_id = pub_num.replace("/", "_")
        port_ref.collection("ai_analysis").document(f"{doc_id}__oa").set({
            **result,
            "analyzed_at": datetime.now(timezone.utc),
            "pub_num":     pub_num,
            "kind":        "office_action",
            "oa_code":     (oa_doc or {}).get("code", ""),
            "oa_date":     (oa_doc or {}).get("date", ""),
        })
        return jsonify(result)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"OA analysis failed: {exc}"}), 500


@app.route("/api/ai/analyze/<portfolio_id>/<path:pub_num>", methods=["GET"])
@require_auth
def ai_get_cached_analysis(portfolio_id, pub_num):
    """Return the cached AI analysis (prosecution kind) for this family member."""
    try:
        doc_id = pub_num.replace("/", "_")
        snap = (
            db.collection("users").document(request.uid)
              .collection("portfolios").document(portfolio_id)
              .collection("ai_analysis").document(doc_id).get()
        )
        if not snap.exists:
            return jsonify({"error": "no cached analysis"}), 404
        return jsonify(snap.to_dict())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/api/ai/portfolio-summary", methods=["POST"])
@require_auth
def ai_portfolio_summary():
    """AI portfolio-wide summary: urgent items, patterns, recommendations."""
    try:
        from ai_engine import PatentAI
    except ImportError as exc:
        return jsonify({"error": f"AI engine unavailable: {exc}"}), 500
    try:
        docs = (
            db.collection("users").document(request.uid)
              .collection("portfolios").stream()
        )
        entries = []
        for d in docs:
            entry = d.to_dict() or {}
            entry["id"] = d.id
            entries.append(entry)
        if not entries:
            return jsonify({
                "executive_summary": "Portfolio is empty.",
                "urgent_items": [],
                "portfolio_health": {"total_active": 0, "needs_attention": 0, "on_track": 0},
                "patterns": [],
                "recommendations": [],
            })
        ai     = PatentAI()
        result = ai.analyze_portfolio(entries)
        return jsonify(result)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"Portfolio summary failed: {exc}"}), 500


# ── PDF streamer (per-tile PDF button) ────────────────────────────────────────

def _epo_fullimage_pdf(docdb: str) -> bytes | None:
    """
    Stream the full patent or published-application image from EPO OPS.
    Two-step: (1) GET /images to get an image-link for the PUBLICATION image,
              (2) GET that image-link as PDF.
    Returns PDF bytes, or None on failure.
    """
    import requests as _rq

    epo_key    = os.environ.get("EPO_CONSUMER_KEY",    "").strip()
    epo_secret = os.environ.get("EPO_CONSUMER_SECRET", "").strip()
    if not epo_key or not epo_secret:
        return None
    token = tracker.epo_get_token(epo_key, epo_secret)
    if not token:
        return None

    # 1) Discover the publication-image endpoint + page count
    try:
        info = _rq.get(
            f"https://ops.epo.org/3.2/rest-services/published-data/publication/docdb/{docdb}/images",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/xml"},
            timeout=15,
        )
        if info.status_code != 200:
            print(f"  EPO images lookup HTTP {info.status_code}")
            return None
        import re as _re
        xml = info.text
        # Find the first document-instance whose desc is FullDocument/PublicationImage
        # and capture its link + number-of-pages.
        best = None
        for m in _re.finditer(
            r'<ops:document-instance[^>]*desc="([^"]+)"[^>]*link="([^"]+)"[^>]*number-of-pages="(\d+)"',
            xml, _re.IGNORECASE,
        ):
            desc, link, pages = m.group(1), m.group(2), int(m.group(3))
            if desc.lower() in ("fulldocument", "publicationimage"):
                best = (desc, link, pages)
                break
            if best is None:
                best = (desc, link, pages)
        if not best:
            # Fallback: any link in the response
            link_m = _re.search(r'<ops:document-instance[^>]*link="([^"]+)"[^>]*number-of-pages="(\d+)"', xml)
            if link_m:
                best = ("Any", link_m.group(1), int(link_m.group(2)))
        if not best:
            return None
        _, link, pages = best
    except Exception as exc:
        print(f"  EPO images lookup error: {exc}")
        return None

    # 2) Pull the PDF for "Range=1-N" which returns the consolidated PDF
    try:
        # Link is relative like "published-data/images/US/.../PA/fullimage"
        pdf_url = f"https://ops.epo.org/3.2/rest-services/{link}.pdf?Range=1-{pages}"
        resp = _rq.get(
            pdf_url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/pdf"},
            timeout=60,
        )
        if resp.status_code == 200 and resp.content[:4] == b"%PDF":
            return resp.content
        print(f"  EPO fullimage HTTP {resp.status_code} ({len(resp.content)} bytes)")
    except Exception as exc:
        print(f"  EPO fullimage error: {exc}")
    return None


def _google_patents_pdf(pub_num_clean: str) -> bytes | None:
    """
    Fallback PDF source that works for most jurisdictions (JP, EP, CN, DE, KR, etc.).
    Google Patents embeds a <meta name="citation_pdf_url"> tag on each patent page
    pointing at a publicly hosted PDF on patentimages.storage.googleapis.com.
    We scrape that URL once, then fetch the PDF.
    """
    import re as _re
    import requests as _rq

    clean = _re.sub(r"[^A-Z0-9]", "", (pub_num_clean or "").upper())
    if not clean:
        return None

    headers = {
        "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0 Safari/537.36"),
        "Accept-Language": "en",
    }

    # Candidate URLs — try with and without kind code in case GP normalized it away
    _no_kind = _re.sub(r"[A-Z]+\d*$", "", clean)
    candidates = [
        f"https://patents.google.com/patent/{clean}/en",
        f"https://patents.google.com/patent/{_no_kind}/en",
    ]
    seen = set()
    for page_url in candidates:
        if page_url in seen:
            continue
        seen.add(page_url)
        try:
            page = _rq.get(page_url, headers=headers, timeout=15, allow_redirects=True)
            if page.status_code != 200:
                continue
            m = _re.search(
                r'<meta\s+name="citation_pdf_url"\s+content="([^"]+)"',
                page.text, _re.IGNORECASE,
            )
            if not m:
                continue
            pdf_url = m.group(1)
            resp = _rq.get(pdf_url, headers=headers, timeout=60, allow_redirects=True)
            if resp.status_code == 200 and resp.content[:4] == b"%PDF":
                return resp.content
        except Exception as exc:
            print(f"  Google Patents PDF lookup error for {page_url}: {exc}")
            continue
    return None


def _uspto_pdf(pub_num_clean: str) -> bytes | None:
    """
    Fallback PDF source for US documents via USPTO PatentsView imagewrapper CDN.
    Works for both granted patents and published applications, no auth required.
    """
    import re as _re
    import requests as _rq

    # Strip leading "US" and kind code to get the core digit string.
    core = _re.sub(r"^US", "", pub_num_clean)
    core = _re.sub(r"[A-Z]\d?$", "", core)
    if not core:
        return None

    # USPTO image-server direct PDF download (public, no auth). Pattern works for
    # both granted patents (9-10 digit patent #) and pre-grant publications (11-digit
    # year-prefixed number).
    urls = [
        f"https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/{core}",
        f"https://patentimages.storage.googleapis.com/pdfs/{core}.pdf",  # secondary cache
    ]
    for u in urls:
        try:
            resp = _rq.get(u, timeout=45, allow_redirects=True,
                           headers={"User-Agent": "PatentQ/1.0"})
            if resp.status_code == 200 and resp.content[:4] == b"%PDF":
                return resp.content
        except Exception:
            continue
    return None


@app.route("/api/pdf/<pub_num>", methods=["GET"])
def pdf_proxy(pub_num):
    """
    Stream the granted-patent PDF (for granted) or the published-application PDF
    (for pending) as inline application/pdf.  Input: CC+NUM+KIND style pub number
    like 'US12178560B2' or 'US20260059078A1'.

    Primary source: EPO OPS full-image PDF (needs our consumer key/secret).
    Fallback: USPTO image-server direct download for US documents.
    """
    import re as _re
    from flask import Response

    clean = _re.sub(r"[^A-Z0-9]", "", (pub_num or "").upper())
    if not clean:
        return jsonify({"error": "invalid publication number"}), 400

    docdb = tracker.patent_to_docdb(clean)
    pdf   = _epo_fullimage_pdf(docdb) if docdb else None
    if not pdf and clean.startswith("US"):
        pdf = _uspto_pdf(clean)
    # Google Patents mirror — covers most jurisdictions where EPO OPS full-image
    # isn't available (JP, CN, KR, etc.) and where USPTO doesn't apply.
    if not pdf:
        pdf = _google_patents_pdf(clean)

    if not pdf:
        return jsonify({
            "error": (
                f"No PDF available for {clean}. EPO OPS, USPTO, and Google Patents "
                f"all failed to return a PDF. The document may not have a "
                f"published image yet."
            )
        }), 404

    return Response(
        pdf,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{clean}.pdf"'},
    )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 5001))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
