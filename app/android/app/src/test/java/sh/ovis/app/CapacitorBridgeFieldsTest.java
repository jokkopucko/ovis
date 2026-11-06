package sh.ovis.app;

import static org.junit.Assert.assertNotNull;

import org.junit.Test;

/**
 * OvisDirectPlugin decides that only the main frame can call it by reading two private fields of the bundled
 * Capacitor by reflection, and refuses every call when it cannot. A Capacitor upgrade that renames them would
 * turn direct connections off without a word; this fails instead.
 */
public class CapacitorBridgeFieldsTest {
    @Test
    public void theBridgeFieldsTheFrameCheckReadsExist() throws Exception {
        assertNotNull(com.getcapacitor.Bridge.class.getDeclaredField("msgHandler"));
        assertNotNull(com.getcapacitor.MessageHandler.class.getDeclaredField("javaScriptReplyProxy"));
    }
}
