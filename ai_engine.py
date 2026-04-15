#!/usr/bin/env python3
"""
PatentQ AI Engine — Claude-powered patent prosecution analysis.

Provides structured AI analysis of patent prosecution histories,
document classification, and portfolio-level intelligence.

All AI interactions go through the PatentAI class, which manages
system prompts, Claude API calls, and response parsing.
"""

import json
import os
import time
from datetime import datetime, timezone
from typing import Optional

import anthropic


# ── System prompts ────────────────────────────────────────────────────────────

SYSTEM_PROMPT_ANALYZE = """You are a patent prosecution analyst assistant working \
for a US patent attorney. You analyze USPTO prosecution histories and provide \
structured, actionable intelligence.

Your role:
- Analyze prosecution events, office actions, and document histories
- Identify required actions and their deadlines
- Assess prosecution risk and strategic considerations
- Provide clear, specific recommendations

Important rules:
- All deadlines are calculated from the mailing date of the relevant document
- Non-final office action response deadline: 3 months (extendable to 6 months)
- Final office action response deadline: 3 months (extendable to 6 months)
- Advisory action deadline: 2 months from final OA
- Notice of Appeal deadline: 63 days from final OA (if no response filed)
- Always note when attorney judgment is especially needed
- Never present analysis as definitive legal advice
- Flag any data gaps that could affect your analysis

You must respond with valid JSON matching the schema described in each request. \
Do not include any text outside the JSON object."""

SYSTEM_PROMPT_PORTFOLIO = """You are a patent portfolio analyst assistant working \
for a US patent attorney. You review multiple patent applications across a \
portfolio and identify what needs attention, prioritized by urgency.

Your role:
- Identify the most urgent action items across the portfolio
- Flag approaching deadlines and overdue items
- Spot patterns (e.g., multiple apps with similar rejection grounds)
- Provide a concise executive summary

Respond with valid JSON matching the schema described in each request. \
Do not include any text outside the JSON object."""


# ── Response schemas (documented for Claude) ──────────────────────────────────

ANALYZE_SCHEMA_INSTRUCTIONS = """
Respond with a JSON object containing these fields:

{
  "status_summary": "2-3 sentence plain-language summary of where this application stands",
  "prosecution_stage": "pre-examination | examination | post-final | appeal | granted | abandoned",
  "action_items": [
    {
      "action": "specific action to take (e.g., 'File response to non-final office action')",
      "deadline": "YYYY-MM-DD or null if no hard deadline",
      "urgency": "critical | urgent | upcoming | informational",
      "details": "1-2 sentences explaining what needs to happen and why",
      "estimated_cost_usd": "range string like '$2,500 - $5,000' or null",
      "requires_attorney_judgment": true/false
    }
  ],
  "risk_assessment": {
    "level": "low | medium | high",
    "factors": ["list of risk factors as strings"]
  },
  "strategic_notes": "optional paragraph with broader strategic observations",
  "data_gaps": ["list of missing information that could improve this analysis"]
}
"""

ANALYZE_OA_SCHEMA_INSTRUCTIONS = """
Respond with a JSON object containing these fields:

{
  "oa_type": "non-final | final | restriction | advisory | other",
  "mailing_date": "YYYY-MM-DD of the office action",
  "response_deadline_short": "YYYY-MM-DD without extension",
  "response_deadline_extended": "YYYY-MM-DD with maximum extension",
  "rejections": [
    {
      "type": "101 | 102 | 103 | 112a | 112b | double_patenting | other",
      "section": "e.g. 35 U.S.C. §103",
      "claims_affected": "e.g. 'Claims 1-5, 8-12' or 'All claims'",
      "summary": "2-3 sentence summary of the rejection ground",
      "key_argument": "the examiner's central argument for this rejection"
    }
  ],
  "cited_prior_art": [
    {
      "reference": "Author/Patent number and title",
      "citation_type": "patent | non-patent-literature",
      "relevance": "1-2 sentence explanation of how examiner applied this reference"
    }
  ],
  "overview": "3-5 sentence plain-language overview of the office action — what the examiner is saying and why",
  "suggested_response_strategies": [
    {
      "strategy": "short title (e.g. 'Amend claims to distinguish over Smith')",
      "details": "2-3 sentences describing the approach",
      "likelihood_of_success": "high | medium | low",
      "requires_attorney_judgment": true/false
    }
  ],
  "attorney_flags": ["things the attorney should pay special attention to"]
}
"""

