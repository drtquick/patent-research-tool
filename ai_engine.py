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
            return {
                "error": f"Claude API error: {e}",
                "_ai_meta": {"model": self.MODEL, "timestamp": datetime.now(timezone.utc).isoformat()},
            }

    # ── Public methods ────────────────────────────────────────────────────────

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
