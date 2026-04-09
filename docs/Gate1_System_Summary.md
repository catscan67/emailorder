# Gate 1 — Order Detail Extraction
## Design Summary

**Last updated:** April 2026  
**Status:** Active in org (`admin@catscanfy27.sdo`)

---

## What It Does

Gate 1 runs automatically on Sales Order cases after an OCR process has completed. It evaluates the case's email attachments, invokes an AI prompt to extract key shipping details, and writes the results directly to Case fields for rep review.

This is a **Human-in-the-Loop (HITL)** design: the AI extracts and pre-populates the fields, but a service rep reviews and confirms the values before the order is processed further.

---

## Trigger

**Flow:** `Case RT Flow - Gate 1 Order Detail Extraction`  
**Type:** Record-Triggered Flow — After Save  
**Object:** Case  
**Fires when:** `OCR_Complete__c` changes to `true` AND `Classification_Result__c = Sales_Order`  
**"Only when record changes to meet conditions":** Yes — fires only on the `false → true` transition, not on every save.

The `OCR_Complete__c` checkbox is expected to be set by whatever OCR/document processing system is in use (manual check during prototype/testing).

---

## Process Flow

```
Case saved with OCR_Complete__c = true (and Classification_Result__c = Sales_Order)
    │
    ▼
Run Attachment Check (Subflow: Case_Check_Attachment_Types)
    │  Outputs: hasAttachments, hasPDFs, hasUnreadableFiles,
    │           pdfCount, unreadableCount, unreadableFileList,
    │           firstPdfId, tcAllPdfIds
    │
    ▼
Attachment Rules (Decision)
    │
    ├── No Attachments ──────────────────────────────────────────────────┐
    │   (hasAttachments = false)                                          │
    │   → Review Sales Order (prompt on email body only)                  │
    │   → Update Case with SO details                                     │
    │                                                                     │
    ├── Exactly 1 PDF, no unreadable files ──────────────────────────────┤
    │   (pdfCount = 1 AND hasUnreadableFiles = false)                     │
    │   → Get First PDF ContentDocument (using firstPdfId from subflow)   │
    │   → Extract Case & PDF Details (prompt with Case + File)            │
    │   → Update with First PDF SO Details                                │
    │                                                                     │
    └── Default: Manual Review Required ─────────────────────────────────┘
        (multiple attachments, unreadable files, or mixed types)
        → Update Case — Manual Review Required
          (Gate1_Status__c = "Manual Review Required",
           Gate1_Notes__c = reason message with file details)
```

---

## Subflow: Case — Check Attachment Types

**API Name:** `Case_Check_Attachment_Types`  
**Type:** AutoLaunched Flow  
**Purpose:** Identifies the types and counts of files attached to the case's inbound email and categorizes them before the prompt runs — avoiding wasted AI tokens on cases where the model can't read the files.

### How It Works
1. Queries the first inbound `EmailMessage` for the Case
2. Queries `ContentDocumentLink` records where `LinkedEntityId = EmailMessage.Id` (files are linked to the email, not the Case directly)
3. Loops through `ContentDocumentLink` records to collect `ContentDocumentId` values
4. Queries `ContentDocument` records for those IDs to get `FileType`
5. Loops through ContentDocuments and classifies each as PDF, unreadable (Word/Excel/PowerPoint), or other

### Outputs

| Variable | Type | Description |
|---|---|---|
| `hasAttachments` | Boolean | True if any files are attached |
| `hasPDFs` | Boolean | True if at least one PDF is present |
| `hasUnreadableFiles` | Boolean | True if Word, Excel, or PowerPoint files are present |
| `pdfCount` | Number | Count of PDF attachments |
| `unreadableCount` | Number | Count of unreadable file attachments |
| `unreadableFileList` | String | Comma-separated list of unreadable file names and types |
| `attachmentSummary` | String | Human-readable count summary (e.g. "1 PDF(s), 0 unreadable file(s)") |
| `firstPdfId` | String | ContentDocument Id of the first PDF found |
| `tcAllPdfIds` | String Collection | ContentDocument Ids of all PDFs found (for future multi-file support) |

---

## Prompt Template: Review Sales Order Details

**API Name:** `Review_Sales_Order_Details`  
**Type:** Flex Prompt Template  
**Model:** Google Gemini 2.5 Flash (Vertex AI) — multimodal, supports PDF file input  
**Response Structure:** Sales Order Values (Lightning Type)  
**Inputs:** `Case` (required), `File` (ContentDocument, optional)

### What It Extracts

The prompt processes the email body and any attached PDF together as a single order submission. It extracts three primary values:

| Field | Description |
|---|---|
| `shippingPreference` | `Standard` or `Expedited` — determined by keyword signals in the email/attachment |
| `attentionTo` | Person or group name from ATTN/c/o/Deliver To patterns; null if not found |
| `shipToAddress` | Full shipping address as a single formatted string; null if not found |

