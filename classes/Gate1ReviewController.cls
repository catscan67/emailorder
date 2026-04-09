/**
 * Gate1ReviewController
 *
 * Apex controller for the gate1OrderReview LWC.
 * Confirms or saves rep-edited shipping details extracted during Gate 1.
 */
public with sharing class Gate1ReviewController {

    @AuraEnabled
    public static void confirmOrderDetails(Id caseId) {
        update new Case(
            Id               = caseId,
            Gate1_Status__c  = 'Completed'
        );
    }

    @AuraEnabled
    public static void saveOrderDetails(
        Id     caseId,
        String shippingPreference,
        String attentionTo,
        String shipToAddress
    ) {
        update new Case(
            Id                     = caseId,
            Shipping_Preference__c = shippingPreference,
            Attention_To__c        = attentionTo,
            Ship_To_Address__c     = shipToAddress,
            Gate1_Status__c        = 'Completed'
        );
    }
}
