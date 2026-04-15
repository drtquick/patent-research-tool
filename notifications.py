"""
Email notifications for PatentQ — delivered via MXroute SMTP (465 SSL).

Three public functions:
  send_test_email(to)           → sends a plain "you're set up" email
  build_and_send_digest(uid)    → runs deadline query for that user and emails them
  scan_and_send_event_alerts()  → diff-based: compares today's family data to the
                                  last-sent snapshot per tracked family member and
                                  emails an immediate alert on new OA / NOA /
                                  status-change-to-abandoned events.

All SMTP config comes from env (populated from Secret Manager in Cloud Run):
  MX_SMTP_HOST, MX_SMTP_PORT, MX_SMTP_USER, MX_SMTP_PASS, MX_SMTP_FROM
"""

from __future__ import annotations

import html as _html
import os
import smtplib
import ssl
from datetime import date, datetime, timezone, timedelta
from email.message import EmailMessage
from email.utils import formataddr
from typing import Iterable


# ── SMTP primitive ───────────────────────────────────────────────────────────

def _smtp_config() -> dict | None:
    host = os.environ.get("MX_SMTP_HOST", "").strip()
    user = os.environ.get("MX_SMTP_USER", "").strip()
    pw   = os.environ.get("MX_SMTP_PASS", "").strip()
    if not (host and user and pw):
        return None
    port = int(os.environ.get("MX_SMTP_PORT", "465") or "465")
    frm  = os.environ.get("MX_SMTP_FROM", user).strip() or user
    return {"host": host, "port": port, "user": user, "pass": pw, "from": frm}


def send_email(to: str, subject: str, html_body: str,
               text_body: str | None = None, cc: list[str] | None = None) -> None:
    """Raise on failure so callers can log."""
    cfg = _smtp_config()
    if not cfg:
        raise RuntimeError("MX_SMTP_* env vars not configured")

    msg = EmailMessage()
    msg["From"]    = formataddr(("PatentQ Alerts", cfg["from"]))
    msg["To"]      = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg.set_content(text_body or _html_to_text(html_body))
    msg.add_alternative(html_body, subtype="html")

    ctx = ssl.create_default_context()
    if cfg["port"] == 465:
        with smtplib.SMTP_SSL(cfg["host"], cfg["port"], context=ctx, timeout=25) as srv:
            srv.login(cfg["user"], cfg["pass"])
            srv.send_message(msg)
    else:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=25) as srv:
            srv.ehlo()
            srv.starttls(context=ctx)
            srv.ehlo()
            srv.login(cfg["user"], cfg["pass"])
            srv.send_message(msg)


def _html_to_text(h: str) -> str:
    import re as _re
    t = _re.sub(r"<br\s*/?>", "\n", h or "")
    t = _re.sub(r"</?p[^>]*>", "\n\n", t)
    t = _re.sub(r"</?li[^>]*>", "\n", t)
    t = _re.sub(r"<[^>]+>", "", t)
    return _re.sub(r"\n{3,}", "\n\n", t).strip()


# ── Digest builders ──────────────────────────────────────────────────────────

def _fmt_days(delta: int) -> tuple[str, str]:
    if delta < 0:  return (f"{-delta}d late", "#c62828")
    if delta <= 7: return (f"{delta}d",        "#c62828")
    if delta <= 30:return (f"{delta}d",        "#e65100")
    if delta <= 60:return (f"{delta}d",        "#c2410c")
    return (f"{delta}d", "#1565c0")


def _render_digest_html(user_email: str, kind: str, deadlines: list[dict],
                         portfolio_link: str) -> str:
    today = date.today().isoformat()
    title = "Daily" if kind == "daily" else "Weekly"
    rows_html = []
    for d in deadlines:
        pill, color = _fmt_days(d.get("days_out", 0))
        rows_html.append(
            f'<tr>'
            f'  <td style="padding:6px 10px;border-bottom:1px solid #eee;'
            f'     white-space:nowrap;color:{color};font-weight:700">{pill}</td>'
            f'  <td style="padding:6px 10px;border-bottom:1px solid #eee;'
            f'     white-space:nowrap;font-family:monospace;color:#555">{_html.escape(d.get("due_date",""))}</td>'
            f'  <td style="padding:6px 10px;border-bottom:1px solid #eee;'
            f'     white-space:nowrap;color:#777">{_html.escape(d.get("country",""))}</td>'
            f'  <td style="padding:6px 10px;border-bottom:1px solid #eee;'
            f'     color:#1a73e8;font-weight:600">{_html.escape(d.get("pub_num",""))}</td>'
            f'  <td style="padding:6px 10px;border-bottom:1px solid #eee">{_html.escape(d.get("label",""))}</td>'
            f'</tr>'
        )
    table = "".join(rows_html) or (
        '<tr><td colspan="5" style="padding:20px;text-align:center;color:#888;'
        'font-style:italic">No upcoming deadlines in this window.</td></tr>'
    )
    return f"""<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#1a1a2e">
<h2 style="color:#1a73e8;margin:0 0 6px">PatentQ — {title} Digest</h2>
<p style="color:#666;margin:0 0 18px">Generated {today} for {_html.escape(user_email)}</p>
<p style="margin:0 0 10px"><strong>{len(deadlines)}</strong> upcoming deadline{'' if len(deadlines)==1 else 's'}:</p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
<thead><tr style="background:#f8f9fa;color:#555">
  <th style="text-align:left;padding:8px 10px">When</th>
  <th style="text-align:left;padding:8px 10px">Due</th>
  <th style="text-align:left;padding:8px 10px">Country</th>
  <th style="text-align:left;padding:8px 10px">Pub</th>
  <th style="text-align:left;padding:8px 10px">Action</th>
</tr></thead>
<tbody>{table}</tbody></table>
<p style="margin-top:22px;font-size:12px;color:#888">
  <a href="{_html.escape(portfolio_link)}" style="color:#1a73e8">Open your portfolio</a> ·
  <a href="{_html.escape(portfolio_link.rsplit('/',1)[0])}/settings" style="color:#1a73e8">Notification settings</a>
</p>
</body></html>"""


