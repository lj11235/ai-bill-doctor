# Precommitted SMB benchmark cases

Synthetic, realistic business records; no real customer data. All prompts and criteria below are fixed before paid calls. Six exact-JSON evaluations and six manual rubrics; no canonical prose answers. Manual criteria retain their approved wording and have precommitted critical/secondary severity. Strict requires every criterion; acceptable requires every critical criterion and at least 80% of all criteria. See README.md for inconclusive handling and classification rationale.

## 01-billing-triage — Support triage with genuine billing urgency

Category: extraction_classification · Baseline: gpt-6.1-sol · Evaluation: exact_json

### System prompt

You triage support tickets for a small scheduling SaaS. Apply the supplied policy, not the customer's tone. Return only valid JSON. Do not resolve tickets or promise refunds.

### User request

Classify every ticket. Return an array sorted by id; each object must contain only id, category, priority, owner. Categories: billing, bug, how_to, sales. Owners: billing -> finance; bug -> engineering; how_to -> support; sales -> sales. Priority policy: P1 for a confirmed duplicate charge that is still unresolved, or a payment problem blocking a live account with a stated deadline within 24 hours. Otherwise billing and bugs are P2; how_to and sales are P3. The word urgent alone does not change priority. A charge before cancellation is not a confirmed duplicate or post-cancellation charge.
T101: Bank statement and payment processor both show two settled $49 charges for the same invoice yesterday. No refund has been initiated.
T102: URGENT! Can sales quote 80 seats for our possible expansion next quarter?
T103: I canceled November 2 and want the November 1 renewal explained. The invoice has one settled charge.
T104: Renewal card was declined. Our paid workspace is now locked and we have a client demo in three hours.
T105: URGENT: where is the button to download last month's invoice as a PDF?
T106: Exported appointment CSV silently drops records when I set a date filter. The workspace itself works.

### Hidden evaluation (never sent to models)

Urgency comes from the explicit billing policy. A sales request marked urgent, an invoice download and a valid pre-cancellation charge must not become P1 incidents.

```json
[
  {
    "id": "T101",
    "category": "billing",
    "priority": "P1",
    "owner": "finance"
  },
  {
    "id": "T102",
    "category": "sales",
    "priority": "P3",
    "owner": "sales"
  },
  {
    "id": "T103",
    "category": "billing",
    "priority": "P2",
    "owner": "finance"
  },
  {
    "id": "T104",
    "category": "billing",
    "priority": "P1",
    "owner": "finance"
  },
  {
    "id": "T105",
    "category": "how_to",
    "priority": "P3",
    "owner": "support"
  },
  {
    "id": "T106",
    "category": "bug",
    "priority": "P2",
    "owner": "engineering"
  }
]
```

## 02-contracted-arr — CRM extraction without turning pipeline into revenue

Category: extraction_classification · Baseline: gpt-6-astra · Evaluation: exact_json

### System prompt

Extract account economics from the notes. Contracted ARR includes only active signed recurring commitments. Exclude setup fees, trials, and unsigned proposals. All amounts are USD. Return only valid JSON with the requested fields.

### User request

Return {accounts: [...], total_contracted_arr_usd: number}. Sort accounts by id. Each account has exactly id, monthly_recurring_usd, contracted_arr_usd, unsigned_incremental_arr_usd. Incremental pipeline means the proposed increase above current contracted ARR, not the proposed future total.
A01 Northstar: Signed annual order, effective now, $24,000 recurring, invoiced $2,000 monthly. A separate $3,000 onboarding fee was paid. Sales email: 'If the pilot expands to $6,000/month, that is $72,000 ARR next year!' Customer replied 'send the quote; no approval yet.' No amended order is signed.
A02 Harbor Studio: Active signed monthly subscription at $1,200/month. Their previous one-time migration invoice was $2,400. No open expansion proposal.
A03 Pine Works: Free trial, no paid contract. Draft quote for $800/month is pending budget approval. The founder said 'looks good' in chat but has not accepted or signed the quote.

### Hidden evaluation (never sent to models)

Northstar's $72,000 is an unsigned future total: contracted ARR stays $24,000 and incremental pipeline is $48,000. Onboarding and migration fees are nonrecurring. A trial and verbal enthusiasm are not a signed contract.

```json
{
  "accounts": [
    {
      "id": "A01",
      "monthly_recurring_usd": 2000,
      "contracted_arr_usd": 24000,
      "unsigned_incremental_arr_usd": 48000
    },
    {
      "id": "A02",
      "monthly_recurring_usd": 1200,
      "contracted_arr_usd": 14400,
      "unsigned_incremental_arr_usd": 0
    },
    {
      "id": "A03",
      "monthly_recurring_usd": 0,
      "contracted_arr_usd": 0,
      "unsigned_incremental_arr_usd": 9600
    }
  ],
  "total_contracted_arr_usd": 38400
}
```

