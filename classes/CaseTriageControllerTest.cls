@IsTest
public class CaseTriageControllerTest {

    @TestSetup
    static void setup() {
        Group humanTriageQueue = new Group(
            Name = 'Human_Triage_Queue',
            DeveloperName = 'Human_Triage_Queue',
            Type = 'Queue'
        );
        insert humanTriageQueue;
        insert new QueueSobject(QueueId = humanTriageQueue.Id, SobjectType = 'Case');
    }

    @IsTest
    static void testConfirmNoise() {
        Case c = new Case(
            Subject = 'Test Noise',
            Origin = 'Email',
            Classification_Result__c = 'Noise',
            Triage_Status__c = 'Pending'
        );
        insert c;

        Test.startTest();
        CaseTriageController.confirmClassification(c.Id);
        Test.stopTest();

        Case result = [SELECT Status, Triage_Status__c, Classification_Outcome__c FROM Case WHERE Id = :c.Id];
        System.assertEquals('Closed', result.Status, 'Noise case should be closed');
        System.assertEquals('Confirmed', result.Triage_Status__c);
        System.assertEquals('Correct_First_Touch', result.Classification_Outcome__c);
    }

    @IsTest
    static void testConfirmGeneral() {
        Case c = new Case(
            Subject = 'Test General',
            Origin = 'Email',
            Classification_Result__c = 'General',
            Triage_Status__c = 'Pending'
        );
        insert c;

        Test.startTest();
        CaseTriageController.confirmClassification(c.Id);
        Test.stopTest();

        Case result = [SELECT Triage_Status__c, Classification_Outcome__c FROM Case WHERE Id = :c.Id];
        System.assertEquals('Confirmed', result.Triage_Status__c);
        System.assertEquals('Correct_First_Touch', result.Classification_Outcome__c);
    }

    @IsTest
    static void testConfirmAmbiguous() {
        Case c = new Case(
            Subject = 'Test Ambiguous',
            Origin = 'Email',
            Classification_Result__c = 'Ambiguous',
            Triage_Status__c = 'Pending'
        );
        insert c;

        Test.startTest();
        CaseTriageController.confirmClassification(c.Id);
        Test.stopTest();

        Case result = [SELECT Triage_Status__c, Classification_Outcome__c FROM Case WHERE Id = :c.Id];
        System.assertEquals('Confirmed', result.Triage_Status__c);
        System.assertEquals('Correct_First_Touch', result.Classification_Outcome__c);
    }

    @IsTest
    static void testOverrideToGeneral() {
        Case c = new Case(
            Subject = 'Test Override',
            Origin = 'Email',
            Classification_Result__c = 'Sales_Order',
            Triage_Status__c = 'Pending'
        );
        insert c;

        Test.startTest();
        CaseTriageController.overrideClassification(c.Id, 'General', 'General', 'Other');
        Test.stopTest();

        Case result = [
            SELECT Classification_Result__c, Type, SDO_Sub_Type__c,
                   Triage_Status__c, Classification_Outcome__c
            FROM Case WHERE Id = :c.Id
        ];
        System.assertEquals('General', result.Classification_Result__c);
        System.assertEquals('General', result.Type);
        System.assertEquals('Other', result.SDO_Sub_Type__c);
        System.assertEquals('Overridden', result.Triage_Status__c);
        System.assertEquals('Override_Applied', result.Classification_Outcome__c);
    }

    @IsTest
    static void testOverrideToNoise() {
        Case c = new Case(
            Subject = 'Test Override to Noise',
            Origin = 'Email',
            Classification_Result__c = 'Ambiguous',
            Triage_Status__c = 'Pending'
        );
        insert c;

        Test.startTest();
        CaseTriageController.overrideClassification(c.Id, 'Noise', 'General', 'Other');
        Test.stopTest();

        Case result = [SELECT Status, Triage_Status__c, Classification_Outcome__c FROM Case WHERE Id = :c.Id];
        System.assertEquals('Closed', result.Status);
        System.assertEquals('Overridden', result.Triage_Status__c);
        System.assertEquals('Override_Applied', result.Classification_Outcome__c);
    }
}