SYSTEM_PROMPT_ANALYZE_OA = """You are an expert USPTO patent prosecution analyst \
assisting a US patent attorney. You are analyzing the text of a specific \
office action to extract structured information about rejections, cited \
prior art, and prosecution strategy.

Important rules:
- Extract ALL cited prior art references from the office action
- Identify ALL rejection grounds (§101, §102, §103, §112, double patenting, etc.)
- Note which claims are affected by each rejection
- Provide practical response strategy suggestions
- Always flag issues that require attorney judgment
- Never present analysis as definitive legal advice
- If the office action text is unclear or truncated, note that in attorney_flags

You must respond with valid JSON matching the schema described in each request. \
Do not include any text outside the JSON object."""

PORTFOLIO_SCHEMA_INSTRUCTIONS = """
Respond with a JSON object containing these fields:

{
  "executive_summary": "2-3 sentence overview of portfolio health",
  "urgent_items": [
    {
      "patent_number": "the pub_num",
      "title": "short title",
      "action": "what needs to happen",
      "deadline": "YYYY-MM-DD or null",
      "urgency": "critical | urgent | upcoming"
    }
  ],
  "portfolio_health": {
    "total_active": number,
    "needs_attention": number,
    "on_track": number
  },
  "patterns": ["observed patterns across the portfolio"],
  "recommendations": ["1-3 high-level strategic recommendations"]
}
"""


# ── PatentAI class ────────────────────────────────────────────────────────────