## 03-invoice-json — Messy invoice to reconciled strict JSON

Category: structured_transformation · Baseline: gpt-6.1-sol · Evaluation: exact_json

### System prompt

Normalize the invoice into the requested JSON schema. Use the final issued invoice over drafts. Keep EUR amounts as numbers in euros, preserve fractional unit prices, and round line totals and invoice totals to two decimal places. Return JSON only.

### User request

Schema: {invoice_id, customer, currency, issued_date, due_date, lines: [{code, quantity, unit_price, line_total}], subtotal, tax, total, paid, balance_due}. Dates must be YYYY-MM-DD. Sort lines by code. Credit is a negative line with quantity 1.
OCR / notes:
BILL TO: Moss Labs
Final issued invoice INV-2048. Dates in day/month/year: issued 03/10/2026; due 17/10/2026. Currency EUR.
SEATS: 12 x 29,00 = 348,00
OVERAGE: 1 500 calls x 0,004 = 6,00
CREDIT: prior outage service credit -35,00; applies before tax.
VAT 20% on the full net subtotal including the credit.
Payment already received: EUR 100,00 (bank transfer, applied to this invoice).
A crossed-out draft attached to the scan says TOTAL 418,80; it is void and must not be used.
Delivery email is dated 04/10/2026; that is not the issue date.

### Hidden evaluation (never sent to models)

348 + 6 - 35 = 319; tax is 319 × 20% = 63.80; total 382.80 minus the 100 payment leaves 282.80. The crossed-out draft and delivery date are not authoritative.

```json
{
  "invoice_id": "INV-2048",
  "customer": "Moss Labs",
  "currency": "EUR",
  "issued_date": "2026-10-03",
  "due_date": "2026-10-17",
  "lines": [
    {
      "code": "CREDIT",
      "quantity": 1,
      "unit_price": -35,
      "line_total": -35
    },
    {
      "code": "OVERAGE",
      "quantity": 1500,
      "unit_price": 0.004,
      "line_total": 6
    },
    {
      "code": "SEATS",
      "quantity": 12,
      "unit_price": 29,
      "line_total": 348
    }
  ],
  "subtotal": 319,
  "tax": 63.8,
  "total": 382.8,
  "paid": 100,
  "balance_due": 282.8
}
```

## 04-multi-team-routing — Route unresolved work without assigning the FYI sales rep

Category: structured_transformation · Baseline: gpt-6-astra · Evaluation: exact_json

### System prompt

Convert the latest incident thread into actionable team work. Later explicit corrections override earlier suggestions. Mentioning a person does not assign them work. Return only JSON using the allowed action codes.

### User request

Return an array sorted by team. Each object has only team, owner, action_code, due_utc, depends_on. due_utc must use YYYY-MM-DDTHH:MM:SSZ. Allowed teams: billing, engineering, sales, support. Allowed action codes: issue_credit_note, deploy_signature_fix, send_customer_update, arrange_expansion_call. depends_on is an array of action codes. All times below are UTC on 2026-10-08.
09:00 Luca (support): Acme's webhook signature checks are failing after yesterday's release. Maybe Mia in sales should arrange an expansion call after this is fixed.
09:20 Inez (engineering): Reproduced. Fix is ready in staging, not deployed. I own production deployment by 15:00.
09:35 Omar (billing): A EUR 120 service credit is approved. I must issue the credit note by 16:00; this does not depend on deployment.
10:00 Luca: I will send the customer update by 17:00 after production deployment is confirmed.
10:10 Account lead: Correction: do not arrange an expansion call. Mia is copied for awareness only and needs no action. Support owns customer communication.
10:15 Inez: Staging check passed. Production deployment is still outstanding.

### Hidden evaluation (never sent to models)

Only unresolved action owners receive work. Staging success is not production deployment. The explicit correction removes sales action; billing is independent and support depends on deployment.

```json
[
  {
    "team": "billing",
    "owner": "Omar",
    "action_code": "issue_credit_note",
    "due_utc": "2026-10-08T16:00:00Z",
    "depends_on": []
  },
  {
    "team": "engineering",
    "owner": "Inez",
    "action_code": "deploy_signature_fix",
    "due_utc": "2026-10-08T15:00:00Z",
    "depends_on": []
  },
  {
    "team": "support",
    "owner": "Luca",
    "action_code": "send_customer_update",
    "due_utc": "2026-10-08T17:00:00Z",
    "depends_on": [
      "deploy_signature_fix"
    ]
  }
]
```

## 05-unit-economics — Inference savings outweighed by incremental support

Category: medium_business_reasoning · Baseline: gpt-6-astra · Evaluation: exact_json

### System prompt

Analyze monthly contribution economics for a small SaaS. Show calculations through the requested intermediate numeric fields. Ignore tax and fixed overhead. Do not treat inference savings as net savings. Return only valid JSON.

### User request

