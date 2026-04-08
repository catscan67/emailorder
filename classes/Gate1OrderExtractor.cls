/**
 * Gate1OrderExtractor
 *
 * Called by the Gate 1 record-triggered flow when OCR_Complete__c becomes true
 * on a Sales Order case. The @InvocableMethod is callout=false so it can be
 * used in a synchronous after-save flow. It schedules a @future job that makes
 * the actual AI callout, invokes the Review_Sales_Order_Details prompt, then
 * parses the JSON response and writes Shipping_Preference__c, Attention_To__c,
 * Gate1_Status__c, and Gate1_Notes__c back to the Case.
 */
public with sharing class Gate1OrderExtractor {

    public class Request {
        @InvocableVariable(required=true label='Case ID')
        public String caseId;

        @InvocableVariable(required=false label='PDF ContentDocument ID (optional)')
        public String pdfContentDocumentId;
    }

    @InvocableMethod(
        label='Run Gate 1 Order Detail Extraction'
        description='Schedules an async job to invoke the Review_Sales_Order_Details prompt and write shipping fields to the Case.'
        callout=false
    )
    public static void runExtraction(List<Request> requests) {
        for (Request req : requests) {
            String pdfId = String.isNotBlank(req.pdfContentDocumentId) ? req.pdfContentDocumentId : '';
            runAsync(req.caseId, pdfId);
        }
    }

    /**
     * Runs after the current transaction commits. Makes the AI callout,
     * parses the response, and updates Case fields.
     */
    @future(callout=true)
    public static void runAsync(String caseId, String pdfContentDocumentId) {
        Case c = new Case(Id = caseId);

        try {
            Case caseRecord = [SELECT Id, Subject, Description FROM Case WHERE Id = :caseId LIMIT 1];

            Invocable.Action promptAction = Invocable.Action.createCustomAction(
                'generatePromptResponse',
                'Review_Sales_Order_Details'
            );
            promptAction.setInvocationParameter('Input:Case', caseRecord);

            if (String.isNotBlank(pdfContentDocumentId)) {
                ContentDocument pdf = [SELECT Id, Title, FileType FROM ContentDocument WHERE Id = :pdfContentDocumentId LIMIT 1];
                promptAction.setInvocationParameter('Input:File', pdf);
            }

            List<Invocable.Action.Result> results = promptAction.invoke();

            if (results == null || results.isEmpty() || !results[0].isSuccess()) {
                String errMsg = (results != null && !results.isEmpty())
                    ? String.join(results[0].getErrors(), '; ')
                    : 'No result returned';
                c.Gate1_Status__c = 'Pending Review';
                c.Gate1_Notes__c  = 'Prompt error: ' + errMsg;
                update c;
                return;
            }

            Map<String, Object> outputParams = results[0].getOutputParameters();
            String rawJson = null;

            // Try the plain-text output first, then fall back to serializing the structured response
            Object promptResult = outputParams.get('promptResult');
            if (promptResult instanceof String) {
                rawJson = (String) promptResult;
            } else {
                Object structured = outputParams.get('structuredResponse');
                if (structured != null) rawJson = JSON.serialize(structured);
            }

            if (String.isBlank(rawJson)) {
                c.Gate1_Status__c = 'Pending Review';
                c.Gate1_Notes__c  = 'Could not read prompt output. Outputs: ' + JSON.serialize(outputParams.keySet());
                update c;
                return;
            }

            // Parse the JSON and populate fields
            Map<String, Object> payload = (Map<String, Object>) JSON.deserializeUntyped(rawJson);

            String shippingPref = String.valueOf(payload.get('shippingPreference'));
            if (String.isNotBlank(shippingPref) && shippingPref != 'null') {
                c.Shipping_Preference__c = shippingPref;
            }

            String attentionTo = String.valueOf(payload.get('attentionTo'));
            if (String.isNotBlank(attentionTo) && attentionTo != 'null') {
                c.Attention_To__c = attentionTo;
            }

            Object summaryObj = payload.get('summary');
            if (summaryObj instanceof Map<String, Object>) {
                Map<String, Object> summary = (Map<String, Object>) summaryObj;
                String confidence = String.valueOf(summary.get('extractionConfidence'));
                String notes      = String.valueOf(summary.get('notes'));
                String noteText   = '';
                if (String.isNotBlank(confidence) && confidence != 'null') noteText += 'Confidence: ' + confidence + '. ';
                if (String.isNotBlank(notes)      && notes      != 'null') noteText += notes;
                if (String.isNotBlank(noteText)) c.Gate1_Notes__c = noteText.trim();
            }

            c.Gate1_Status__c = 'Pending Review';

        } catch (Exception e) {
            c.Gate1_Status__c = 'Pending Review';
            c.Gate1_Notes__c  = 'Extraction error: ' + e.getMessage();
        }

        update c;
    }
}
