package sh.ovis.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OpeningWatchTest {
    private static final long LIMIT = 20000;

    @Test
    public void givesUpOnlyWhenNothingArrivedWithinTheLimit() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 5000);
        watch.received(10000, 5000);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(19999));
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(20000));
        assertFalse(watch.connectedOnly());
    }

    @Test
    public void tcpPacketsAloneAreNoAnswer() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 5000);
        watch.received(300, 5000 + 120);
        watch.received(15000, 5000 + 300);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(20000));
    }

    @Test
    public void aSlowLinkThatKeepsSendingIsNeverCutOff() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(1000));
        watch.answered(1300);
        assertEquals(OpeningWatch.Stage.OPENING, watch.stage(4999));
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(5000));
        for (long at = 5000; at <= 300000; at += 1000) {
            watch.received(at, at * 10);
            assertEquals(OpeningWatch.Stage.SLOW, watch.stage(at + 999));
        }
        assertEquals(3000000, watch.bytesSoFar());
    }

    @Test
    public void bytesStillComingBeforeTheAnswerPutTheLimitOff() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 100);
        for (long at = 2000; at <= 30000; at += 2000) watch.received(at, 100 + at);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(30000 + OpeningWatch.QUIET_MS - 1));
        watch.answered(31000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(31000 + OpeningWatch.STALL_MS - 1));
    }

    @Test
    public void aHandshakeWithNoResponseAfterItStillGivesUp() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 100);
        watch.received(1000, 100 + 4000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(LIMIT - 1));
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(LIMIT));
        assertTrue(watch.connectedOnly());
    }

    @Test
    public void bytesWithoutAnAnswerNeverWaitPastTheCap() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        for (long at = 1000; at < OpeningWatch.UNANSWERED_MAX_MS; at += 1000) watch.received(at, at * 2);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(OpeningWatch.UNANSWERED_MAX_MS - 1));
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(OpeningWatch.UNANSWERED_MAX_MS));
    }

    @Test
    public void saysStalledAfterNothingMoreArrivedAndKeepWaitingCountsAgain() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        watch.answered(2000);
        watch.received(6000, 50000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(6000 + OpeningWatch.STALL_MS - 1));
        assertEquals(OpeningWatch.Stage.STALLED, watch.stage(6000 + OpeningWatch.STALL_MS));
        watch.keepWaiting(30000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(30000 + OpeningWatch.STALL_MS - 1));
        watch.received(40000, 60000);
        assertEquals(OpeningWatch.Stage.SLOW, watch.stage(40000 + OpeningWatch.STALL_MS - 1));
    }

    @Test
    public void withoutAByteCountTheAnswerAloneDecides() {
        // TrafficStats.UNSUPPORTED (-1): no bytes are ever counted
        OpeningWatch watch = new OpeningWatch(0, LIMIT, -1);
        watch.received(3000, -1);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(LIMIT));

        OpeningWatch answered = new OpeningWatch(0, LIMIT, -1);
        answered.answered(3000);
        assertEquals(OpeningWatch.Stage.SLOW, answered.stage(LIMIT));
        assertEquals(0, answered.bytesSoFar());
    }

    @Test
    public void theBarFollowsTheBytesAndNeverGoesBackOrFills() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 1000);
        watch.answered(500);
        long total = 100000;
        assertEquals(0, watch.permille(total));
        watch.received(1000, 1000 + 25000);
        assertEquals(250, watch.permille(total));
        assertEquals(250, watch.permille(total * 2));
        watch.received(2000, 1000 + 99000);
        assertEquals(OpeningWatch.MAX_PERMILLE, watch.permille(total));
        watch.received(3000, 1000 + 130000);
        assertEquals(OpeningWatch.MAX_PERMILLE, watch.permille(total));
    }

    @Test
    public void theBarIsUnknownWithoutSizesOrAByteCount() {
        OpeningWatch watch = new OpeningWatch(0, LIMIT, 0);
        watch.received(1000, 50000);
        assertEquals(-1, watch.permille(0));
        assertEquals(-1, watch.permille(-1));
        OpeningWatch uncounted = new OpeningWatch(0, LIMIT, -1);
        uncounted.answered(1000);
        assertEquals(-1, uncounted.permille(100000));
    }

    @Test
    public void aShorterLimitFromTheConnectScreenHolds() {
        OpeningWatch watch = new OpeningWatch(0, PCStore.PAGE_FLOOR_MS, 0);
        assertEquals(OpeningWatch.Stage.NO_ANSWER, watch.stage(PCStore.PAGE_FLOOR_MS));
    }
}
