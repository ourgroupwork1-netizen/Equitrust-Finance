---
name: Equitrust fraud screening
description: AI-provider availability and safety rules for the finance prototype's fraud screening.
---

OpenAI-assisted review uses the API key stored as a Replit Secret and is available only through the administrator scan. The member-facing scan remains rules-based. AI requests contain only temporary account references and transaction type, amount, approximate age, and prior review status—not names, emails, descriptions, account IDs, or transaction references. OpenAI API usage may incur charges.

**Why:** Member-triggered requests could create costs for the key owner, and account identifiers are not needed to evaluate transaction patterns. Fraud indicators are not proof and must not trigger automatic blocks or lending decisions.

**How to apply:** Keep the API key server-only, AI scans explicit and administrator-only, transaction input minimized, and errors explicit rather than silently falling back. Preserve human review for all account and loan actions.