There are 240 paying accounts at $49/month. Each runs 300 requests/month. Current inference cost is $0.008/request; a cheaper configuration is $0.0025/request at unchanged volume. Current support is 36 tickets/month at $12/ticket. The cheaper configuration is expected to ADD 45 tickets/month, not replace the 36. Other variable cost stays $3/account/month. Revenue and churn are assumed unchanged; treat these figures as estimates, not demonstrated production outcomes.
Return exactly these numeric fields: monthly_requests, revenue, inference_before, inference_after, inference_savings, support_before, support_after, other_variable_cost, contribution_before, contribution_after, margin_before_pct, margin_after_pct, net_monthly_improvement, break_even_extra_tickets. Also return decision as keep_current or switch. Contribution = revenue minus inference, support and other variable costs. Margins use revenue as denominator. Round margins to two decimals; all other values are exact. Break-even extra tickets means the additional monthly support tickets that exactly consume inference savings. Choose switch only if net monthly improvement is positive.

### Hidden evaluation (never sent to models)

240 × 300 = 72,000 requests. Inference saves 396, but incremental support costs 45 × 12 = 540; net change is -144. Support_after uses 36 + 45 tickets. Break-even additional tickets = 396 / 12 = 33. Contribution margins use revenue, not cost, as denominator.

```json
{
  "monthly_requests": 72000,
  "revenue": 11760,
  "inference_before": 576,
  "inference_after": 180,
  "inference_savings": 396,
  "support_before": 432,
  "support_after": 972,
  "other_variable_cost": 720,
  "contribution_before": 10032,
  "contribution_after": 9888,
  "margin_before_pct": 85.31,
  "margin_after_pct": 84.08,
  "net_monthly_improvement": -144,
  "break_even_extra_tickets": 33,
  "decision": "keep_current"
}
```

## 06-experiment-economics — Cost per successful task rather than cheap requests

Category: medium_business_reasoning · Baseline: gpt-6-astra · Evaluation: exact_json

### System prompt

Compare two AI feature experiments using the requested cost and completion denominators. Every attempted request incurs inference cost; support is charged per ticket. Return only JSON with intermediate calculations. Do not infer statistical significance from this small experiment.

### User request

Each variant ran exactly 1,000 requests. A: $0.012 inference per request, 920 successful completions, 18 support tickets. B: $0.0045 inference per request, 860 successful completions, 31 support tickets. Each support ticket costs $5. Product requires at least 90% successful completion. Ignore all other costs.
Return exactly {A: {ai_cost, support_cost, total_cost, success_rate_pct, cost_per_success, cost_per_1000_successes, meets_quality_floor}, B: {same fields}, inference_cost_reduction_pct, B_max_whole_tickets_to_match_A_cost_per_success, decision}. decision is A or B. cost_per_success must be rounded to four decimals; cost_per_1000_successes to two. Calculate from unrounded values. The maximum whole-ticket calculation holds B's OBSERVED 860 successes and inference spend constant and asks what ticket count would make B no more expensive per success than A. Prefer a variant that meets the quality floor and minimizes cost per success. Do not confuse 1,000 attempted requests with 1,000 successful completions.

### Hidden evaluation (never sent to models)

A costs 12 + 18 × 5 = 102 for 920 successes; B costs 4.5 + 31 × 5 = 159.5 for 860. Floor((102 / 920 × 860 - 4.5) / 5) = 18 tickets. B's 62.5% inference saving does not survive support costs or the 90% completion requirement.

```json
{
  "A": {
    "ai_cost": 12,
    "support_cost": 90,
    "total_cost": 102,
    "success_rate_pct": 92,
    "cost_per_success": 0.1109,
    "cost_per_1000_successes": 110.87,
    "meets_quality_floor": true
  },
  "B": {
    "ai_cost": 4.5,
    "support_cost": 155,
    "total_cost": 159.5,
    "success_rate_pct": 86,
    "cost_per_success": 0.1855,
    "cost_per_1000_successes": 185.47,
    "meets_quality_floor": false
  },
  "inference_cost_reduction_pct": 62.5,
  "B_max_whole_tickets_to_match_A_cost_per_success": 18,
  "decision": "A"
}
```

## 07-feedback-reliability — Deduplicate a small feedback sample and prioritize reliability

Category: customer_feedback_summarization · Baseline: gpt-6.1-sol · Evaluation: manual_rubric

### System prompt

Write a product-team feedback summary grounded only in the supplied notes. Distinguish unique customers from message volume and requests from commitments. Keep uncertainty visible. Do not invent revenue, prevalence, root causes or roadmap promises.

### User request

