import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue, refreshApex, getRecordNotifyChange } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

import confirmClassification  from '@salesforce/apex/CaseTriageController.confirmClassification';
import overrideClassification from '@salesforce/apex/CaseTriageController.overrideClassification';

import TRIAGE_STATUS            from '@salesforce/schema/Case.Triage_Status__c';
import CLASSIFICATION_RESULT    from '@salesforce/schema/Case.Classification_Result__c';
import CLASSIFICATION_CONFIDENCE from '@salesforce/schema/Case.Classification_Confidence__c';
import CLASSIFICATION_SIGNALS   from '@salesforce/schema/Case.Classification_Signals__c';
import CLASSIFICATION_RATIONALE from '@salesforce/schema/Case.Classification_Rationale__c';
import CLASSIFICATION_OUTCOME   from '@salesforce/schema/Case.Classification_Outcome__c';
import TYPE_FIELD               from '@salesforce/schema/Case.Type';
import SUB_TYPE_FIELD           from '@salesforce/schema/Case.SDO_Sub_Type__c';
import TRIAGE_REVIEWED_AT       from '@salesforce/schema/Case.Triage_Reviewed_At__c';

const FIELDS = [
    TRIAGE_STATUS, CLASSIFICATION_RESULT, CLASSIFICATION_CONFIDENCE,
    CLASSIFICATION_SIGNALS, CLASSIFICATION_RATIONALE, CLASSIFICATION_OUTCOME,
    TYPE_FIELD, SUB_TYPE_FIELD, TRIAGE_REVIEWED_AT
];

// ── Static lookup tables ────────────────────────────────────────────────────

const CLASSIFICATION_LABELS = {
    Sales_Order: 'Sales Order', Noise: 'Noise', Ambiguous: 'Ambiguous', General: 'General'
};

const CONFIRM_BUTTON_LABELS = {
    Sales_Order: 'Confirm & Route to Orders',
    Noise:       'Confirm & Close',
    Ambiguous:   'Mark Reviewed',
    General:     'Confirm'
};

const OUTCOME_LABELS = {
    Correct_First_Touch: 'Confirmed — correct first touch',
    Override_Applied:    'Overridden by rep',
    Sent_To_Review:      'Sent to review queue'
};

// Result keyword → CSS colour class
const RESULT_CLASSES = {
    positive:                 'result-positive',
    confirmed:                'result-positive',
    detected:                 'result-neutral',
    triggered:                'result-neutral',
    negative:                 'result-negative',
    neutral:                  'result-neutral',
    ambiguous:                'result-ambiguous',
    noise:                    'result-neutral',
    'not noise':              'result-positive',
    'not triggered':          'result-not-triggered',
    'not detected':           'result-not-triggered',
    'naf collision':          'result-negative',
    'naf collision detected': 'result-negative',
};

// Signal number → human-readable name and one-line definition
const SIGNAL_DEFS = {
    1: { name: 'Routing Mailbox',  def: 'Does the To address contain "order", "orders", "po", "purchase", or "procurement"?' },
    2: { name: 'Email Content',    def: 'PO numbers, order submission language, or structured procurement templates in subject/body' },
    3: { name: 'Attachment',       def: 'PDF confirmed present via routing info (not inferred from body text)' },
    4: { name: 'NAF Collision',    def: 'PDF present but email is requesting account setup rather than order processing' },
    5: { name: 'Noise Check',      def: 'Order acknowledgment request or automated system notification requiring no new processing' }
};

// ── Component ───────────────────────────────────────────────────────────────

export default class CaseTriageReview extends LightningElement {
    @api recordId;
    /** Admin-configurable font size: Small | Medium | Large */
    @api fontSize = 'Small';

    @track showOverrideForm = false;
    @track isLoading        = false;
    @track isExpanded       = false;

    @track overrideClassificationValue;
    @track overrideTypeValue;
    @track overrideSubTypeValue;
    @track overrideReasonValue;
    @track overrideNotesValue;

    _wiredRecord;

    @wire(getRecord, { recordId: '$recordId', fields: FIELDS })
    wiredCase(result) { this._wiredRecord = result; }

    // ── Raw field getters ──────────────────────────────────────────────────

