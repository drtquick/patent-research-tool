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
    key_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_KEY", "").strip()
    if key_path and os.path.exists(key_path):
        cred = credentials.Certificate(key_path)
    else:
        # Fall back to GOOGLE_APPLICATION_CREDENTIALS (set in environment)
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

def _run_search(patent_input: str) -> dict:
    """
    Orchestrate a full tracker search and return all results as a dict.
    Calls tracker.py functions directly — no file writes, no browser opens.
    """
    import requests as _req

    url = tracker.build_url(patent_input)
    try:
        html = tracker.fetch_page(url)
    except _req.HTTPError as exc:
        if exc.response.status_code == 404:
            alt = url.replace("B2/en", "B1/en")
            html = tracker.fetch_page(alt)
            url  = alt
        else:
            raise

    metas  = tracker.get_metas(html)
    family = tracker.parse_family(html)
    claims = tracker.parse_claims(html)

    if not metas.get("citation_patent_number"):
        raise ValueError(f"No patent data found for '{patent_input}'")

    number = tracker._first(metas.get("citation_patent_number", [])) or patent_input
    dates  = metas.get("DC.date", [])

    # Fetch all family member details (slow — one HTTP request per member)
    total          = len(family)
    family_details = [
        tracker.fetch_member_details(m, i + 1, total)
        for i, m in enumerate(family)
    ]

    # EPO OPS enrichment
    epo_only:      list | None = None
    discrepancies: list | None = None
    epo_key    = os.environ.get("EPO_CONSUMER_KEY",    "").strip()
    epo_secret = os.environ.get("EPO_CONSUMER_SECRET", "").strip()
    if epo_key and epo_secret:
        docdb = tracker.patent_to_docdb(patent_input)
        if docdb:
            token = tracker.epo_get_token(epo_key, epo_secret)
            if token:
                xml = tracker.fetch_epo_family(docdb, token)
                if xml:
                    epo_members   = tracker.parse_epo_family(xml)
                    epo_only, discrepancies = tracker.merge_epo_with_google(
                        family_details, epo_members
                    )
    if epo_only is None:
        epo_only, discrepancies = [], []

    dashboard_html = tracker.generate_dashboard_html(
        metas, family_details, url, patent_input, claims,
        epo_only=epo_only or None,
        discrepancies=discrepancies or None,
    )

    # Split contributors into inventors vs assignees (same heuristic as tracker.py)
    contributors = metas.get("DC.contributor", [])
    assignees = [
        c.strip() for c in contributors
        if len(c.strip().split()) >= 3
        or any(kw in c for kw in ("LLC","Inc","Corp","Ltd","Company","Institute","University"))
    ]
    inventors = [c.strip() for c in contributors if c.strip() not in assignees]

    # Compact family summary safe for Firestore (no huge HTML strings)
    family_summary = [
        {
            "pub_num":    m["pub_num"],
            "country":    tracker.country_code(m["pub_num"]),
            "status":     m.get("status", "unknown"),
            "filing_date":m.get("filing_date") or m.get("date") or "",
            "grant_date": m.get("grant_date", ""),
            "app_num":    m.get("app_num", ""),
            "title":      m.get("member_title", ""),
            "href":       m.get("href", ""),
        }
        for m in family_details
    ]

    return {
        "patent_number":     number,
        "title":             (tracker._first(metas.get("DC.title", [])) or "").strip(),
        "filing_date":       dates[0] if dates else "",
        "grant_date":        dates[1] if len(dates) > 1 else "",
        "assignees":         assignees,
        "inventors":         inventors,
        "family_size":       len(family_details),
        "jurisdictions":     len({tracker.country_code(m["pub_num"]) for m in family_details}),
        "granted_count":     sum(1 for m in family_details if m["status"] == "granted"),
        "pending_count":     sum(1 for m in family_details if m["status"] == "pending"),
        "family":            family_summary,
        "epo_only":          epo_only,
        "discrepancies":     discrepancies,
        "dashboard_html":    dashboard_html,
        "google_patents_url":url,
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

    return sorted(deadlines, key=lambda x: x["due_date"])


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/search", methods=["POST"])
@require_auth
def search():
    """
    Run a full patent search.
    Body: { "patent_number": "US 12,178,560" }
    Returns all patent data including dashboard_html.
    Also saves a compact record to the user's search history in Firestore.
    """
    body         = request.get_json(silent=True) or {}
    patent_input = (body.get("patent_number") or "").strip()
    if not patent_input:
        return jsonify({"error": "patent_number is required"}), 400

    try:
        result = _run_search(patent_input)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"Search failed: {exc}"}), 500

    # Save compact record to search history (drop HTML to keep Firestore lean)
    history = {k: v for k, v in result.items() if k != "dashboard_html"}
    history["searched_at"] = datetime.now(timezone.utc)
    history["query"]       = patent_input
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
        return jsonify(entry)
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


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port  = int(os.environ.get("PORT", 5001))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