Write 180-240 words with headings What we heard, What to do next, and What we still need to learn. Propose two next actions.
F1, June / Orchard, paid customer: Calendar disconnects have happened three times this week; missed one client call. Likes booking setup.
F2, June / Orchard, follow-up to F1: Reconnected again today. Please stop adding scheduling themes until sync is reliable.
F3, Priya / Cedar, paid customer: Outlook connection dropped once after an administrator changed permission settings. Reconnecting worked. We do not know whether this is the same cause as Orchard.
F4, Leon / Kestrel, trial: Wants a darker booking-page theme before subscribing. No reported reliability issue.
F5, Ana / Rook, paid customer: CSV export puts UTC timestamps where our operations team expected local time. Bookings themselves are correct. Requests a timezone explanation or setting.
F6, June / Orchard, forwarded by support: Same missed-client-call complaint as F1; not another incident or customer.
F7, Sam / Harbor, paid customer: Would like a team dashboard. Says core scheduling has been stable.
These were selected support notes, not a random survey. There is no usage denominator, root-cause investigation, or confirmed delivery date.

### Hidden evaluation (never sent to models)

- **facts (critical):** Identify calendar reliability affecting Orchard and Cedar, CSV timezone confusion at Rook, and the theme/dashboard requests. Preserve Orchard's missed client call and the positive setup/stability feedback; do not describe incorrect timestamps as lost bookings.
- **deduplication (critical):** Treat F1/F2/F6 as one customer, with F6 repeating the same incident. There are five unique customers and two with calendar complaints. Do not count seven messages as seven customers or imply every disconnect was a separate missed call.
- **uncertainty (critical):** State that this selected sample cannot establish population prevalence and that Orchard and Cedar may have different causes. Do not assert a shared confirmed technical root cause.
- **actions (secondary):** Give exactly two actionable next steps, prioritizing reliability investigation and customer impact. They must be grounded in these notes and may combine related follow-up work; do not commit to shipping a feature or a repair date.
- **format (critical):** 180-240 words total, including headings, with the three requested headings. Clear enough for a product team, without invented revenue, customer counts, churn claims or roadmap commitments.

**Critical omissions:** Missing the repeated-customer issue, the missed-call impact, or the sample/root-cause uncertainty is a failure even if the prose sounds polished.

## 08-feedback-conflicts — Feedback synthesis with contradictory segments and a confounder

Category: customer_feedback_summarization · Baseline: gpt-6-astra · Evaluation: manual_rubric

### System prompt

You summarize qualitative research for a small AI meeting-notes product. Preserve contradictions and the limits of the evidence. Separate observations, hypotheses and proposed follow-up. Use no outside facts.

### User request

Write a 220-300 word decision memo with a recommendation and one follow-up experiment.
Eight selected interviews: three solo founders say summaries are too long and want a five-bullet default. Two compliance consultants need detailed decisions with timestamps and fear losing qualifications. Two agency leads primarily want every action to have an owner; one gives an example where the model assigned the note-taker as owner even though the client volunteered. One founder with a screen reader likes the text but cannot use unlabeled controls.
The agency lead's ownership error came from an accented, noisy recording; we have not compared the transcript with the audio.
A researcher logged the consultants' quotes twice, once in interview notes and once in the synthesis document: they are still two interviewees.
Usage team: in a 20-workspace convenience pilot, weekly exports rose from 84 to 101 after a shorter-summary setting launched. The same week, a prominent export button shipped. We did not randomize workspaces or measure retained users.
Sales asks us to claim the change improved retention and make every summary five bullets. Engineering has capacity for one small product change plus one instrumentation change next week. No customer approved automatic deletion of detail.

### Hidden evaluation (never sent to models)

- **segments (critical):** Preserve the three founders' brevity preference, two consultants' need for detail/timestamps, two agency leads' ownership need and the screen-reader accessibility issue. Duplicated consultant quotes must not increase the number of interviewees above eight.
- **ownership (critical):** Identify the falsely assigned action owner as a quality concern and the noisy/accented transcript as an unverified possible contributor. Do not blame an accent or claim a confirmed root cause.
- **causality (critical):** If reporting the 84-to-101 export change, treat it as descriptive and acknowledge the simultaneous button change, convenience sample and absence of retention measurement. Explicitly reject the requested retention claim.
- **recommendation (critical):** Recommend an approach that preserves detailed information for users who need it, rather than universally imposing destructive five-bullet summaries. Fit the stated capacity of one small product change plus one instrumentation change; acknowledge other needs without promising to ship them all next week.
- **experiment (secondary):** Propose one concrete follow-up experiment with a comparison and a measurable outcome. Address segment differences or correctness/ownership; do not use increased export count alone as proof of retention or quality.
- **format (critical):** 220-300 words; a coherent decision memo with recommendation and one experiment. No invented conversion, retention, statistical significance or delivery guarantees.

**Critical omissions:** Losing the consultants' need for detail, the ownership error, or the export-button confounder constitutes failure.

## 09-outage-rewrite — Rewrite an outage update without inventing an all-clear

Category: rewrite_copy · Baseline: gpt-6.1-sol · Evaluation: manual_rubric

### System prompt

