package sh.ovis.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OvisAuthReturnTest {
    private static final String STATE = "s7Hq-2xK_9pL";

    @Test
    public void aSuccessInTheFragmentEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void aDenialInTheFragmentEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#error=access_denied&state=" + STATE, STATE));
    }

    @Test
    public void aSuccessInTheQueryFromAnOlderServiceEndsTheWait() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback?code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void anotherSignInsStateIsLeftWaiting() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=other", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback?error=access_denied&state=other", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=other?state=" + STATE, STATE));
    }

    @Test
    public void anotherAddressIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/elsewhere#code=c0de&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://other/callback#code=c0de&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("https://account/callback#code=c0de&state=" + STATE, STATE));
    }

    @Test
    public void theFragmentIsReadBeforeTheQuery() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback?code=c0de&state=other#code=c0de&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback?code=c0de&state=" + STATE + "#code=c0de&state=other", STATE));
    }

    @Test
    public void anEmptyFragmentFallsBackToTheQuery() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback?code=c0de&state=" + STATE + "#", STATE));
    }

    @Test
    public void anAddressWithNoFieldsIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback?", STATE));
    }

    @Test
    public void theFirstStateNamedWins() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#state=" + STATE + "&state=other&code=c0de", STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#state=other&state=" + STATE + "&code=c0de", STATE));
    }

    @Test
    public void namesAndValuesArePercentDecoded() {
        assertTrue(OvisAuthPlugin.isOwnReturn("ovis://account/callback#co%64e=c0de&state=s%2Bq%3D", "s+q="));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=s%2Bq%3D", "s%2Bq%3D"));
    }

    @Test
    public void aMalformedEscapeIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=a%zzb&state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=" + STATE + "%", STATE));
    }

    @Test
    public void aReturnWithNeitherCodeNorErrorIsIgnored() {
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#state=" + STATE, STATE));
        assertFalse(OvisAuthPlugin.isOwnReturn("ovis://account/callback#code=c0de&state=" + STATE, null));
    }
}