class PatentAI:
    """Handles all Claude API interactions for patent analysis."""

    MODEL = "claude-sonnet-4-20250514"
    MAX_TOKENS = 4096

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if not self.api_key:
            raise ValueError("ANTHROPIC_API_KEY is not configured")
        self.client = anthropic.Anthropic(api_key=self.api_key)

    def _call_claude(self, system: str, user_message: str, max_tokens: int = None) -> dict:
        """Send a message to Claude and parse the JSON response."""
        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=max_tokens or self.MAX_TOKENS,
                system=system,
                messages=[{"role": "user", "content": user_message}],
            )
            raw_text = response.content[0].text.strip()
            # Strip markdown code fences if present
            if raw_text.startswith("```"):
                lines = raw_text.split("\n")
                raw_text = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
                raw_text = raw_text.strip()

            result = json.loads(raw_text)
            result["_ai_meta"] = {
                "model": self.MODEL,
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            return result
        except json.JSONDecodeError as e:
            return {
                "error": f"Failed to parse AI response as JSON: {e}",
                "raw_response": raw_text[:2000] if 'raw_text' in dir() else "",
                "_ai_meta": {"model": self.MODEL, "timestamp": datetime.now(timezone.utc).isoformat()},
            }
        except anthropic.APIError as e:
            _msg = str(e)
            _out_of_credits = "credit balance is too low" in _msg.lower() or "insufficient_quota" in _msg.lower()
            return {
                "error": f"Claude API error: {_msg}",
                "out_of_credits": _out_of_credits,
                "_ai_meta": {"model": self.MODEL, "timestamp": datetime.now(timezone.utc).isoformat()},
            }

    # ── Public methods ────────────────────────────────────────────────────────

    def extract_independent_claims_from_pdf(self, pdf_bytes: bytes,
                                            context: Optional[dict] = None) -> list[dict]:
        """
        Ask Claude to read a USPTO patent or claims PDF and return the
        independent claims only (those that don't reference another claim).
        Each claim: { "num": "1", "text": "...full claim text..." }.
        Maintains leading roman/latin numeral, keeps original indentation
        for element steps when possible.
        """
        import base64 as _b64
        if not pdf_bytes:
            return []
        pdf_b64 = _b64.b64encode(pdf_bytes).decode("ascii")

        ctx_hdr = ""
        if context:
            ctx_hdr = (
                f"Document is for US application/patent "
                f"{context.get('pub_num', '')} / app "
                f"{context.get('app_num', '')} "
                f"(status: {context.get('status', '')})."
            )

        schema = """
Return ONE JSON object:
{ "claims": [ { "num": "1", "text": "...verbatim claim text..." }, ... ] }

Rules:
- Extract ONLY independent claims — claims that do NOT begin with "The X of claim N" / "According to claim N" / similar. Skip dependent claims entirely.
- Preserve the claim verbatim. Keep element list formatting as printed (e.g., "(a)", "(b)") when the original uses them. Use \\n where there is a paragraph break.
- If the PDF has multiple versions (as-filed vs amended vs canceled), use the MOST RECENT set. If claims are marked with strike-throughs / underlines, use the clean (amended) text without the markup.
- Omit claims marked CANCELED / CANCELLED / WITHDRAWN.
- If no independent claims are present, return { "claims": [] }.
Output JSON ONLY, no surrounding prose.
"""

        user_blocks = [
            {"type": "document", "source": {"type": "base64",
                                             "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": f"{ctx_hdr}\n\nExtract the independent claims.\n\n{schema}"},
        ]
        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=8000,
                system="You are an expert at reading US patent documents and extracting verbatim claim text. Output JSON only.",
                messages=[{"role": "user", "content": user_blocks}],
            )
            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                lines = raw.split("\n")
                raw = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
                raw = raw.strip()
            data = json.loads(raw)
            claims = data.get("claims") or []
            return [{"num": str(c.get("num", "")).strip(),
                     "text": (c.get("text") or "").strip()} for c in claims]
        except Exception as exc:
            print(f"  extract_independent_claims_from_pdf: {exc}")
            return []

    def summarize_claim_differences(self, claim_sets: list[dict]) -> str:
        """
        Given a list of { identifier, claims: [...] } (one per family member),
        produce a concise comparison paragraph highlighting how the independent
        claims differ across the family — scope breadth, common elements, and
        key distinguishing limitations.
        """
        if not claim_sets:
            return ""
        lines = ["Compare these US patent/application claim sets and produce a short paragraph (3-6 sentences) that:"]
        lines.append("- identifies the common inventive concept,")
        lines.append("- notes the key scope differences across the independent claims,")
        lines.append("- points out any claim set that is materially narrower or broader than the others,")
        lines.append("- avoids legal conclusions; keep it factual and comparative.")
        lines.append("")
        for cs in claim_sets:
            lines.append(f"=== {cs.get('identifier','?')} ===")
            for c in cs.get("claims") or []:
                lines.append(f"Claim {c.get('num','?')}: {c.get('text','')[:1500]}")
            lines.append("")
        user = "\n".join(lines)
        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=800,
                system="You are a patent attorney summarizing claim scope differences. Write one tight paragraph, no headings, no bullet points.",
                messages=[{"role": "user", "content": user}],
            )
            return response.content[0].text.strip()
        except Exception as exc:
            print(f"  summarize_claim_differences: {exc}")
            return ""

    def extract_references_from_pdf(self, pdf_bytes: bytes, doc_type: str = "IDS") -> list[dict]:
        """
        Ask Claude to read a USPTO prior-art PDF (IDS / 1449 / 892 Notice of
        References Cited) and return a structured list of cited references.
        doc_type is informational — it's added to the prompt so Claude knows
        which form conventions to expect.

        Returns a list of dicts:
          { "type": "patent"|"nonpatent",
            "country": "US", "number": "10123456", "kind": "B2",
            "display": "US 10,123,456 B2",
            "cited_by": "applicant"|"examiner",
            "date": "YYYY-MM-DD" or "",
            "text": "raw NPL text" (empty for patents) }
        """
        import base64 as _b64

        if not pdf_bytes:
            return []
        pdf_b64 = _b64.b64encode(pdf_bytes).decode("ascii")

        cited_by = "examiner" if doc_type.upper() in ("892", "NOTICE OF REFERENCES") else "applicant"
        doc_hint = {
            "892":            "USPTO Form 892 (Notice of References Cited by Examiner)",
            "IDS":            "Information Disclosure Statement (SB/08 or similar)",
            "1449":           "PTO-1449 List of References Cited by Applicant",
        }.get(doc_type.upper(), doc_type)

        schema = """
Return a JSON object:
{
  "references": [
    {
      "type":     "patent" | "nonpatent",
      "country":  "US" | "EP" | ... (empty for NPL),
      "number":   "10123456" (patent number as printed, digits only if possible, empty for NPL),
      "kind":     "A1" | "B2" | "" (kind code if printed, else empty),
      "display":  "US 10,123,456 B2" | "Smith et al., Journal X (2019)" (human-readable),
      "date":     "YYYY-MM-DD" (publication/pub date printed next to the reference; empty if not printed),
      "text":     "full citation text" (for NPL; empty for patents)
    }
  ]
}

Rules:
- Parse every row of the reference table(s). Include foreign patents (EP, JP, WO, CN, KR, etc.) and non-patent literature.
- Do not invent entries. If the table is empty, return "references": [].
- Omit signature/date boxes; only the reference rows are of interest.
- Output ONLY the JSON object, no surrounding prose.
"""

        user_blocks = [
            {"type": "document", "source": {"type": "base64",
                                             "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": (
                f"This PDF is a {doc_hint}. Extract every cited prior-art reference.\n\n"
                f"{schema}"
            )},
        ]
        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=4000,
                system="You are an expert at reading USPTO prior-art forms. Extract structured citations faithfully. Output JSON only.",
                messages=[{"role": "user", "content": user_blocks}],
            )
            raw = response.content[0].text.strip()
            if raw.startswith("```"):
                lines = raw.split("\n")
                raw = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
                raw = raw.strip()
            data = json.loads(raw)
            refs = data.get("references") or []
            # Normalize + stamp cited_by
            out = []
            for r in refs:
                r.setdefault("cited_by", cited_by)
                r.setdefault("cited_phase", "ids" if cited_by == "applicant" else "examination")
                # Prettify US patent displays
                if r.get("type") == "patent" and r.get("country") == "US":
                    num = (r.get("number") or "").replace(",", "").strip()
                    kind = r.get("kind", "")
                    if num.isdigit():
                        rev = num[::-1]
                        grouped = ",".join(rev[i:i+3] for i in range(0, len(rev), 3))[::-1]
                        r["display"] = f"US {grouped}{(' ' + kind) if kind else ''}".strip()
                        r["number"]  = num
                out.append(r)
            return out
        except Exception as exc:
            print(f"  extract_references_from_pdf ({doc_type}): {exc}")
            return []


    def analyze_next_deadline(self, member_data: dict) -> dict:
        """
        Determine the single most important upcoming action/deadline for a
        pending US application based on its full file history (ODP events
        + IFW documents). This is the smart deadline that replaces simple
        "last event" heuristics.

        Returns a dict with:
            { "label": str, "date": "YYYY-MM-DD" or "",
              "type":  "response" | "fee" | "other" | "none",
              "confidence": "high" | "medium" | "low",
              "reasoning": str,
              "action_required": bool }
        """
        today = datetime.now().strftime("%Y-%m-%d")
        app_num    = member_data.get("app_num", "")
        pub_num    = member_data.get("pub_num", "")
        status     = member_data.get("status", "unknown")
        filing     = member_data.get("filing_date", "")
        grant      = member_data.get("grant_date", "") or ""
        events     = member_data.get("events", []) or []
        oa_docs    = member_data.get("oa_documents", []) or []

        # Compact context — keep token usage modest
        lines = [
            f"Today: {today}",
            f"Application: {app_num}  Publication: {pub_num}",
            f"Status: {status}   Filed: {filing}   Grant: {grant or 'n/a'}",
            "",
            "Events (chronological, most-recent last):",
        ]
        for ev in events[-40:]:
            lines.append(
                f"  {ev.get('date','')} [{ev.get('code','')}] "
                f"{(ev.get('title') or ev.get('value') or '').strip()}"
            )
        if oa_docs:
            lines.append("")
            lines.append("IFW documents (newest first):")
            for d in oa_docs[:25]:
                lines.append(
                    f"  {d.get('date','')} [{d.get('code','')}] "
                    f"{d.get('description','')}  "
                    f"({d.get('direction','')})"
                )
        context = "\n".join(lines)

        schema = """
Respond with ONE JSON object and nothing else:

{
  "action_required": true | false,
  "label": "short one-line description (e.g. 'Response to Non-Final Office Action due October 15, 2026 (extendable to January 15, 2027)')",
  "date":  "YYYY-MM-DD of the earliest statutory deadline, or empty string if none",
  "type":  "response" | "fee" | "missing_parts" | "appeal" | "other" | "none",
  "confidence": "high" | "medium" | "low",
  "reasoning": "one or two sentences explaining which event triggered this deadline and any key assumptions"
}

Rules:
- Any applicant-facing deadline counts: OA responses, issue-fee payment, missing parts, inventor oath, formal drawings, appeal / reply brief, response to restriction, pre-appeal decision follow-up, Rule 312 amendment windows, etc.
- A later-filed response extinguishes a prior OA deadline — if the applicant has already responded, that OA is not the open deadline.
- Use statutory periods: non-final = 3 months (extendable to 6); final = 3 months (extendable to 6); restriction/missing parts/Quayle = 2 months (extendable to 5 when allowed); issue fee = 3 months non-extendable.
- If the applicant is waiting on the examiner and no applicant action is currently due, set action_required=false and type="none" with label "No response due".
- Only output "No response due" when you're confident no applicant action is outstanding based on the history you've been given.
""".strip()

        user_message = (
            "Analyze this US application's file history and identify the single "
            "most imminent applicant deadline or action.\n\n"
            f"{context}\n\n{schema}"
        )
        return self._call_claude(SYSTEM_PROMPT_ANALYZE, user_message, max_tokens=700)

    def analyze_prosecution(self, member_data: dict, oa_text: Optional[str] = None) -> dict:
        """
        Analyze the prosecution history of a single patent family member.

        Args:
            member_data: Family member dict from Firestore (includes events,
                         oa_documents, status, filing_date, grant_date, etc.)
            oa_text:     Optional extracted text from the most recent office
                         action PDF. If provided, enables deeper rejection analysis.

        Returns:
            Structured analysis dict with action_items, risk_assessment, etc.
        """
        context = self._build_prosecution_context(member_data, oa_text)
        user_message = f"""Analyze this patent application's prosecution history and provide \
your assessment with specific action items.

{context}

{ANALYZE_SCHEMA_INSTRUCTIONS}"""

        return self._call_claude(SYSTEM_PROMPT_ANALYZE, user_message)

    def analyze_portfolio(self, portfolio_entries: list[dict]) -> dict:
        """
        Analyze an entire portfolio and identify what needs attention.

        Args:
            portfolio_entries: List of portfolio entry dicts from Firestore,
                              each containing patent_number, title, family[], etc.

        Returns:
            Portfolio summary with urgent_items, health metrics, recommendations.
        """
        context = self._build_portfolio_context(portfolio_entries)
        user_message = f"""Review this patent portfolio and identify what needs \
the attorney's attention, prioritized by urgency.

{context}

{PORTFOLIO_SCHEMA_INSTRUCTIONS}"""

        return self._call_claude(SYSTEM_PROMPT_PORTFOLIO, user_message)

    def analyze_office_action_pdf(self, member_data: dict, pdf_bytes: bytes,
                                  oa_doc_info: Optional[dict] = None) -> dict:
        """
        Same as analyze_office_action but feeds the PDF directly to Claude via
        the document content block. Used when pypdf can't extract text (scanned
        PDFs, encrypted PDFs, etc.). Claude reads the image pages natively.
        """
        import base64 as _b64
        pdf_b64 = _b64.b64encode(pdf_bytes).decode("ascii")

        header = [
            f"=== Patent Application: {member_data.get('pub_num','Unknown')} ===",
            f"Application Number: {member_data.get('app_num','N/A')}",
            f"Title: {member_data.get('title','') or member_data.get('member_title','')}",
            f"Status: {member_data.get('status','unknown')}",
            f"Filing Date: {member_data.get('filing_date','N/A')}",
        ]
        if oa_doc_info:
            header += [
                f"Office Action Date: {oa_doc_info.get('date','Unknown')}",
                f"Document Type: {oa_doc_info.get('description','Unknown')}",
                f"Document Code: {oa_doc_info.get('code','Unknown')}",
            ]
        header.append(f"Today's date: {datetime.now().strftime('%Y-%m-%d')}")
        ctx = "\n".join(header)

        user_blocks = [
            {
                "type": "document",
                "source": {
                    "type":       "base64",
                    "media_type": "application/pdf",
                    "data":       pdf_b64,
                },
            },
            {
                "type": "text",
                "text": (
                    f"The attached PDF is the referenced office action.\n\n{ctx}\n\n"
                    "Analyze it in detail — extract every rejection, cited prior art "
                    "reference, and response strategy.\n\n"
                    f"{ANALYZE_OA_SCHEMA_INSTRUCTIONS}"
                ),
            },
        ]
        try:
            response = self.client.messages.create(
                model=self.MODEL,
                max_tokens=6000,
                system=SYSTEM_PROMPT_ANALYZE_OA,
                messages=[{"role": "user", "content": user_blocks}],
            )
            raw_text = response.content[0].text.strip()
            if raw_text.startswith("```"):
                lines = raw_text.split("\n")
                raw_text = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
                raw_text = raw_text.strip()
            result = json.loads(raw_text)
            result["_ai_meta"] = {
                "model":         self.MODEL,
                "input_tokens":  response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "source":        "pdf-direct",
                "timestamp":     datetime.now(timezone.utc).isoformat(),
            }
            return result
        except json.JSONDecodeError as e:
            return {"error": f"JSON parse error: {e}",
                    "raw_response": (raw_text[:2000] if 'raw_text' in dir() else "")}
        except anthropic.APIError as e:
            return {"error": f"Claude API error: {e}"}

    def analyze_office_action(self, member_data: dict, oa_text: str,
                              oa_doc_info: Optional[dict] = None) -> dict:
        """
        Deep analysis of a specific office action document.

        Args:
            member_data: Family member dict (pub_num, app_num, status, events, etc.)
            oa_text:     Extracted text of the office action document.
            oa_doc_info: Optional dict with OA metadata (date, code, description).

        Returns:
            Structured OA analysis with rejections, cited art, strategies.
        """
        context_lines = [
            f"=== Patent Application: {member_data.get('pub_num', 'Unknown')} ===",
            f"Application Number: {member_data.get('app_num', 'N/A')}",
            f"Title: {member_data.get('title', '') or member_data.get('member_title', '')}",
            f"Status: {member_data.get('status', 'unknown')}",
            f"Filing Date: {member_data.get('filing_date', 'N/A')}",
            "",
        ]
        if oa_doc_info:
            context_lines.append(f"Office Action Date: {oa_doc_info.get('date', 'Unknown')}")
            context_lines.append(f"Document Type: {oa_doc_info.get('description', 'Unknown')}")
            context_lines.append(f"Document Code: {oa_doc_info.get('code', 'Unknown')}")
            context_lines.append("")

        # Include the full OA text (up to 15k chars for thorough analysis)
        truncated = oa_text[:15000]
        if len(oa_text) > 15000:
            truncated += "\n... [truncated — full document was longer]"
        context_lines.append("=== OFFICE ACTION TEXT ===")
        context_lines.append(truncated)
        context_lines.append("")
        context_lines.append(f"Today's date: {datetime.now().strftime('%Y-%m-%d')}")

        context = "\n".join(context_lines)
        user_message = f"""Analyze this office action in detail. Extract all rejections, \
cited prior art references, and provide response strategy suggestions.

{context}

{ANALYZE_OA_SCHEMA_INSTRUCTIONS}"""

        return self._call_claude(SYSTEM_PROMPT_ANALYZE_OA, user_message, max_tokens=6000)

    # ── Context builders ──────────────────────────────────────────────────────

    def _build_prosecution_context(self, m: dict, oa_text: Optional[str] = None) -> str:
        """Build a structured text block describing a family member's prosecution state."""
        lines = []
        lines.append(f"=== Patent Application: {m.get('pub_num', 'Unknown')} ===")
        lines.append(f"Application Number: {m.get('app_num', 'N/A')}")
        lines.append(f"Title: {m.get('title', '') or m.get('member_title', '')}")
        lines.append(f"Status: {m.get('status', 'unknown')}")
        lines.append(f"Filing Date: {m.get('filing_date', 'N/A')}")
        lines.append(f"Grant Date: {m.get('grant_date', 'N/A') or 'Not granted'}")
        lines.append(f"Country: {m.get('country', 'US')}")
        lines.append("")

        # Prosecution events
        events = m.get("events", [])
        if events:
            lines.append("=== Prosecution Events (chronological) ===")
            for ev in events[-30:]:  # last 30 events to manage context size
                date = ev.get("date", "")
                code = ev.get("code", "")
                title = ev.get("title", "")
                lines.append(f"  {date}  [{code}]  {title}")
            lines.append("")

        # Office action documents from ODP
        oa_docs = m.get("oa_documents", [])
        if oa_docs:
            lines.append("=== IFW Documents (USPTO file wrapper) ===")
            for doc in oa_docs[-25:]:  # last 25 docs
                date = doc.get("date", "")
                code = doc.get("code", "")
                desc = doc.get("description", "")
                direction = doc.get("direction", "")
                pages = doc.get("pages", "")
                lines.append(f"  {date}  [{code}]  {desc}  ({direction}, {pages}p)")
            lines.append("")

        # Rejections
        rejections = m.get("rejections", [])
        if rejections:
            lines.append("=== Rejections on Record ===")
            for r in rejections:
                lines.append(f"  - {r}")
            lines.append("")

        # Office action full text (if extracted)
        if oa_text:
            # Truncate to ~8000 chars to leave room for other context
            truncated = oa_text[:8000]
            if len(oa_text) > 8000:
                truncated += "\n... [truncated]"
            lines.append("=== Most Recent Office Action (extracted text) ===")
            lines.append(truncated)
            lines.append("")

        lines.append(f"Today's date: {datetime.now().strftime('%Y-%m-%d')}")
        return "\n".join(lines)

    def _build_portfolio_context(self, entries: list[dict]) -> str:
        """Build a compact summary of all portfolio entries for portfolio-level analysis."""
        lines = []
        lines.append(f"=== Patent Portfolio ({len(entries)} entries) ===")
        lines.append(f"Analysis date: {datetime.now().strftime('%Y-%m-%d')}")
        lines.append("")

        for entry in entries:
            pnum = entry.get("patent_number", "Unknown")
            title = entry.get("title", "")
            lines.append(f"--- {pnum}: {title} ---")

            family = entry.get("family", [])
            for m in family:
                pub = m.get("pub_num", "")
                cc = m.get("country", "")
                status = m.get("status", "unknown")
                filing = m.get("filing_date", "")
                grant = m.get("grant_date", "")
                ndl = m.get("next_deadline_label", "")
                ndd = m.get("next_deadline_date", "")
                line = f"  {pub} ({cc}) [{status}] filed:{filing}"
                if grant:
                    line += f" granted:{grant}"
                if ndl and ndd:
                    line += f" | DEADLINE: {ndl} by {ndd}"
                lines.append(line)
            lines.append("")

        return "\n".join(lines)
