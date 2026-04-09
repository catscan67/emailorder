# Service Team Agent — Design Summary

**Last updated:** April 2026  
**Status:** Draft (not yet committed as a Version in Agentforce Builder)  
**Org:** `admin@catscanfy27.sdo`

---

## What It Does

The Service Team Agent is an Agentforce Employee Agent that helps service reps process inbound Sales Order cases. When a rep opens a Case and asks the agent to review order details, the agent automatically checks whether the case's attachments are eligible for AI extraction, then either extracts shipping details from the email body and PDF or tells the rep to review manually.

This provides an alternative to the fully automated Gate 1 record-triggered flow — instead of running silently on every qualifying case, the agent is invoked on demand by the rep in a conversational interface.

---

## How to Use It

1. Open a Sales Order case in Salesforce
2. Launch the Service Team Agent panel (Agentforce sidebar)
3. Say something like **"verify order details for this case"** or **"review order details"**
4. The agent will:
   - Check the case's attachments (type, count)
   - If eligible: extract Shipping Preference, Attention To, and Ship To Address and present them in the conversation
   - If not eligible: explain why and tell the rep to review attachments manually
5. The rep can then confirm or edit the values directly on the case record

The agent picks up the Case ID automatically from `currentRecordId` — the rep does not need to provide it.

---

## Agent Configuration

| Property | Value |
|---|---|
| Agent Label | Service Team Agent |
| Developer Name | `Service_Team_Agent` |
| Agent Type | AgentforceEmployeeAgent |
| Language | en_US, en_GB |
| Script File | `docs/Service_Team_Agent.agentscript` |

## Access / Permission Set

Users must be assigned the **AEA Service Team Agent** permission set (`AEA_Service_Team_Agent`) to access the agent.

| Property | Value |
|---|---|
| Permission Set Label | AEA Service Team Agent |
| API Name | `AEA_Service_Team_Agent` |
| Grants | `agentAccess` to `Service_Team_Agent` |
| Metadata | `force-app/main/default/permissionsets/AEA_Service_Team_Agent.permissionset-meta.xml` |

To assign: Setup → Permission Sets → AEA Service Team Agent → Manage Assignments.

---

## Topics

### Topic Selector (start_agent)

Routes the user's intent to the correct topic. Available transitions:

| Topic | When to route |
|---|---|
| Verify Order Details | User asks to review, verify, or check order details |
| General FAQ | Questions about company products, policies, or procedures |
| Off Topic | Requests outside the agent's domain |
| Ambiguous Question | Vague or unclear requests needing clarification |

### Verify Order Details

The primary topic. Executes a deterministic two-step workflow followed by a conditional response.

### General FAQ

Searches knowledge articles using `AnswerQuestionsWithKnowledge`. Returns grounded answers with optional citations.

### Off Topic / Ambiguous Question

Standard guardrail topics that redirect or clarify without invoking any actions.

---

## Verify Order Details — Detailed Flow

```
Topic enters
    │
    ▼
extractionComplete == False?
    │ Yes
    ▼
Run Check_Case_Attachment_Types (deterministic)
    │  Sets: hasAttachments, hasPDFs, hasUnreadableFiles,
    │        pdfCount, unreadableCount, unreadableFileList, firstPdfId
    │
    ▼
extractionComplete == False AND (pdfCount == 1 with no unreadable files OR no attachments)?
    │
    ├── Yes ──────────────────────────────────────────────────────────┐
    │   Run Extract_Sales_Order_Details (deterministic)               │
    │   Capture promptResponse → orderDetailsResponse variable        │
    │   Set extractionComplete = True                                 │
    │   Present extracted values to the rep via resolved variable     │
    │                                                                 │
    └── No ──────────────────────────────────────────────────────────┘
        extractionComplete still False → manual review path
        Set extractionComplete = True
        Explain why extraction was blocked:
          - Too many PDFs
          - Unsupported file types (Word/Excel/PowerPoint)
          - Both
        Instruct rep to review attachments manually

On subsequent reasoning iterations:
    extractionComplete == True → all three if blocks skip → topic exits
```

### Why Three Flat `if` Blocks?

Agent Script does not support nested `if` statements. The three sequential blocks at the same indentation level achieve the same effect:

1. **Block 1** — runs attachment check (guarded by `extractionComplete == False`)
2. **Block 2** — runs extraction if eligible (guarded by `extractionComplete == False AND` eligibility condition). Sets `extractionComplete = True` on success.
3. **Block 3** — catches the manual review case (guarded by `extractionComplete == False`). If block 2 ran and set the flag, this block skips.

### Why `extractionComplete` Is Needed

Without it, the reasoning loop re-executes the deterministic `run` commands on every iteration, causing the agent to call the attachment check and prompt extraction repeatedly. The boolean flag ensures both actions run exactly once per conversation.

---

## Actions

### Check Case Attachment Types

| Property | Value |
|---|---|
| Target | `flow://Case_Check_Attachment_Types` |
| Called | Deterministically via `run` |
| Input | `recordId` — from `currentRecordId` |

Queries the inbound EmailMessage for the case, traverses ContentDocumentLink and ContentDocument records, and classifies each attachment as PDF, unreadable (Word/Excel/PowerPoint), or other.

**Outputs stored in variables:**

