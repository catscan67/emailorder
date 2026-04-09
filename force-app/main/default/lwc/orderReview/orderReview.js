import { LightningElement, api, wire, track } from 'lwc';
import { getRecord, getFieldValue, getRecordNotifyChange } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

import confirmOrderDetails from '@salesforce/apex/Gate1ReviewController.confirmOrderDetails';
import saveOrderDetails    from '@salesforce/apex/Gate1ReviewController.saveOrderDetails';

import GATE1_STATUS         from '@salesforce/schema/Case.Gate1_Status__c';
import GATE1_NOTES          from '@salesforce/schema/Case.Gate1_Notes__c';
import SHIPPING_PREFERENCE  from '@salesforce/schema/Case.Shipping_Preference__c';
import ATTENTION_TO         from '@salesforce/schema/Case.Attention_To__c';
import SHIP_TO_ADDRESS      from '@salesforce/schema/Case.Ship_To_Address__c';

const FIELDS = [
    GATE1_STATUS, GATE1_NOTES, SHIPPING_PREFERENCE, ATTENTION_TO, SHIP_TO_ADDRESS
];

export default class OrderReview extends LightningElement {
    @api recordId;
    /** Admin-configurable font size: Small | Medium | Large */
    @api fontSize = 'Small';

    @track showEditForm  = false;
    @track isLoading     = false;
    @track isExpanded    = false;
    @track isDismissed   = false;

    @track editShippingPreference;
    @track editAttentionTo;
    @track editShipToAddress;

    _wiredRecord;

    @wire(getRecord, { recordId: '$recordId', fields: FIELDS })
    wiredCase(result) { this._wiredRecord = result; }

    // ── Raw field getters ──────────────────────────────────────────────────

    get gate1Status()       { return getFieldValue(this._wiredRecord?.data, GATE1_STATUS); }
    get gate1Notes()        { return getFieldValue(this._wiredRecord?.data, GATE1_NOTES); }
    get shippingPreference(){ return getFieldValue(this._wiredRecord?.data, SHIPPING_PREFERENCE) || '—'; }
    get attentionTo()       { return getFieldValue(this._wiredRecord?.data, ATTENTION_TO); }
    get shipToAddress()     { return getFieldValue(this._wiredRecord?.data, SHIP_TO_ADDRESS); }

    // ── View state ─────────────────────────────────────────────────────────

    get showPending()      { return this.gate1Status === 'Pending Review'; }
    get showManualReview() { return this.gate1Status === 'Manual Review Required'; }
    get showCompleted()    { return this.gate1Status === 'Completed'; }
    get showReadOnly()     { return !this.showEditForm; }

    // Disable Save on manual review until a shipping preference is chosen
    get saveDisabled()     { return !this.editShippingPreference; }

    // ── Accordion ──────────────────────────────────────────────────────────

    get accordionToggleLabel() { return this.isExpanded ? 'Hide details' : 'View details'; }
    get accordionIcon()        { return this.isExpanded ? 'utility:chevronup' : 'utility:chevrondown'; }

    handleToggleExpanded() { this.isExpanded = !this.isExpanded; }

    // ── Styling helpers ────────────────────────────────────────────────────

    get _fs() { return (this.fontSize || 'Small').toLowerCase(); }

    get detailTextClass()   { return `detail-text font-${this._fs}`; }
    get sectionLabelClass() { return `section-label font-label-${this._fs}`; }

    get shippingBadgeClass() {
        const pref = getFieldValue(this._wiredRecord?.data, SHIPPING_PREFERENCE);
        return `badge-pill ${pref === 'Expedited' ? 'badge-orange' : 'badge-blue'}`;
    }

    // ── Picklist options ───────────────────────────────────────────────────

    get shippingOptions() {
        return [
            { label: 'Standard',  value: 'Standard'  },
            { label: 'Expedited', value: 'Expedited' }
        ];
    }

    // ── Edit mode ──────────────────────────────────────────────────────────

    handleEdit() {
        // Seed edit fields from current record values
        this.editShippingPreference = getFieldValue(this._wiredRecord?.data, SHIPPING_PREFERENCE) || 'Standard';
        this.editAttentionTo        = this.attentionTo  || '';
        this.editShipToAddress      = this.shipToAddress || '';
        this.showEditForm           = true;
    }

    handleCancelEdit() { this.showEditForm = false; }

    handleDismiss() { this.isDismissed = true;  this.showEditForm = false; }
    handleReopen()  { this.isDismissed = false; }

    handleShippingChange(e)    { this.editShippingPreference = e.detail.value; }
    handleAttentionToChange(e) { this.editAttentionTo        = e.detail.value; }
    handleShipToAddressChange(e) { this.editShipToAddress    = e.detail.value; }

    // On Manual Review Required, seed the edit fields for the rep on component load
    connectedCallback() {
        // Pre-seed edit fields so the form is ready for manual review state
        this._seedEditFields();
    }

    _seedEditFields() {
        this.editShippingPreference = null;
        this.editAttentionTo        = '';
        this.editShipToAddress      = '';
    }

    // ── Actions ────────────────────────────────────────────────────────────

    handleConfirm() {
        this.isLoading = true;
        confirmOrderDetails({ caseId: this.recordId })
            .then(() => {
                this._toast('Order details confirmed', 'Gate 1 is complete.', 'success');
                getRecordNotifyChange([{ recordId: this.recordId }]);
            })
            .catch(err => this._toast('Error', err?.body?.message || 'An error occurred.', 'error'))
            .finally(() => { this.isLoading = false; });
    }

    handleSave() {
        this.isLoading = true;
        saveOrderDetails({
            caseId:             this.recordId,
            shippingPreference: this.editShippingPreference,
            attentionTo:        this.editAttentionTo,
            shipToAddress:      this.editShipToAddress
        })
            .then(() => {
                this.showEditForm = false;
                this._toast('Order details saved', 'Gate 1 is complete.', 'success');
                getRecordNotifyChange([{ recordId: this.recordId }]);
            })
            .catch(err => this._toast('Error', err?.body?.message || 'An error occurred.', 'error'))
            .finally(() => { this.isLoading = false; });
    }

    _toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