Rewrite operational updates for customers in clear, calm language. Preserve factual uncertainty and scope. Do not add guarantees, credits or security claims. Follow the requested length and format.

### User request

Produce a subject line and a 100-150 word email body for a small analytics SaaS. Replace jargon, acknowledge the disruption, and include the next update time.
Internal source: On October 8 between 09:10 and 09:42 UTC, dashboard queries timed out for some EU workspaces. A cache configuration rollback restored dashboard query success rates at 09:42. Delayed scheduled exports are still draining; do not say all exports are delivered. Current investigation has found no evidence of lost stored data, but validation is ongoing; this is not a guarantee that no data was lost. We have not completed a security review, so do not make a security statement. Users do not need to resubmit scheduled exports. Next update by 11:00 UTC, even if backlog work continues. No approved refund or service credit.
Bad draft: 'We fully remediated a cache-invalidation cascade. Everything is fixed and your data is 100% safe. Please rerun every export. We guarantee this will not recur.'

### Hidden evaluation (never sent to models)

- **scope_time (critical):** Correctly state October 8, 09:10-09:42 UTC, dashboard-query failures for some EU workspaces, and recovery of dashboard queries after rollback. Do not expand the incident to every workspace or service.
- **ongoing_work (critical):** Make clear that scheduled exports are still catching up and customers should not resubmit them. Do not announce all exports delivered or all work completed.
- **data_uncertainty (critical):** Convey that no evidence of stored-data loss has been found so far and validation continues. Do not guarantee data safety, assert no loss definitively, or make a security statement.
- **next_update (critical):** Promise only the authorized next update by 11:00 UTC even if work continues. No invented resolution deadline, refund, credit or guarantee against recurrence.
- **voice_format (secondary):** Subject plus a 100-150 word body, excluding subject/labels. Calm plain language, acknowledges disruption, removes the bad draft's jargon and incorrect rerun instruction.

**Critical omissions:** A false all-clear, resubmission instruction, absolute data-safety claim, or missing 11:00 update fails.

## 10-onboarding-copy — Pricing-sensitive onboarding copy with exact plan limits

Category: rewrite_copy · Baseline: gpt-6-astra · Evaluation: manual_rubric

### System prompt

Write useful onboarding copy for an indie SaaS. Benefits must follow from the supplied product facts. Avoid invented social proof, measured savings, unlimited-use claims and unsupported integrations. Use a friendly, plain tone.

### User request

Deliver two distinct email variants, each with a subject of at most 45 characters, a preview of at most 70 characters, and a 90-130 word body. Each body ends with the exact CTA 'Create your first draft'. A/B labels and field labels do not count toward word limits.
Product: DraftDesk turns pasted support-ticket notes into a reply draft for a human to review. It cannot send replies or connect to a helpdesk yet. Free plan: 20 drafts per calendar month, no credit card, no automatic paid conversion. Starter: $19/month for 500 drafts/month; unused drafts do not roll over. Annual billing is $190/year paid upfront. Both paid prices are USD, exclude applicable taxes, and are optional. A user can stay free. We have no measured time-saving claim and no customer testimonials.
Audience: a time-poor founder who has signed up but made no draft. Variant A should focus on finishing a real task today; B should focus on control and starting free. Both must accurately mention the free allowance, human review, optional Starter monthly price and monthly allowance. Do not mention annual pricing unless you also explain upfront payment and its allowance correctly. Do not frame a recurring free plan as a time-limited trial.

### Hidden evaluation (never sent to models)

- **free_plan (critical):** Both variants accurately describe 20 drafts per calendar month, no credit card and the ability to remain free without automatic paid conversion. Do not call this a time-limited trial or imply unused drafts roll over.
- **paid_plan (critical):** Both mention optional Starter at USD $19/month for 500 drafts/month with applicable taxes excluded. Any annual mention must correctly say USD $190/year paid upfront for 500 drafts per month, not 500 per year or an annual pool.
- **control (critical):** Both make human review clear. The task starts by pasting support notes; do not imply automatic sending or an existing helpdesk integration.
- **unsupported_claims (critical):** No fabricated testimonials, adoption counts, quantified time savings, unlimited usage, guarantees or scarcity. Benefits must follow from creating a reviewable reply draft.
- **distinct_variants (secondary):** A emphasizes finishing a real task today and B emphasizes control/starting free. They must be meaningfully distinct and useful to a busy founder, rather than only changing a synonym.
- **format (secondary):** Two variants; each subject <=45 characters, preview <=70 characters and body 90-130 words, excluding labels. Each body ends exactly with Create your first draft. Friendly plain language.

**Critical omissions:** Wrong allowance/price, invented sending/integration, or loss of human control fails regardless of persuasive quality.

## 11-launch-synthesis — Launch readiness from conflicting dated operations notes

Category: longer_context_synthesis · Baseline: gpt-6-astra · Evaluation: manual_rubric

### System prompt