def collect_user_deadlines(db, uid: str, days_ahead: int) -> list[dict]:
    """Aggregate every upcoming deadline across the user's portfolios,
    using the existing _compute_deadlines helper in app.py via callback."""
    from app import _compute_deadlines
    today = date.today()
    end   = today + timedelta(days=days_ahead)
    out: list[dict] = []
    docs = (
        db.collection("users").document(uid)
          .collection("portfolios").stream()
    )
    for doc in docs:
        fam = doc.to_dict() or {}
        fam["id"] = doc.id
        try:
            for d in _compute_deadlines(fam):
                dt = d.get("due_date") or ""
                try:
                    dd = date.fromisoformat(dt[:10])
                except Exception:
                    continue
                if today - timedelta(days=7) <= dd <= end:
                    d["days_out"] = (dd - today).days
                    out.append(d)
        except Exception:
            pass
    return sorted(out, key=lambda d: d.get("due_date", ""))


def send_digest(db, uid: str, kind: str = "daily",
                portfolio_link: str = "https://patent-research-tool.web.app/portfolio") -> dict:
    """Send a digest email. kind is 'daily' (next 30 days) or 'weekly' (next 90)."""
    from firebase_admin import auth as _fb_auth
    u = _fb_auth.get_user(uid)
    email = u.email or ""
    if not email:
        return {"sent": False, "reason": "no_email"}

    # Check per-user settings
    try:
        prefs_snap = db.collection("users").document(uid).collection("settings").document("notifications").get()
        prefs = prefs_snap.to_dict() if prefs_snap.exists else {}
    except Exception:
        prefs = {}
    if not prefs.get("enabled", True):
        return {"sent": False, "reason": "disabled"}
    kind_key = "daily_digest" if kind == "daily" else "weekly_digest"
    if prefs.get(kind_key, True) is False:
        return {"sent": False, "reason": f"{kind}_disabled"}

    days = 30 if kind == "daily" else 90
    deadlines = collect_user_deadlines(db, uid, days)
    if not deadlines and prefs.get("skip_empty", True):
        return {"sent": False, "reason": "no_deadlines"}

    to = prefs.get("recipient_email") or email
    html = _render_digest_html(email, kind, deadlines, portfolio_link)
    subj = f"PatentQ {'Daily' if kind == 'daily' else 'Weekly'} Digest · {len(deadlines)} upcoming"
    send_email(to, subj, html)
    return {"sent": True, "count": len(deadlines), "to": to}


# ── Event-based alerts ───────────────────────────────────────────────────────

_WATCH_EVENTS = {
    "CTNF": "Non-Final Office Action mailed",
    "CTFR": "Final Rejection mailed",
    "MCTNF": "Non-Final Office Action (misc) mailed",
    "MCTFR": "Final Rejection (misc) mailed",
    "N417": "",  # skip
    "NOA":  "Notice of Allowance mailed",
    "NOA.":  "Notice of Allowance mailed",
}
_NOA_TITLES   = ("NOTICE OF ALLOWANCE",)


def _render_event_alert(event: dict, portfolio_link: str) -> str:
    pill_text = event.get("code", "EVENT")
    pill_bg   = "#c62828" if event.get("kind") == "oa" else "#2e7d32"
    return f"""<!doctype html><html><body style="font-family:-apple-system,sans-serif;max-width:660px;margin:0 auto;padding:20px;color:#1a1a2e">
<div style="display:inline-block;background:{pill_bg};color:#fff;padding:4px 10px;border-radius:12px;font-weight:700;font-size:12px">{_html.escape(pill_text)}</div>
<h2 style="color:#1a1a2e;margin:10px 0 4px">{_html.escape(event.get('title','Patent event'))}</h2>
<p style="color:#666;margin:0 0 16px">{_html.escape(event.get('subtitle',''))}</p>
<table style="font-size:13px;line-height:1.6">
  <tr><td style="color:#666">Family:</td><td style="font-weight:600">{_html.escape(event.get('family',''))}</td></tr>
  <tr><td style="color:#666">Application:</td><td>{_html.escape(event.get('app_num',''))}</td></tr>
  <tr><td style="color:#666">Publication:</td><td>{_html.escape(event.get('pub_num',''))}</td></tr>
  <tr><td style="color:#666">Event date:</td><td>{_html.escape(event.get('event_date',''))}</td></tr>
</table>
<p style="margin-top:22px"><a href="{_html.escape(portfolio_link)}" style="background:#1a73e8;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Open dashboard</a></p>
</body></html>"""