    get triageStatus()       { return getFieldValue(this._wiredRecord?.data, TRIAGE_STATUS); }
    get classification()     { return getFieldValue(this._wiredRecord?.data, CLASSIFICATION_RESULT); }
    get confidence()         { return getFieldValue(this._wiredRecord?.data, CLASSIFICATION_CONFIDENCE); }
    get signalsUsed()        { return getFieldValue(this._wiredRecord?.data, CLASSIFICATION_SIGNALS); }
    get rationale()          { return getFieldValue(this._wiredRecord?.data, CLASSIFICATION_RATIONALE); }
    get outcome()            { return getFieldValue(this._wiredRecord?.data, CLASSIFICATION_OUTCOME); }
    get recommendedType()    { return getFieldValue(this._wiredRecord?.data, TYPE_FIELD); }
    get recommendedSubType() { return getFieldValue(this._wiredRecord?.data, SUB_TYPE_FIELD); }

    get triageReviewedAt() {
        const val = getFieldValue(this._wiredRecord?.data, TRIAGE_REVIEWED_AT);
        if (!val) return '';
        try {
            return new Intl.DateTimeFormat('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: 'numeric', minute: '2-digit'
            }).format(new Date(val));
        } catch { return val; }
    }

    // ── Visibility ─────────────────────────────────────────────────────────

    get showPending()    { return this.triageStatus === 'Pending'; }
    get showReviewed()   { return this.triageStatus === 'Confirmed' || this.triageStatus === 'Overridden'; }
    get hasSignalData()  { return !!this.signalsUsed; }

    // ── Accordion ──────────────────────────────────────────────────────────

    get accordionToggleLabel() { return this.isExpanded ? 'Hide details' : 'View details'; }
    get accordionIcon()        { return this.isExpanded ? 'utility:chevronup' : 'utility:chevrondown'; }

    handleToggleExpanded() { this.isExpanded = !this.isExpanded; }

    // ── Signal parsing — always returns all 5 in order ────────────────────
    //
    // The LLM emits signalsUsed in many different formats depending on the run.
    // Rather than matching one specific format, we:
    //   1. Find every "Signal N" anchor in the raw string
    //   2. Slice the text for each signal entry
    //   3. Run a priority-ordered set of extractions to pull result + description
    //
    get allSignals() {
        const raw = this.signalsUsed;
        const parsedMap = {};

        if (raw) {
            // Step 1: collect the start position of every "Signal N" anchor (1-5 only, first occurrence wins)
            const positions = [];
            const seen = new Set();
            const finder = /\bSignal\s+(\d)\b/gi;
            let m;
            while ((m = finder.exec(raw)) !== null) {
                const num = parseInt(m[1], 10);
                if (num >= 1 && num <= 5 && !seen.has(num)) {
                    seen.add(num);
                    positions.push({ num, start: m.index });
                }
            }

            // Step 2: extract and parse each segment
            positions.forEach((pos, i) => {
                const end  = i + 1 < positions.length ? positions[i + 1].start : raw.length;
                const text = raw.substring(pos.start, end).trim().replace(/[,.\s]+$/, '');
                const parsed = this._parseSignalEntry(text);
                if (parsed.description) {
                    parsedMap[pos.num] = { ...parsed, resultClass: this._resultClass(parsed.result) };
                }
            });
        }

        const fs = this._fs;
        return [1, 2, 3, 4, 5].map(num => {
            const def   = SIGNAL_DEFS[num];
            const found = parsedMap[num];
            return {
                id:          String(num),
                label:       `Signal ${num}`,
                name:        def.name,
                signalDef:   def.def,
                result:      found ? this._normalizeResult(found.result) : 'Not triggered',
                resultClass: found ? found.resultClass : 'result-not-triggered',
                description: found ? found.description : null,
                missing:     !found,
                itemClass:   `signal-item font-${fs}${!found ? ' signal-missing' : ''}`
            };
        });
    }

    /**
     * Extract { result, description } from a single signal entry string.
     * Handles every observed LLM output variant:
     *   "Signal N: Result - description."
     *   "Signal N (Name): Result - description."
     *   "Signal N (result - description)"
     *   "Signal N (Name) is result - description."
     *   "Signal N - Name: description."
     *   "Signal N: description only" (no explicit result word)
     */
    _parseSignalEntry(text) {
        // Remove "Signal N" prefix
        let s = text.replace(/^Signal\s+\d\s*/i, '').trim();

        // Check for compact paren format: "(result - description)" with no trailing content
        // e.g. "Signal 1 (neutral - recipient address...)"
        const compactParen = s.match(/^\(\s*([^)]+)\)\s*$/si);
        if (compactParen) {
            const inner = compactParen[1];
            const dashIdx = inner.indexOf(' - ');
            if (dashIdx !== -1) {
                return {
                    result:      inner.substring(0, dashIdx).trim(),
                    description: inner.substring(dashIdx + 3).trim()
                };
            }
        }

        // Remove optional parenthesised signal name: "(Routing Mailbox)" or "(Routing Mailbox):"
        s = s.replace(/^\([^)]+\)[:\s]*/i, '').trim();

        // Remove "is " connector (e.g. "Signal N (Name) is result - desc")
        s = s.replace(/^is\s+/i, '').trim();

        // Remove leading punctuation: ":", "-", "—"
        s = s.replace(/^[:\-–—\s]+/, '').trim();

        // Known result words (all lowercase for matching)
        const KNOWN = /^(positive|negative|neutral|confirmed|detected|triggered|not\s+triggered|not\s+detected|not\s+noise|noise|naf\s+collision(?:\s+detected)?|ambiguous)\s*[-–—|]\s*/i;
        const knownMatch = s.match(KNOWN);
        if (knownMatch) {
            return {
                result:      knownMatch[1].trim(),
                description: s.substring(knownMatch[0].length).trim().replace(/\.+$/, '')
            };
        }

        // "- SignalName: description" format (e.g. "- Noise Detection: Email is a follow-up...")
        const dashNameColon = s.match(/^-?\s*([A-Za-z][A-Za-z\s]{0,30}):\s*(.+)$/si);
        if (dashNameColon) {
            return {
                result:      'Detected',
                description: dashNameColon[2].trim().replace(/\.+$/, '')
            };
        }

        // Fallback: treat the whole remaining text as the description
        const desc = s.replace(/\.+$/, '').trim();
        if (desc.length > 0) {
            return { result: 'Triggered', description: desc };
        }

        return { result: null, description: null };
    }

    _resultClass(result) {
        return result ? (RESULT_CLASSES[result.toLowerCase()] || 'result-neutral') : 'result-not-triggered';
    }

    /** Normalize result label to consistent Title Case for display */
    _normalizeResult(result) {
        if (!result) return 'Not triggered';
        // Map legacy/variant terms to the canonical display label
        const canon = {
            confirmed:              'Positive',
            detected:               'Detected',
            triggered:              'Triggered',
            positive:               'Positive',
            negative:               'Negative',
            neutral:                'Neutral',
            ambiguous:              'Ambiguous',
            noise:                  'Noise',
            'not noise':            'Not noise',
            'not triggered':        'Not triggered',
            'not detected':         'Not triggered',
            'naf collision':        'NAF Collision',
            'naf collision detected': 'NAF Collision',
        };
        return canon[result.toLowerCase()] || result.charAt(0).toUpperCase() + result.slice(1).toLowerCase();
    }

    // ── Font size ──────────────────────────────────────────────────────────

    get _fs() { return (this.fontSize || 'Small').toLowerCase(); }

    get detailTextClass()   { return `detail-text font-${this._fs}`; }
    get sectionLabelClass() { return `section-label font-label-${this._fs}`; }
    get signalItemClass()   { return `signal-item font-${this._fs}`; }
    get outcomeTextClass()  { return `outcome-text font-${this._fs}`; }

    // ── Labels ─────────────────────────────────────────────────────────────

    get classificationLabel() { return CLASSIFICATION_LABELS[this.classification] || this.classification; }
    get confirmButtonLabel()  { return CONFIRM_BUTTON_LABELS[this.classification] || 'Confirm'; }
    get outcomeLabel()        { return OUTCOME_LABELS[this.outcome] || this.outcome; }

    // ── Badge classes ──────────────────────────────────────────────────────

    get classificationBadgeClass() {
        const map = {
            Sales_Order: 'badge-blue', Noise: 'badge-gray',
            Ambiguous: 'badge-orange', General: 'badge-teal'
        };
        return `badge-pill ${map[this.classification] || 'badge-gray'}`;
    }

    get confidenceBadgeClass() {
        const map = { High: 'badge-green', Medium: 'badge-yellow', Low: 'badge-red' };
        return `badge-pill ${map[this.confidence] || 'badge-gray'}`;
    }

    // ── Picklist options ───────────────────────────────────────────────────

    get classificationOptions() {
        return [
            { label: 'Sales Order', value: 'Sales_Order' },
            { label: 'General',     value: 'General'     },
            { label: 'Ambiguous',   value: 'Ambiguous'   },
            { label: 'Noise',       value: 'Noise'       }
        ];
    }

    get typeOptions() {
        return [
            { label: 'Account Support', value: 'Account Support' },
            { label: 'General',         value: 'General'         },
            { label: 'Product Support', value: 'Product Support' },
            { label: 'Technical Issue', value: 'Technical Issue' }
        ];
    }

    get subTypeOptions() {
        return [
            { label: 'Order or Invoice', value: 'Order or Invoice' },
            { label: 'Setup and Usage',  value: 'Setup and Usage'  },
            { label: 'Troubleshooting',  value: 'Troubleshooting'  },
            { label: 'Suggestion',       value: 'Suggestion'       },
            { label: 'Complaint',        value: 'Complaint'        },
            { label: 'Profile',          value: 'Profile'          },
            { label: 'Billing',          value: 'Billing'          },
            { label: 'Other',            value: 'Other'            }
        ];
    }

    get overrideReasonOptions() {
        return [
            { label: 'Email intent misread',              value: 'Email intent misread'              },
            { label: 'Attachment not detected by AI',     value: 'Attachment not detected by AI'     },
            { label: 'Known procurement system / sender', value: 'Known procurement system / sender' },
            { label: 'Duplicate — PO already received',   value: 'Duplicate — PO already received'   },
            { label: 'Not an order — sent in error',      value: 'Not an order — sent in error'      },
            { label: 'NAF misclassified as order',        value: 'NAF misclassified as order'        },
            { label: 'Other',                             value: 'Other'                             }
        ];
    }

    get overrideReasonMissing() { return !this.overrideReasonValue; }

    // ── Handlers ───────────────────────────────────────────────────────────

    handleConfirm() {
        this.isLoading = true;
        confirmClassification({ caseId: this.recordId })
            .then(() => {
                this._toast('Classification confirmed', 'Case has been routed.', 'success');
                getRecordNotifyChange([{ recordId: this.recordId }]);
            })
            .catch(err => this._toast('Error', err?.body?.message || 'An error occurred.', 'error'))
            .finally(() => { this.isLoading = false; });
    }

    handleOverride() {
        this.overrideClassificationValue = this.classification;
        this.overrideTypeValue           = this.recommendedType;
        this.overrideSubTypeValue        = this.recommendedSubType;
        this.overrideReasonValue         = null;
        this.overrideNotesValue          = null;
        this.showOverrideForm            = true;
    }

    handleCancelOverride() { this.showOverrideForm = false; }

    handleOverrideReasonChange(e)         { this.overrideReasonValue         = e.detail.value; }
    handleOverrideClassificationChange(e) { this.overrideClassificationValue = e.detail.value; }
    handleOverrideTypeChange(e)           { this.overrideTypeValue           = e.detail.value; }
    handleOverrideSubTypeChange(e)        { this.overrideSubTypeValue        = e.detail.value; }
    handleOverrideNotesChange(e)          { this.overrideNotesValue          = e.detail.value; }

    handleApplyOverride() {
        this.isLoading = true;
        overrideClassification({
            caseId:            this.recordId,
            newClassification: this.overrideClassificationValue,
            newType:           this.overrideTypeValue,
            newSubType:        this.overrideSubTypeValue,
            overrideReason:    this.overrideReasonValue,
            overrideNotes:     this.overrideNotesValue
        })
            .then(() => {
                this.showOverrideForm = false;
                this._toast('Override applied', 'Classification updated and logged.', 'success');
                getRecordNotifyChange([{ recordId: this.recordId }]);
            })
            .catch(err => this._toast('Error', err?.body?.message || 'An error occurred.', 'error'))
            .finally(() => { this.isLoading = false; });
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