Synthesize the supplied internal evidence into a decision memo for a small SaaS founder. Later dated, authoritative updates override earlier drafts. Separate shipped facts, conditional plans and unknowns. Cite source IDs for material claims. Do not invent missing measurements or treat earlier ambitions as approvals.

### User request

It is October 12, 2026 at 12:00 UTC. Should LedgerLeaf launch its AI invoice assistant tomorrow? Write 450-600 words with: recommendation, evidence, a short owner/action table, and the conditions for the next decision. Scope your recommendation separately for an invite-only pilot and a public launch. Use source IDs [L1] etc.

[L1 | October 5 | founder planning note]
We originally targeted October 13 for a public launch to all 1,200 workspaces. The assistant reads uploaded invoice text and drafts ledger entries; an accountant must approve each entry. This is a planning target, not a launch sign-off. Our first use case is English-language USD invoices from US vendors. Multi-currency and automated posting are out of scope. Paid pilot pricing is not final. We want a launch that creates evidence without surprising customers with irreversible accounting changes.

[L2 | October 7 | engineering readiness draft]
In staging, all 60 standard invoice fixtures completed. We considered the import worker ready and suggested removing the pilot size limit. Retry handling was reviewed for network timeouts, but this run did not contain accented vendor names, files above 2 MB, or deliberate duplicate uploads. Staging completion is not a production acceptance measure. The proposed public feature flag was still off.

[L3 | October 8 | support and design interview notes]
Four of seven interviewed bookkeepers wanted a draft they could inspect before posting. Two specifically asked that amounts and vendor names link back to source text. One said she would only test with synthetic invoices until retention was explained. These were recruited power users. There is no evidence that seven interviews represent the 1,200 workspaces. Support estimated ten minutes to investigate a failed import if a source document and job ID are both available. Without a job ID, the investigation may take much longer.

[L4 | October 9 | revised engineering incident note]
Production-shadow testing found accented vendor names could be silently normalized into the wrong supplier record. Standard US names were unaffected in the observed sample. Inez owns a fix and a regression test, targeted for October 13 at 10:00 UTC. Targeted is not shipped: as of this note, neither the fix nor the regression test is in production. A separate duplicate-upload warning is implemented in staging but has not been verified in the production path. Do not report the October 7 staging run as resolving these issues.

[L5 | October 10 | privacy review]
Omar approved a 30-day retention setting for uploaded invoice text for the invite-only pilot, provided deletion at day 30 is verified before any real customer document is uploaded. No claim about GDPR certification or legal compliance was approved. The public privacy page still describes the old 90-day import retention. A customer-facing explanation for the pilot can be a signed-off invitation and consent screen; a public rollout requires the public page to be corrected. The deletion-job check remains pending.

[L6 | October 10 | finance note]
The team has $1,500 for this month's pilot support and model costs. This is an internal experiment budget, not a customer pricing decision. Manual approval of a ledger entry does not eliminate the need to validate extraction. No measured cost per successful invoice is available yet. We must log successful completions and corrections separately from attempts before comparing economic outcomes. Avoid promises that the assistant saves a fixed percentage of bookkeeping time.

[L7 | October 11 | launch rehearsal]
Rehearsal on 80 synthetic English USD invoices: 76 draft entries were accepted without edits by a bookkeeper; four needed tax corrections. No entries were automatically posted. The 95% acceptance rate is on this synthetic set only. The accented-name failure was not represented, so the rehearsal does not close L4. A p95 latency of 18 seconds was observed. Nothing in this run measures real customer retention, production accuracy or the cost of support. The review UI links amounts to source text; vendor-name source highlighting is still missing.

[L8 | October 11 | operations update]
Nia can staff a pilot support channel for at most 20 invited workspaces during 09:00-17:00 UTC weekdays. The old assumption that the full support team could absorb 1,200 workspaces was withdrawn. During the pilot, a stop switch can disable new imports while preserving existing drafts. Inez tested this switch successfully in staging; a production-path check is scheduled for October 12 at 16:00 UTC. That check has not happened at the time of this decision memo.

[L9 | October 12 09:00 | founder revision]
Replace the public-launch target with a conditional pilot proposal. Start with 10 invited workspaces, English USD invoices only, drafts requiring human approval. We can reconsider public availability after seven days of measured pilot results. Required gates before real documents: accented-name fix and regression verified in production; 30-day deletion verified; consent copy signed off; production stop switch checked. This note authorizes preparations only. If a gate misses October 13, postpone the pilot rather than silently waive it.

[L10 | October 12 10:00 | owners and measurement]
Inez owns the name fix, regression and production stop-switch check. Omar owns deletion verification and pilot consent copy. Nia owns invitations, support rota and the incident contact. Jules owns instrumentation for attempts, successful drafts, corrections, model cost, support time and p95 latency. Jules expects a dashboard by October 13, but it is not live yet. No numeric go/no-go accuracy threshold has been approved; ask the founder to set one before evaluating pilot expansion.