def scan_events_for_user(db, uid: str,
                         portfolio_link: str = "https://patent-research-tool.web.app/portfolio") -> dict:
    """
    Check the user's portfolios against last-seen event cache and send a
    separate alert email per new event. Diff state lives at
    users/{uid}/notif_event_cache/{app_num}.
    """
    from firebase_admin import auth as _fb_auth
    u = _fb_auth.get_user(uid)
    email = u.email or ""
    if not email:
        return {"sent": 0, "reason": "no_email"}

    try:
        prefs_snap = db.collection("users").document(uid).collection("settings").document("notifications").get()
        prefs = prefs_snap.to_dict() if prefs_snap.exists else {}
    except Exception:
        prefs = {}
    if not prefs.get("enabled", True):
        return {"sent": 0, "reason": "disabled"}
    if prefs.get("event_alerts", True) is False:
        return {"sent": 0, "reason": "event_alerts_disabled"}
    to = prefs.get("recipient_email") or email

    sent = 0
    portfolios = db.collection("users").document(uid).collection("portfolios").stream()
    for doc in portfolios:
        fam = doc.to_dict() or {}
        family_label = fam.get("patent_number") or fam.get("family_name") or doc.id
        for m in (fam.get("family") or []):
            app_raw = (m.get("app_num") or "").strip()
            pub = m.get("pub_num") or ""
            if not app_raw:
                continue
            # Firestore document ids can't contain '/' — sanitize before use.
            app = app_raw.replace("/", "_").replace("\\", "_")
            if not app:
                continue
            cache_ref = db.collection("users").document(uid) \
                          .collection("notif_event_cache").document(app)
            try:
                prev = cache_ref.get().to_dict() or {}
            except Exception:
                prev = {}

            # Detect triggers
            prev_status = prev.get("status")
            prev_last_event = prev.get("last_event_key", "")
            cur_status = m.get("status", "unknown")
            cur_events = m.get("events", []) or []
            # Guard against missing events (summary may omit them)
            if not cur_events:
                continue
            cur_last = cur_events[-1]
            cur_key = f"{cur_last.get('date','')}::{cur_last.get('code','')}::{(cur_last.get('title') or '')[:80]}"

            # 1) New OA
            oa_codes = ("CTNF", "CTFR", "MCTNF", "MCTFR")
            if cur_key != prev_last_event:
                code = (cur_last.get("code") or "").upper()
                if code in oa_codes:
                    _send_event(to, {
                        "kind":       "oa",
                        "title":      f"New {cur_last.get('title','Office Action')}",
                        "subtitle":   f"{family_label} · {pub}",
                        "code":       code,
                        "family":     family_label,
                        "app_num":    app,
                        "pub_num":    pub,
                        "event_date": cur_last.get("date", ""),
                    }, portfolio_link)
                    sent += 1
                # 2) Notice of Allowance
                title_up = (cur_last.get("title") or "").upper()
                if any(t in title_up for t in _NOA_TITLES):
                    _send_event(to, {
                        "kind":       "noa",
                        "title":      "Notice of Allowance mailed",
                        "subtitle":   f"Issue fee due soon · {family_label}",
                        "code":       "NOA",
                        "family":     family_label,
                        "app_num":    app,
                        "pub_num":    pub,
                        "event_date": cur_last.get("date", ""),
                    }, portfolio_link)
                    sent += 1

            # 3) Status → abandoned
            if prev_status and prev_status != "abandoned" and cur_status == "abandoned":
                _send_event(to, {
                    "kind":       "abandoned",
                    "title":      "Status changed to Abandoned",
                    "subtitle":   f"{family_label} · {pub}",
                    "code":       "ABN",
                    "family":     family_label,
                    "app_num":    app,
                    "pub_num":    pub,
                    "event_date": cur_last.get("date", ""),
                }, portfolio_link)
                sent += 1

            # Save new state
            try:
                cache_ref.set({
                    "status":          cur_status,
                    "last_event_key":  cur_key,
                    "updated_at":      datetime.now(timezone.utc),
                })
            except Exception:
                pass

    return {"sent": sent}


def _send_event(to: str, event: dict, portfolio_link: str) -> None:
    html = _render_event_alert(event, portfolio_link)
    subj = f"PatentQ · {event.get('title','Event')} — {event.get('family','')}"
    send_email(to, subj, html)
