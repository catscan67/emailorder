# Makana — Email Order Intake Agent (Gate 0)

This repo contains the Salesforce metadata for a Human-in-the-Loop (HITL) email case triage system built on Agentforce for Makana's order processing team. The solution automatically classifies inbound email cases and surfaces AI results to a service rep for review and confirmation before final routing.

---

## What It Does

When a new email case is created via Email-to-Case, a record-triggered Flow invokes a Prompt Template (backed by Claude via Agentforce) to classify the email as one of:

| Classification | Meaning |
|---|---|
| **Sales Order** | Customer is submitting a purchase order for processing |
| **Noise** | Follow-up, acknowledgment request, or automated notification — no action needed |
| **Ambiguous** | Signals conflict; needs human judgment |
| **General** | Standard support request, not order-related |

The AI evaluates 5 structured signals and writes its classification, confidence, rationale, and signal results back to the Case. The case is routed to a **Pending Triage Queue** and a custom LWC surfaces the AI's reasoning directly on the Case record page for a service rep to confirm or override.

After human review, an Apex controller handles final routing:
- **Sales Order** → Record Type changed to `Sales_Order`, routed to `Order_Process_Queue`
- **Noise** → Case auto-closed
- **Ambiguous** → Routed to `Human_Triage_Queue`
- **General** → No routing change

All confirmations and overrides are logged with a timestamp, outcome, override reason, and optional notes.

---

## Folder Structure

```
emailorder/
├── classes/
│   ├── CaseTriageController.cls
│   ├── CaseTriageController.cls-meta.xml
│   ├── CaseTriageControllerTest.cls
│   └── CaseTriageControllerTest.cls-meta.xml
├── flows/
│   ├── Case_Gate0_Find_Email_Information.flow-meta.xml
│   └── Case_RT_Flow_Email_Case_Classification.flow-meta.xml
├── genAiPromptTemplates/
│   └── Case_Gate0_Email_Classification.genAiPromptTemplate-meta.xml
├── lwc/
│   └── caseTriageReview/
│       ├── caseTriageReview.css
│       ├── caseTriageReview.html
│       ├── caseTriageReview.js
│       └── caseTriageReview.js-meta.xml
└── docs/
    └── Gate0_System_Summary.md
```

---

## Files Included

### Apex (`classes/`)
| File | Description |
|---|---|
| `CaseTriageController.cls` | `@AuraEnabled` methods called by the LWC: `confirmClassification` and `overrideClassification`. Handles final routing, Record Type assignment, `Triage_Status__c` updates, and audit logging. |
| `CaseTriageController.cls-meta.xml` | API version metadata |
| `CaseTriageControllerTest.cls` | Unit tests for the Apex controller |
| `CaseTriageControllerTest.cls-meta.xml` | API version metadata |

### Flows (`flows/`)
| File | Description |
|---|---|
| `Case_RT_Flow_Email_Case_Classification.flow-meta.xml` | Record-triggered Flow on Case. Fires on email-origin case creation. Calls the Gate 0 prompt, writes AI results to custom fields, sets `Triage_Status__c = Pending`, and routes to `Pending_Triage_Queue`. |
| `Case_Gate0_Find_Email_Information.flow-meta.xml` | Invocable Flow called by the prompt template. Retrieves sender address, recipient (routing mailbox) address, and attachment metadata to provide signal inputs to the LLM. |

### Prompt Template (`genAiPromptTemplates/`)
| File | Description |
|---|---|
| `Case_Gate0_Email_Classification.genAiPromptTemplate-meta.xml` | Agentforce Prompt Template. Defines the LLM task, 5 classification signals, allowed output values, and enforces a strict JSON response format for Flow parsing. |

### Lightning Web Component (`lwc/caseTriageReview/`)
| File | Description |
|---|---|
| `caseTriageReview.html` | Component template. Renders pending review panel (AI classification, confidence, type/subtype, rationale, 5 signals) and a post-review summary with expandable accordion. |
| `caseTriageReview.js` | Component controller. Handles signal parsing (robust to multiple LLM output formats), confirm/override actions, override reason selection, toast notifications, and record refresh. |
| `caseTriageReview.css` | Component styles. Includes badge pills, signal result color coding (Positive/Neutral/Negative/Not triggered), font size variants (Small/Medium/Large), and accordion layout. |
| `caseTriageReview.js-meta.xml` | Component metadata. Exposes the component to the Lightning App Builder with a configurable `fontSize` property. |

### Docs (`docs/`)
| File | Description |
|---|---|
| `Gate0_System_Summary.md` | Full technical summary of the Gate 0 architecture, data model, custom fields, queues, routing logic, and design decisions — written for LLM context handoff. |

---

## Custom Case Fields Required

These fields must exist on the Case object before deploying:

| Field API Name | Type | Purpose |
|---|---|---|
| `Classification_Result__c` | Picklist | AI classification output |
| `Classification_Confidence__c` | Picklist | High / Medium / Low |
| `Classification_Rationale__c` | Long Text Area | AI explanation |
| `Classification_Signals__c` | Long Text Area | All 5 signal results |
| `Classification_Outcome__c` | Picklist | Confirmed / Overridden / Sent to Review |
| `Triage_Status__c` | Picklist | Pending / Confirmed / Overridden |
| `Override_Reason__c` | Text Area | Rep-selected reason for override |
| `Override_Notes__c` | Long Text Area | Free-text notes |
| `Triage_Reviewed_At__c` | DateTime | Timestamp of human review |

---

## Queues & Record Types Required

- **Queues:** `Pending_Triage_Queue`, `Order_Process_Queue`, `Human_Triage_Queue`
- **Case Record Type:** `Sales_Order`