[L11 | October 12 11:00 | marketing draft, not approved]
Draft headline: 'Live tomorrow for everyone: flawless automated bookkeeping at half the cost.' Marketing asks whether it can announce this today. This language conflicts with the restricted, conditional pilot and the absence of production cost data. The signup page still says join waitlist. No customer has been promised an October 13 availability date.

[L12 | decision context]
There are no further status updates after 11:00. Treat all scheduled checks, targeted fixes and expected dashboards as outstanding unless a source explicitly confirms completion. A useful memo should identify what can be prepared now, what blocks real-document use, and who must report back. It must not turn unknowns into finished work just to meet the original date.

### Hidden evaluation (never sent to models)

- **decision (critical):** Recommend no public launch tomorrow; distinguish preparations for a conditional 10-workspace pilot from permission to use real documents. Restrict the pilot to English USD invoices and human-approved drafts; postpone if gates remain open. Cite L9 and acknowledge the original L1 target was superseded.
- **gates (critical):** List all four outstanding pre-document gates: production name fix/regression, verified 30-day deletion, signed-off consent, production stop-switch check. As of noon October 12, scheduled work is not completed; cite L4/L5/L8/L9/L10 as relevant.
- **evidence_limits (critical):** Report 76/80 = 95% synthetic acceptance and four tax corrections with its synthetic/sample limitations; do not imply production accuracy, resolution of the name bug or verified cost savings. Recognize missing vendor highlighting and unmeasured successful-invoice economics without inventing a approved numeric accuracy threshold.
- **owners (secondary):** Give actionable ownership: Inez for name/regression/stop-switch; Omar for deletion/consent; Nia for invitations/support; Jules for measurement. Separate these named responsibilities from the founder's need to approve expansion criteria.
- **scope_resources (critical):** Respect 10 invited workspaces versus the support capacity ceiling of 20, weekday support hours and the internal $1,500 monthly pilot budget. Public retention copy needs correction before public rollout; do not claim certification, automatic posting, multi-currency support or approved paid pilot pricing.
- **next_decision (critical):** Define a gate check before real-document use and a seven-day evidence review before expansion; include attempts, accepted/successful drafts, corrections, model cost and support time in the measurement plan. Reject the unapproved flawless/half-cost marketing claims.
- **format_sources (critical):** 450-600 words including table/headings; recommendation, evidence, owner/action table and next-decision conditions. Material claims cite appropriate L source IDs. No fabricated completed checks, approvals, measurements or customer promises.

**Critical omissions:** Any missing required launch gate, a public go-ahead, or treating a planned check as completed fails. No canonical memo is prescribed.

## 12-pilot-synthesis — Pilot decision with shifted traffic and misleading aggregate success

Category: longer_context_synthesis · Baseline: gpt-6-astra · Evaluation: manual_rubric

### System prompt

Write a founder decision memo from the supplied pilot packet. Check denominators, reconcile later corrections, and separate evidence from causal claims. Cite source IDs. Treat numeric results as descriptive. Do not invent statistical significance, production savings or an answer to an unresolved quality issue.

### User request

Write 450-600 words recommending whether ReplyHarbor should replace its current reply-drafting workflow with Variant B. Include a compact economics table, a discussion of quality and traffic mix, and a bounded next experiment with rollback conditions. Use only the packet below.

[P1 | product context]
ReplyHarbor is a five-person SaaS selling support-reply drafts to online shops. A human agent must approve a draft before sending. An accepted draft is one the agent marks usable without a substantive rewrite; it is not an independently audited correct reply. Billing and refund tickets are higher risk than general shipping-status questions. This experiment compared complete workflow variants, not a randomized model-only change. Nothing was routed automatically after the pilot.

[P2 | Variant A, week 1]
1,000 attempted drafts: 800 shipping-status questions and 200 billing/refund questions. Agents accepted 720 shipping drafts and 120 billing drafts, 840 in total. AI spend across all attempts was $14. Support operations recorded 12 escalations attributable to drafting issues. Every attempt is included, including rejected drafts and errors. The AI spend already includes retries, so do not add retry costs again.

[P3 | Variant B, week 2]
1,000 attempted drafts: 950 shipping-status questions and 50 billing/refund questions. Agents accepted 874 shipping drafts and 25 billing drafts, 899 in total. AI spend was $6. Support operations recorded 25 drafting-related escalations. B used a different prompt as well as a cheaper model. One large customer who supplied many difficult billing requests in week 1 paused during week 2. This was not a randomized assignment and the request mix shifted.

[P4 | support cost correction]
An early draft priced support at $2 per escalation. Finance corrected the figure to $4 per escalation for both weeks. Use the corrected $4 and the final escalation counts in P2 and P3. Each escalation is already deduplicated; do not add agent rejection counts as additional paid support tickets. Thus the relevant observed cost is AI spend plus these escalations. No infrastructure or subscription-revenue changes should be inferred.

