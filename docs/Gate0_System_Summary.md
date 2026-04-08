# Gate 0 — Agentforce Email Order Intake Agent
## System Summary: Makana / Med-Tech-01

---

## Purpose

Automate the initial triage of inbound customer emails that arrive via Email-to-Case in Salesforce. The system classifies each email as a **Sales Order**, **General** support request, **Ambiguous**, or **Noise**, routes it to the correct holding queue, and surfaces the AI's reasoning to a human agent for review and confirmation before any final routing or record changes are applied.

---

## Component 1: Record-Triggered Flow — `Case_RT_Flow_Email_Case_Classification`

**Trigger:** Fires on Case creation where `Origin = Email`.

**What it does:**

1. Calls the invocable flow `Case_Gate0_Find_Email_Information` to gather email metadata (subject, body, sender, routing mailbox To address, attachment names/types, and attachment count) and formats it into a single text block.
2. Passes that text block to the Prompt Template `Case_Gate0_Email_Classification` via a `callLlm` action.
3. Receives a structured JSON response from the LLM.
4. Branches on the `classification` field in the JSON (`Sales_Order`, `Noise`, `Ambiguous`, or default/General) only to set a branch-specific internal Case Comment body.
5. All branches converge to a single shared update step that:
   - Sets `Classification_Result__c` (the AI's classification)
   - Sets `Classification_Confidence__c` (High / Medium / Low)
   - Sets `Classification_Rationale__c` (the AI's plain-English reasoning)
   - Sets `Classification_Signals__c` (the 5 signals the AI evaluated)
   - Sets `Triage_Status__c = Pending`
   - Sets `OwnerId` to the `Pending_Triage_Queue` (a central holding queue — all cases land here regardless of classification)
   - Sets `Type` and `SDO_Sub_Type__c` from the LLM's recommended values
6. Creates an internal (non-public) Case Comment with the classification summary.

**Key design principle:** The flow does NOT change the RecordType, does NOT route to the final destination queue, and does NOT close Noise cases. All of that is deferred to Apex after a human confirms. The flow's only job is to run the AI and park the case in the holding queue with the AI's findings.

---

## Component 2: Invocable Flow — `Case_Gate0_Find_Email_Information`

**Purpose:** A utility flow called by the RTF above to gather and format all the context the LLM needs.

**What it does:**

1. Accepts a Case ID as input.
2. Queries the related `EmailMessage` records (subject, body, from address, To address).
3. Queries `ContentDocumentLink` → `ContentDocument` to find any file attachments (names, types, extension).
4. Formats all of this into a structured plain-text string (the "email info block") returned to the calling flow for injection into the prompt template.

---

## Component 3: Prompt Template — `Case_Gate0_Email_Classification`

**Type:** Flex Prompt Template (for use in Flows via `callLlm`)  
**Model:** Claude Sonnet (via Salesforce-hosted model endpoint)

**Input:** The formatted email info block produced by the invocable flow — subject, body preview, sender, To address, attachment names and types.

**Task:** Evaluate 5 signals and return a strict JSON object.

| Signal | What it checks |
|--------|----------------|
| Signal 1 — Routing Mailbox | Does the To address contain "order", "orders", "po", "purchase", or "procurement"? |
| Signal 2 — Email Content | Are there PO numbers, order submission language, or procurement templates in subject/body? |
| Signal 3 — Attachment | Is a PDF present (confirmed via routing info, not inferred from body text)? |
| Signal 4 — NAF Collision | PDF is present but email is requesting account setup, not order processing? |
| Signal 5 — Noise Check | Is this an order acknowledgment reply or automated system notification requiring no new processing? |

**Output (strict JSON):**

```json
{
  "classification": "Sales_Order | General | Ambiguous | Noise",
  "confidence": "High | Medium | Low",
  "rationale": "plain English explanation of decision",
  "signalsUsed": "Signal 1: [name] — [result] — [description]\nSignal 2: ...",
  "recommendedType": "e.g. Order",
  "recommendedSubType": "e.g. New Order"
}
```

**Guardrails:**

- Default to `Ambiguous` when intent is unclear or a claimed order lacks a PDF attachment.
- Classify as `Noise` only when the email is definitively a system-generated notification or auto-reply.
- Never infer attachment presence from body text alone.

---

## Component 4: LWC — `caseTriageReview`

**Placement:** Embedded on the Case Lightning Record Page (right panel, visible to all users).

### State 1 — Pending Review (`Triage_Status__c = Pending`)

Renders a card titled "Gate 0 — Pending Review" showing:

- Classification badge (color-coded) and Confidence badge
- Recommended Type and Subtype as side-by-side chips
- AI Rationale (plain-English text from the prompt)
- All 5 signals always rendered in numeric order, each showing: `Signal N — [Name] — [Result]` with a description line. Missing signals are shown at reduced opacity with "Not triggered."
- **Confirm & Route** button → calls `CaseTriageController.confirmClassification()` in Apex
- **Override** toggle → expands a form with: new Classification (required picklist), new Type, new Subtype, Override Reason (required picklist with 7 options), and Override Notes (optional free text) → calls `CaseTriageController.overrideClassification()` in Apex

### State 2 — Triage Complete (`Triage_Status__c = Confirmed` or `Overridden`)

Renders a compact summary card showing final classification, confidence, outcome badge, and timestamp. Includes a "View details" chevron toggle (accordion) that expands an inline read-only panel with the full rationale, all 5 signals, and the override reason/notes if applicable.

---

## Component 5: Apex Controller — `CaseTriageController`

### `confirmClassification(caseId)`

- Reads the existing `Classification_Result__c` from the Case
- Calls `applyRouting()` which:
  - Sets `Triage_Status__c = Confirmed`
  - Sets `Classification_Outcome__c = Correct_First_Touch`
  - Sets `Triage_Reviewed_At__c = now()`
  - If `Sales_Order`: changes RecordType to `Sales_Order`, routes to `Order_Process_Queue`
  - If `Noise`: sets `Status = Closed`
  - If `Ambiguous`: routes to `Human_Triage_Queue`
  - If `General`: no routing change

### `overrideClassification(caseId, newClassification, newType, newSubType, overrideReason, overrideNotes)`

- Updates `Classification_Result__c`, `Type`, `SDO_Sub_Type__c`, `Override_Reason__c`, `Override_Notes__c`
- Calls `applyRouting()` with `isOverride = true` → sets `Triage_Status__c = Overridden`, `Classification_Outcome__c = Override_Applied`
- Inserts an internal Case Comment logging the original vs. overridden values, reason, and notes for audit trail

---

## End-to-End Flow Summary

```
Email arrives → Email-to-Case creates Case (Origin=Email)
    ↓
Record-Triggered Flow fires
    ↓
Invocable Flow collects: email subject, body, sender, To address, attachment names/types
    ↓
Prompt Template (Claude Sonnet) evaluates 5 signals → returns classification JSON
    ↓
Flow updates Case:
  - Classification fields set from JSON
  - Triage_Status__c = Pending
  - OwnerId = Pending_Triage_Queue
  - Internal Case Comment created with rationale
    ↓
Human agent opens Case → sees caseTriageReview LWC
  - Reads AI rationale and signals
  - Clicks "Confirm & Route"  OR  fills out Override form
    ↓
Apex fires:
  - Confirm → applies final routing + RecordType based on AI classification
  - Override → applies routing based on human-selected classification + logs audit comment
    ↓
LWC refreshes → shows compact "Triage Complete" state with accordion detail view
```

---

## Custom Fields Added to Case Object

| Field API Name | Type | Purpose |
|----------------|------|---------|
| `Classification_Result__c` | Picklist | AI's primary classification (Sales_Order, General, Ambiguous, Noise) |
| `Classification_Confidence__c` | Picklist | AI's confidence level (High, Medium, Low) |
| `Classification_Rationale__c` | Long Text Area | AI's plain-English reasoning |
| `Classification_Signals__c` | Long Text Area | Raw signal output from the AI |
| `Classification_Outcome__c` | Picklist | Final triage outcome (Correct_First_Touch, Sent_To_Review, Override_Applied) |
| `Triage_Status__c` | Picklist | Human review state (Pending, Confirmed, Overridden) |
| `Triage_Reviewed_At__c` | DateTime | Timestamp of human confirmation or override |
| `Override_Reason__c` | Picklist | Primary reason selected by rep when overriding AI |
| `Override_Notes__c` | Text Area | Optional free-text notes from rep during override |

---

## Queues Referenced

| Queue | Purpose |
|-------|---------|
| `Pending_Triage_Queue` | Central holding queue — all inbound email cases land here initially |
| `Order_Process_Queue` | Final destination for confirmed Sales Orders |
| `Human_Triage_Queue` | Final destination for confirmed Ambiguous cases |

---

## Key Design Decisions

- **Human-in-the-loop by default:** No case is permanently routed by the AI alone. The AI parks all cases in a single holding queue; a human must confirm or override before final routing happens.
- **Audit trail:** Every override is logged as an internal Case Comment and captured in structured fields (`Override_Reason__c`, `Override_Notes__c`, `Triage_Reviewed_At__c`, `Classification_Outcome__c`).
- **Conflict isolation:** A pre-existing Omni-Channel routing flow (`SDO_Service_Case_Routing`) was configured to exclude Email-origin cases so it does not overwrite the Gate 0 routing.
- **RecordType change deferred to Apex:** The Flow does not change the RecordType. Only Apex changes it after human confirmation, preventing premature record type switches that could break field visibility rules or page layouts during triage.
- **Signal transparency:** All 5 signals are always surfaced in the LWC regardless of whether they were triggered, so agents can see exactly what the AI evaluated and identify gaps or misclassifications.
