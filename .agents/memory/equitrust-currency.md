---
name: Equitrust currency
description: The currency denomination for the Equitrust Finance prototype.
---

The user specified that transactions should be in Leones, not dollars. Use Sierra Leonean Leone (SLE) consistently and treat existing cent-based stored amounts as Leone minor units unless the user requests conversion.

**Why:** The prototype should reflect its intended local currency, and no exchange-rate conversion was requested.

**How to apply:** Keep balances, transactions, loans, and receipts in SLE; do not silently convert existing simulated amounts.