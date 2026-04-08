public with sharing class CaseTriageController {

    /**
     * Confirm the AI's classification as-is and apply the appropriate routing action.
     * Sales_Order RT  → change RecordType + route to Order_Process_Queue
     * Noise          → close the case
     * Ambiguous      → route to Human_Triage_Queue (rep handles further disposition)
     * General        → no routing change
     */
    @AuraEnabled(cacheable=false)
    public static void confirmClassification(String caseId) {
        Case c = [
            SELECT Id, Classification_Result__c
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];
        applyRouting(c, c.Classification_Result__c, false);
        update c;
    }

    /**
     * Override the AI's classification with rep-specified values, apply routing,
     * and log the before/after values + reason as an internal Case Comment.
     */
    @AuraEnabled(cacheable=false)
    public static void overrideClassification(
        String caseId,
        String newClassification,
        String newType,
        String newSubType,
        String overrideReason,
        String overrideNotes
    ) {
        Case c = [
            SELECT Id, Classification_Result__c, Type, SDO_Sub_Type__c
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];

        String originalClassification = c.Classification_Result__c;
        String originalType           = c.Type;
        String originalSubType        = c.SDO_Sub_Type__c;

        c.Classification_Result__c = newClassification;
        c.Type                     = newType;
        c.SDO_Sub_Type__c          = newSubType;
        c.Override_Reason__c       = overrideReason;
        c.Override_Notes__c        = overrideNotes;
        applyRouting(c, newClassification, true);
        update c;

        // Internal case comment — full before/after audit trail
        String reasonText = String.isBlank(overrideReason) ? '(not specified)' : overrideReason;
        String commentBody =
            '[Gate 0 Override] Rep manually overrode the AI classification.\n' +
            'Reason: '         + reasonText + '\n' +
            'Classification: ' + nullSafe(originalClassification) + ' → ' + newClassification + '\n' +
            'Type: '           + nullSafe(originalType)           + ' → ' + newType           + '\n' +
            'Subtype: '        + nullSafe(originalSubType)        + ' → ' + newSubType;

        if (!String.isBlank(overrideNotes)) {
            commentBody += '\nNotes: ' + overrideNotes;
        }

        insert new CaseComment(
            ParentId    = caseId,
            CommentBody = commentBody,
            IsPublished = false
        );
    }

    private static void applyRouting(Case c, String classification, Boolean isOverride) {
        c.Triage_Status__c          = isOverride ? 'Overridden' : 'Confirmed';
        c.Classification_Outcome__c = isOverride ? 'Override_Applied' : 'Correct_First_Touch';
        c.Triage_Reviewed_At__c     = System.now();

        if (classification == 'Sales_Order') {
            List<RecordType> rts = [
                SELECT Id FROM RecordType
                WHERE SobjectType = 'Case' AND DeveloperName = 'Sales_Order'
                LIMIT 1
            ];
            List<Group> queues = [
                SELECT Id FROM Group
                WHERE Type = 'Queue' AND DeveloperName = 'Order_Process_Queue'
                LIMIT 1
            ];
            if (!rts.isEmpty())    c.RecordTypeId = rts[0].Id;
            if (!queues.isEmpty()) c.OwnerId      = queues[0].Id;

        } else if (classification == 'Noise') {
            c.Status = 'Closed';

        } else if (classification == 'Ambiguous') {
            List<Group> queues = [
                SELECT Id FROM Group
                WHERE Type = 'Queue' AND DeveloperName = 'Human_Triage_Queue'
                LIMIT 1
            ];
            if (!queues.isEmpty()) c.OwnerId = queues[0].Id;
        }
        // General: no routing change
    }

    private static String nullSafe(String val) {
        return String.isBlank(val) ? '(empty)' : val;
    }
}