**Expedited signals include:** "rush", "urgent", "priority", "overnight", "next day", "ASAP", "hot order", "emergency shipment", "earliest available", deadlines ≤ 3 business days, and similar.

**Multi-order handling:** The prompt identifies each distinct order by PO number or reference. For multiple orders, the top-level `shippingPreference` is set to `Expedited` if any order requires it. The full per-order breakdown is in the prompt response but not persisted to Case fields in the current design.

### Guardrails
- Never fabricates data — returns null when information is not present in a readable source
- Word/Excel files are flagged as unreadable; the prompt does not guess their contents
- Sets `extractionConfidence` to Low when unreadable files are referenced in the email body

---

## Case Fields Written

| Field | API Name | Type | Written by |
|---|---|---|---|
| Shipping Preference | `Shipping_Preference__c` | Picklist (Standard / Expedited) | Flow — structuredResponse |
| Attention To | `Attention_To__c` | Text (255) | Flow — structuredResponse |
| Ship To Address | `Ship_To_Address__c` | Text Area | Flow — structuredResponse |
| Gate 1 Status | `Gate1_Status__c` | Picklist | Flow — literal value |
| Gate 1 Notes | `Gate1_Notes__c` | Long Text Area | Flow — manual review message |
| OCR Complete | `OCR_Complete__c` | Checkbox | External OCR process / manual |

### Gate 1 Status Values
| Value | Meaning |
|---|---|
| `Pending Review` | Prompt ran successfully; rep should review extracted values |
| `Manual Review Required` | Attachment rules blocked the prompt; rep must review files manually |
| `Completed` | Rep has reviewed and confirmed the extracted details |

---

## Attachment Routing Rules

| Scenario | Action |
|---|---|
| No attachments | Run prompt on email body only (`shippingPreference`, `attentionTo`, `shipToAddress` from text) |
| Exactly 1 PDF, no Word/Excel | Run prompt with PDF file input |
| Multiple PDFs | Manual Review Required — `tcAllPdfIds` is available for future multi-file invocation |
| Any Word / Excel / PowerPoint | Manual Review Required — unsupported file types flagged with file names |
| Mixed (PDF + unreadable) | Manual Review Required — conservative approach |

The manual review message written to `Gate1_Notes__c` specifies the reason:  
> *"Automated extraction skipped. Unsupported file type(s) detected: [filename (TYPE)]. Please review the attachments and update Shipping Preference and Attention To manually."*

---

## Metadata Inventory

| Component | API Name | Type |
|---|---|---|
| Record-triggered flow | `Case_RT_Flow_Gate1_Order_Detail_Extraction` | Flow |
| Attachment check subflow | `Case_Check_Attachment_Types` | Flow |
| Prompt template | `Review_Sales_Order_Details` | GenAiPromptTemplate |
| Lightning Type | `Sales Order Values` | Response structure schema |
| Apex class (fallback) | `Gate1OrderExtractor` | ApexClass |

---

## Design Decisions

**Why a Record-Triggered Flow instead of an Agent?**  
The attachment gating logic (check file types → conditionally invoke prompt) is deterministic and benefits from Flow's explicit branching, auditability, and admin-friendly visibility. An Agent is better suited for conversational, multi-turn interactions. For a fully automated batch process with clear rules, a Record-Triggered Flow is the right tool.

**Why Gemini 2.5 Flash instead of Claude?**  
At time of build, Salesforce Prompt Builder did not support Claude for multimodal (file) inputs. Gemini 2.5 Flash supports PDF file input natively via Vertex AI.

**Why is Shipping Address a plain text field instead of a structured address?**  
The shipping address extracted from an order email is informational — it tells the service rep where the customer wants delivery, but it is not used for structured shipping logic in this system. A single text field is sufficient and avoids the complexity of parsing the AI output into street/city/state/zip components.

**Why `firstPdfId` from the subflow instead of re-querying in the parent flow?**  
The `Case_Check_Attachment_Types` subflow already traverses the ContentDocument records to classify them. Adding `firstPdfId` and `tcAllPdfIds` as outputs avoids duplicating that traversal in the parent flow, keeping the Gate 1 flow simple: subflow → decision → Get Records (single lookup by Id) → prompt.

**Why is `tcAllPdfIds` captured now if only 1 PDF is supported?**  
Future-proofing. Once multi-file prompt invocation is supported (either natively in Prompt Builder or via a custom approach), the collection is already available without changing the subflow.

---

## Path to Full Automation

The current HITL design requires a rep to confirm the extracted values. To fully automate:

1. Remove the `Gate1_Status__c = Pending Review` step and replace with a downstream trigger that fires when values are present
2. Add confidence thresholds — only auto-confirm when `extractionConfidence = High`
3. For multi-PDF cases, extend the prompt invocation to pass all PDFs (when Salesforce supports it) rather than routing to manual review
4. Add a Case Comment on prompt completion summarizing what was extracted (similar to Gate 0 pattern)
