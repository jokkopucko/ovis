/**
 * The notice's wording as a number: an install that saw an older one sees the notice again, and
 * sends nothing until it has (3: events now carry an allowlisted settings snapshot; 4: a daily
 * active message with the harness kinds; 5: that message also counts the day's usage, TelemetryUsage;
 * 6: a finished day's button counts, TelemetryCounts, which this version turns on: COUNTS_ON).
 */
export const NOTICE_VERSION = 6;

/**
 * The notice that says the app's buttons are counted (TelemetryCounts). Below it nothing counts them,
 * in the browser or on the server, and nothing sends them: raising NOTICE_VERSION to it, with its
 * wording, is what turns the counts on, so the words and the sending ship in one change.
 */
export const COUNTS_NOTICE_VERSION = 6;

/** whether this build counts the app's buttons: only once its notice says so */
export const COUNTS_ON: boolean = NOTICE_VERSION >= COUNTS_NOTICE_VERSION;
