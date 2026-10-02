---
name: Equitrust fraud screening
description: AI-provider availability and safety rules for the finance prototype's fraud screening.
---

OpenAI integration provisioning returned an account-upgrade requirement. The current fraud screen is a transparent, rules-based anomaly detector, not an AI model.

**Why:** Calling the fallback AI would mislead members; fraud indicators must not trigger automatic account blocks or lending decisions.

**How to apply:** Keep the UI and API method/disclaimer explicit about rules-based screening and human review. Add a model-backed path only after an AI provider is enabled, and keep account and loan actions under human control.