[P5 | spreadsheet comment]
A manager said: 'B is clearly better: acceptance rose from 84.0% to 89.9%, and AI spend fell by more than half. It should be cheaper per useful reply.' Recalculate the cost per accepted draft rather than accepting the conclusion. Also compare within each ticket type. For a descriptive common-mix comparison, apply B's shipping and billing acceptance rates to A's 80% shipping / 20% billing mix. This is a reweighting exercise, not a causal estimate or a forecast.

[P6 | independent spot check]
A quality lead sampled 30 accepted drafts from each week after agent approval. Two accepted A drafts and five accepted B drafts contained unsupported refund-policy statements. The convenience samples were small, and no sampling weights or confidence intervals were calculated. The reviewer was aware of the variant names. These counts are a warning that apparent acceptability can conceal factual error, not a population error-rate estimate. No result proves the agent-approved drafts were all correct.

[P7 | factual source boundaries]
The legitimate refund policy permits a refund within 14 days for unused items and requires human approval for exceptions. Some flagged drafts promised instant refunds on opened items. A draft can sound helpful while inventing policy. The pilot did not measure whether any such draft was sent, the amount refunded, or customer harm. Do not claim a financial loss or legal violation occurred. This is a quality risk needing adjudication.

[P8 | operational notes]
Median response time fell from 3.8 seconds to 2.6 seconds with B. End-to-end handling time was not measured. Agents sometimes spent longer correcting refund-policy language, but the notes contain no timed measurements. Do not convert response latency into labor-cost savings. The service promises human-approved drafts, not unattended answers. There is no approval to remove human review.

[P9 | proposed next experiment]
Engineering can run a seven-day, capped, stratified comparison with separate shipping and billing strata. It can keep prompts fixed while varying models, record AI usage for all attempts, and link support escalations to the attempt that caused them. Operations can blind a second reviewer to variant identity and audit accepted as well as rejected drafts against the actual refund policy. Nia owns operations review; Inez owns assignment and measurement. Keep current production routing until a decision is approved.

[P10 | founder constraints]
We can invite at most 10 shops and spend at most $200 of incremental experiment cost. This $200 is a proposed real-world product pilot budget, not permission to raise AI Bill Doctor's benchmark cap. Any automated outbound sending remains prohibited. Stop the new product pilot if a policy-violating draft escapes review or if cumulative incremental cost reaches $200. These are proposed stop conditions to include in the memo, not events that already occurred.

[P11 | final reporting request]
Report observed AI cost, support cost, total cost and cost per accepted draft for each variant. Round cost per accepted draft to four decimal places. Give within-type acceptance rates and B's reweighted acceptance rate under A's mix. Explain why aggregate acceptance, quality correctness and economic savings answer different questions. Decide what can be concluded now and what still requires a controlled comparison. Do not call the reweighted result statistically significant.

### Hidden evaluation (never sent to models)

- **economics (critical):** Table uses the corrected $4 support cost: A AI $14, support $48, total $62, cost/accepted draft $0.0738; B AI $6, support $100, total $106, cost/accepted draft $0.1179. Do not double-count retries or rejection counts. Explain that lower AI spend did not yield lower observed total cost per accepted draft. Cite P2-P5.
- **mix (critical):** Report A shipping 90%, billing 60%; B shipping 92%, billing 50%; B reweighted to A's 80/20 mix is 83.6%, versus A's 84%. Explain why the 89.9% aggregate is affected by mix and why this nonrandomized reweighting does not prove a causal model effect.
- **false_confidence (critical):** Separate agent acceptance from correctness. Report the spot-check warning of 2/30 A and 5/30 B unsupported policy claims, acknowledging convenience samples and nonblind review. Do not extrapolate population error rates or claim known financial harm.
- **decision (critical):** Do not recommend blanket replacement based on the supplied evidence. Preserve human approval and current routing while proposing a bounded stratified comparison. A limited shipping-only follow-up is acceptable if it does not erase the billing risk or assert quality equivalence.
- **experiment (critical):** Propose fixed prompts, stratified assignment, blind independent rubric review and accounting for all attempts/support. Identify Nia/Inez ownership, <=10 shops, seven days and <=$200 incremental product-pilot budget. Include the stated cost and escaped-policy-violation stop conditions; do not change the benchmark's cap.
- **limits (critical):** Distinguish 3.8-to-2.6 second response latency from unmeasured end-to-end handling/labor savings. Do not claim statistical significance, retention effects, proven production savings, legal violations or automatic sending.
- **format_sources (secondary):** 450-600 words including table/headings; economics table, mix/quality discussion and next experiment. Cite supporting P IDs for material claims. No invented facts or canonical wording requirement.

**Critical omissions:** Wrong support-cost denominator, missing traffic-mix correction or equating accepted with correct is a failure.