| Variable | Type | Purpose |
|---|---|---|
| `hasAttachments` | Boolean | Any files attached at all |
| `hasPDFs` | Boolean | At least one PDF present |
| `hasUnreadableFiles` | Boolean | Word/Excel/PowerPoint files present |
| `pdfCount` | Number | Count of PDFs |
| `unreadableCount` | Number | Count of unreadable files |
| `unreadableFileList` | String | Comma-separated names of unreadable files |
| `firstPdfId` | String | ContentDocument Id of the first PDF |

### Extract Sales Order Details

| Property | Value |
|---|---|
| Target | `generatePromptResponse://AF_Review_Sales_Order_Details` |
| Called | Deterministically via `run` |
| Inputs | `Input:Case` (required), `Input:File` (optional — `firstPdfId`) |

Invokes the `AF Review Sales Order Details` prompt template, which extracts Shipping Preference, Attention To, and Ship To Address from the email body and optional PDF attachment. Returns HTML.

**Output stored in variable:**

| Variable | Type | Purpose |
|---|---|---|
| `orderDetailsResponse` | String | HTML with extracted values, resolved into the LLM prompt via `{!@variables.orderDetailsResponse}` |

### Identify Record by Name

| Property | Value |
|---|---|
| Target | `standardInvocableAction://identifyRecordByName` |
| Called | By LLM as needed (not deterministic) |

Standard Agentforce action for record lookup. Available for the LLM to call if the rep references a record by name during conversation.

---

## Prompt Template: AF Review Sales Order Details

| Property | Value |
|---|---|
| API Name | `AF_Review_Sales_Order_Details` |
| Model | Gemini 2.5 Flash (Vertex AI) |
| Output Format | HTML (plain text — no structured response / Lightning Type) |
| Inputs | Case (required), File / ContentDocument (optional) |

This is a variant of `Review_Sales_Order_Details` built specifically for the agent. The key difference: it returns HTML instead of JSON with a Lightning Type. This avoids the structured response binding issues that occur when prompt templates with `outputSchema` are used as Agentforce actions.

### What It Extracts

| Field | Format in HTML |
|---|---|
| Shipping Preference | `Standard` or `Expedited` |
| Attention To | Person name, or `None` |
| Ship To Address | Full address string, or `Not detected` |

For multiple orders, each order gets its own block with a PO/reference heading.

### Why HTML Instead of JSON?

When the original `Review_Sales_Order_Details` prompt (with `outputSchema: SalesOrderValues` and `responseFormat: JSON`) was used as an Agentforce action, the agent threw errors on save. The structured response binding that works in Flow does not translate cleanly to the agent action framework. Removing the Lightning Type and switching to HTML output resolved the issue while preserving the same extraction logic.

---

## Variables

All variables are defined at the agent level (global scope) so they persist across topic transitions and reasoning iterations.

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `currentRecordId` | String | (set by platform) | Case ID from the record page context |
| `hasAttachments` | Boolean | False | Any files attached |
| `hasPDFs` | Boolean | False | At least one PDF |
| `hasUnreadableFiles` | Boolean | False | Word/Excel/PowerPoint present |
| `pdfCount` | Number | 0 | PDF count |
| `unreadableCount` | Number | 0 | Unreadable file count |
| `unreadableFileList` | String | (empty) | Names of unreadable files |
| `firstPdfId` | String | (empty) | ContentDocument Id of first PDF |
| `extractionComplete` | Boolean | False | Guards against re-execution |
| `orderDetailsResponse` | String | (empty) | HTML output from prompt |

---

## Attachment Eligibility Rules

| Scenario | Agent Behavior |
|---|---|
| No attachments | Eligible — runs prompt on email body only |
| 1 PDF, no Word/Excel | Eligible — runs prompt with Case + PDF |
| Multiple PDFs | Not eligible — tells rep to review manually |
| Any Word/Excel/PowerPoint | Not eligible — names the unsupported files |
| 1 PDF + unreadable files | Not eligible — conservative approach |

---

## Relationship to Gate 1 Flow

| Aspect | Gate 1 Flow | Service Team Agent |
|---|---|---|
| Trigger | Automatic — `OCR_Complete__c` checkbox | Manual — rep invokes agent |
| Execution | Record-triggered flow (after save) | Agentforce reasoning loop |
| Prompt | `Review_Sales_Order_Details` (JSON + Lightning Type) | `AF_Review_Sales_Order_Details` (HTML) |
| Output | Writes to Case fields + `Gate1_Status__c` | Presents in conversation only |
| Review | `orderReview` LWC on record page | Agent conversation |
| Best for | High-volume automated processing | Demo, ad-hoc review, low-volume |

Both approaches share the same attachment check subflow (`Case_Check_Attachment_Types`) and the same extraction logic in the prompt. The agent is designed as an alternative interaction model for the same underlying capability.

---

## Key Lessons Learned

**Agent Script does not support nested `if` statements.** Use sequential flat `if` blocks with compound conditions and a shared guard variable to simulate branching.

**Deterministic `run` commands re-execute on every reasoning loop iteration.** Always guard them with a boolean flag that gets set after the first run.

**Actions called deterministically should NOT be listed in `reasoning.actions`.** Listing them there exposes them as tools the LLM can independently choose to call, causing duplicate invocations and `user_input` prompts for parameters that are already available.

**The LLM cannot see action outputs unless they are resolved into the prompt.** Use `set @variables.varName = @outputs.outputName` after a `run` command, then reference `{!@variables.varName}` in the pipe (`|`) instruction. Otherwise the LLM will default to placeholder text.

**Structured response prompt templates (with `outputSchema`) do not work reliably as Agentforce actions.** Use plain text or HTML output format for prompts invoked by agents.
